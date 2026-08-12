import { randomUUID } from "node:crypto";

export type TurnStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface TurnRequest<TPayload> {
  id?: string;
  sessionId: string;
  teamId: string;
  userId: string;
  payload: TPayload;
  createdAt?: number;
}

export interface ScheduledTurn<TPayload, TResult = unknown> {
  id: string;
  sessionId: string;
  teamId: string;
  userId: string;
  payload: TPayload;
  status: TurnStatus;
  createdAt: number;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: TResult;
  error?: unknown;
  cancelReason?: string;
}

export interface TurnExecutionContext<TPayload, TResult = unknown> {
  turn: Readonly<ScheduledTurn<TPayload, TResult>>;
  signal: AbortSignal;
}

export type TurnRunner<TPayload, TResult> = (
  context: TurnExecutionContext<TPayload, TResult>,
) => Promise<TResult>;

export interface SchedulerLimits {
  global: number;
  perTeam: number;
  perUser: number;
}

export type SchedulerEvent<TPayload, TResult> =
  | { type: "queued"; turn: Readonly<ScheduledTurn<TPayload, TResult>> }
  | { type: "started"; turn: Readonly<ScheduledTurn<TPayload, TResult>> }
  | { type: "cancelling"; turn: Readonly<ScheduledTurn<TPayload, TResult>> }
  | { type: "finished"; turn: Readonly<ScheduledTurn<TPayload, TResult>> };

export interface RuntimeSchedulerOptions<TPayload, TResult> {
  limits: SchedulerLimits;
  runner: TurnRunner<TPayload, TResult>;
  now?: () => number;
  idFactory?: () => string;
  onEvent?: (event: SchedulerEvent<TPayload, TResult>) => void | Promise<void>;
}

export class SessionAlreadyActiveError extends Error {
  readonly code = "SESSION_ALREADY_ACTIVE";

  constructor(
    readonly sessionId: string,
    readonly activeTurnId: string,
  ) {
    super(`Session ${sessionId} already has active turn ${activeTurnId}.`);
    this.name = "SessionAlreadyActiveError";
  }
}

export class UnknownTurnError extends Error {
  readonly code = "TURN_NOT_FOUND";

  constructor(readonly turnId: string) {
    super(`Turn ${turnId} was not found.`);
    this.name = "UnknownTurnError";
  }
}

export interface PersistedTurn<TPayload> extends TurnRequest<TPayload> {
  id: string;
  status: TurnStatus;
  queuedAt: number;
  startedAt?: number;
}

export type StartupRecoveryDecision = "requeue" | "interrupt" | "cancel";

export interface StartupRecoveryPolicy<TPayload> {
  decide(turn: Readonly<PersistedTurn<TPayload>>): StartupRecoveryDecision;
}

export interface RecoveryReport<TPayload, TResult> {
  requeued: ReadonlyArray<ScheduledTurn<TPayload, TResult>>;
  terminal: ReadonlyArray<ScheduledTurn<TPayload, TResult>>;
}

/**
 * Safe default for a process-backed runtime: queued work can be resumed, while
 * work that was running has lost its process and is marked interrupted.
 */
export class InterruptRunningRecoveryPolicy<TPayload>
  implements StartupRecoveryPolicy<TPayload>
{
  decide(turn: Readonly<PersistedTurn<TPayload>>): StartupRecoveryDecision {
    return turn.status === "queued" ? "requeue" : "interrupt";
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function isTerminal(status: TurnStatus): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}

/**
 * In-memory admission controller for runtime turns. All state changes before an
 * await are synchronous, so enqueue/cancel calls cannot create duplicate active
 * turns in a single Node.js process. Persist lifecycle events in onEvent when
 * restart durability is required.
 */
export class RuntimeScheduler<TPayload, TResult = unknown> {
  private readonly limits: SchedulerLimits;
  private readonly runner: TurnRunner<TPayload, TResult>;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly onEvent?: RuntimeSchedulerOptions<TPayload, TResult>["onEvent"];
  private readonly turns = new Map<string, ScheduledTurn<TPayload, TResult>>();
  private readonly activeBySession = new Map<string, string>();
  private readonly runningControllers = new Map<string, AbortController>();
  private readonly runningByTeam = new Map<string, number>();
  private readonly runningByUser = new Map<string, number>();
  private queue: string[] = [];
  private runningCount = 0;
  private dispatchScheduled = false;

  constructor(options: RuntimeSchedulerOptions<TPayload, TResult>) {
    assertPositiveInteger("limits.global", options.limits.global);
    assertPositiveInteger("limits.perTeam", options.limits.perTeam);
    assertPositiveInteger("limits.perUser", options.limits.perUser);
    this.limits = { ...options.limits };
    this.runner = options.runner;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.onEvent = options.onEvent;
  }

  enqueue(request: TurnRequest<TPayload>): Readonly<ScheduledTurn<TPayload, TResult>> {
    return this.enqueueInternal(request, request.createdAt ?? this.now(), true);
  }

  get(turnId: string): Readonly<ScheduledTurn<TPayload, TResult>> | undefined {
    return this.turns.get(turnId);
  }

  getActiveTurnForSession(
    sessionId: string,
  ): Readonly<ScheduledTurn<TPayload, TResult>> | undefined {
    const turnId = this.activeBySession.get(sessionId);
    return turnId ? this.turns.get(turnId) : undefined;
  }

  listQueued(): ReadonlyArray<Readonly<ScheduledTurn<TPayload, TResult>>> {
    return this.queue
      .map((turnId) => this.turns.get(turnId))
      .filter((turn): turn is ScheduledTurn<TPayload, TResult> => Boolean(turn));
  }

  listRunning(): ReadonlyArray<Readonly<ScheduledTurn<TPayload, TResult>>> {
    return [...this.runningControllers.keys()]
      .map((turnId) => this.turns.get(turnId))
      .filter((turn): turn is ScheduledTurn<TPayload, TResult> => Boolean(turn));
  }

  cancel(turnId: string, reason = "Cancelled by user."): boolean {
    const turn = this.turns.get(turnId);
    if (!turn) throw new UnknownTurnError(turnId);
    if (isTerminal(turn.status)) return false;

    turn.cancelReason = reason;
    if (turn.status === "queued") {
      this.queue = this.queue.filter((queuedId) => queuedId !== turnId);
      turn.status = "cancelled";
      turn.finishedAt = this.now();
      this.activeBySession.delete(turn.sessionId);
      this.emit({ type: "finished", turn });
      this.scheduleDispatch();
      return true;
    }

    if (turn.status === "running") {
      turn.status = "cancelling";
      this.emit({ type: "cancelling", turn });
      this.runningControllers.get(turnId)?.abort(reason);
      return true;
    }

    return false;
  }

  recover(
    persistedTurns: ReadonlyArray<PersistedTurn<TPayload>>,
    policy: StartupRecoveryPolicy<TPayload> = new InterruptRunningRecoveryPolicy<TPayload>(),
  ): RecoveryReport<TPayload, TResult> {
    const requeued: ScheduledTurn<TPayload, TResult>[] = [];
    const terminal: ScheduledTurn<TPayload, TResult>[] = [];
    const ordered = [...persistedTurns].sort(
      (left, right) => left.queuedAt - right.queuedAt || left.id.localeCompare(right.id),
    );

    for (const persisted of ordered) {
      if (this.turns.has(persisted.id)) {
        throw new Error(`Cannot recover duplicate turn id ${persisted.id}.`);
      }
      const action = policy.decide(persisted);
      if (action === "requeue") {
        const turn = this.enqueueInternal(
          persisted,
          persisted.queuedAt,
          false,
        );
        requeued.push(turn as ScheduledTurn<TPayload, TResult>);
        continue;
      }

      const finishedAt = this.now();
      const turn: ScheduledTurn<TPayload, TResult> = {
        id: persisted.id,
        sessionId: persisted.sessionId,
        teamId: persisted.teamId,
        userId: persisted.userId,
        payload: persisted.payload,
        status: action === "cancel" ? "cancelled" : "interrupted",
        createdAt: persisted.createdAt ?? persisted.queuedAt,
        queuedAt: persisted.queuedAt,
        finishedAt,
        ...(persisted.startedAt === undefined ? {} : { startedAt: persisted.startedAt }),
        ...(action === "cancel" ? { cancelReason: "Cancelled during startup recovery." } : {}),
      };
      this.turns.set(turn.id, turn);
      terminal.push(turn);
      this.emit({ type: "finished", turn });
    }

    this.scheduleDispatch();
    return { requeued, terminal };
  }

  private enqueueInternal(
    request: TurnRequest<TPayload>,
    queuedAt: number,
    schedule: boolean,
  ): Readonly<ScheduledTurn<TPayload, TResult>> {
    const existing = this.activeBySession.get(request.sessionId);
    if (existing) throw new SessionAlreadyActiveError(request.sessionId, existing);

    const id = request.id ?? this.idFactory();
    if (this.turns.has(id)) throw new Error(`Turn id ${id} already exists.`);
    const turn: ScheduledTurn<TPayload, TResult> = {
      id,
      sessionId: request.sessionId,
      teamId: request.teamId,
      userId: request.userId,
      payload: request.payload,
      status: "queued",
      createdAt: request.createdAt ?? queuedAt,
      queuedAt,
    };
    this.turns.set(id, turn);
    this.activeBySession.set(turn.sessionId, turn.id);
    this.queue.push(turn.id);
    this.emit({ type: "queued", turn });
    if (schedule) this.scheduleDispatch();
    return turn;
  }

  private scheduleDispatch(): void {
    if (this.dispatchScheduled) return;
    this.dispatchScheduled = true;
    queueMicrotask(() => {
      this.dispatchScheduled = false;
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.runningCount < this.limits.global) {
      const queueIndex = this.queue.findIndex((turnId) => {
        const turn = this.turns.get(turnId);
        return Boolean(turn && this.hasCapacity(turn));
      });
      if (queueIndex < 0) return;

      const [turnId] = this.queue.splice(queueIndex, 1);
      const turn = turnId ? this.turns.get(turnId) : undefined;
      if (!turn || turn.status !== "queued") continue;
      this.start(turn);
    }
  }

  private hasCapacity(turn: ScheduledTurn<TPayload, TResult>): boolean {
    return (
      this.runningCount < this.limits.global &&
      (this.runningByTeam.get(turn.teamId) ?? 0) < this.limits.perTeam &&
      (this.runningByUser.get(turn.userId) ?? 0) < this.limits.perUser
    );
  }

  private start(turn: ScheduledTurn<TPayload, TResult>): void {
    const controller = new AbortController();
    turn.status = "running";
    turn.startedAt = this.now();
    this.runningCount += 1;
    this.increment(this.runningByTeam, turn.teamId);
    this.increment(this.runningByUser, turn.userId);
    this.runningControllers.set(turn.id, controller);
    this.emit({ type: "started", turn });

    void this.runner({ turn, signal: controller.signal })
      .then((result) => {
        turn.result = result;
        turn.status = controller.signal.aborted ? "cancelled" : "completed";
      })
      .catch((error: unknown) => {
        turn.error = error;
        turn.status = controller.signal.aborted ? "cancelled" : "failed";
      })
      .finally(() => {
        turn.finishedAt = this.now();
        this.runningControllers.delete(turn.id);
        this.runningCount -= 1;
        this.decrement(this.runningByTeam, turn.teamId);
        this.decrement(this.runningByUser, turn.userId);
        this.activeBySession.delete(turn.sessionId);
        this.emit({ type: "finished", turn });
        this.scheduleDispatch();
      });
  }

  private increment(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  private decrement(counts: Map<string, number>, key: string): void {
    const next = (counts.get(key) ?? 1) - 1;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
  }

  private emit(event: SchedulerEvent<TPayload, TResult>): void {
    if (!this.onEvent) return;
    try {
      const result = this.onEvent(event);
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Observers must never corrupt scheduler accounting. Persisting observers
      // should surface their own failures through monitoring/retry facilities.
    }
  }
}

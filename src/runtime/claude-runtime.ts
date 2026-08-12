import { randomUUID } from "node:crypto";
import { parse } from "node:path";

import {
  query as claudeQuery,
  type Options as ClaudeOptions,
} from "@anthropic-ai/claude-agent-sdk";

import type { JsonObject, Message, SessionStatus, Turn } from "../domain/models.js";
import { resolveAllowedRealPath } from "../security/paths.js";
import {
  InterruptRunningRecoveryPolicy,
  RuntimeScheduler,
  type PersistedTurn,
  type SchedulerEvent,
  type ScheduledTurn,
} from "./scheduler.js";
import { OrderedStreamBuffer, type StreamBufferSnapshot } from "./stream-buffer.js";
import { emptyStreamBufferSnapshot, type ActiveRuntime } from "./runtime-state.js";
import {
  approvedToolSpecs,
  arrayAt,
  autoCompactWindow,
  claudeRuntimeEnvironment,
  cliArgsToExtraArgs,
  createPromptQueue,
  errorMessage,
  guardedPrompt,
  isRecord,
  normalizePlanStatus,
  parseMcpToolName,
  planSummary,
  recordAt,
  resolveClaudeExecutable,
  sanitizeCachedApprovals,
  sanitizeClaudeExtraArgs,
  splitArguments,
  stringAt,
  numberAt,
  toJsonObject,
  toJsonValue,
  type UnknownRecord,
} from "./runtime-helpers.js";
import { RuntimePermissionBroker } from "./runtime-permissions.js";
import type {
  ClaudeQueryFactory,
  ClaudeRuntimeOptions,
  CreateMessageInput,
  PermissionResolution,
  PlanItem,
  RuntimeEvent,
  RuntimeEventSink,
  RuntimeMetricsSnapshot,
  RuntimePlan,
  RuntimeTurnPayload,
  SessionRuntimeStore,
  SubmitTurnInput,
} from "./runtime-contracts.js";

export * from "./runtime-contracts.js";

export {
  approvedToolSpecs,
  claudeRuntimeEnvironment,
  cliArgsToExtraArgs,
  createPromptQueue,
  normalizePlanStatus,
  parseMcpToolName,
  resolveClaudeExecutable,
  sanitizeClaudeExtraArgs,
} from "./runtime-helpers.js";

export class ClaudeRuntimeManager {
  readonly scheduler: RuntimeScheduler<RuntimeTurnPayload, void>;
  private readonly store: SessionRuntimeStore;
  private readonly events: RuntimeEventSink;
  private readonly queryFactory: ClaudeQueryFactory;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly permissions: RuntimePermissionBroker;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatSilenceMs: number;
  private readonly streamFlushIntervalMs: number;
  private readonly streamFlushBytes: number;
  private readonly active = new Map<string, ActiveRuntime>();
  private readonly finalizedTurnIds = new Set<string>();
  private turnsSubmitted = 0;
  private turnsCompleted = 0;
  private turnsFailed = 0;
  private turnsStopped = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadInputTokens = 0;
  private cacheCreationInputTokens = 0;
  private totalCostUsd = 0;
  private totalTurnDurationMs = 0;
  private measuredTurns = 0;
  private lastActivityAt: number | null = null;
  private completedStreamMetrics: StreamBufferSnapshot = emptyStreamBufferSnapshot();

  constructor(options: ClaudeRuntimeOptions) {
    this.store = options.store;
    this.events = options.events;
    this.queryFactory = options.queryFactory ?? ((input) => claudeQuery(input));
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.heartbeatSilenceMs = options.heartbeatSilenceMs ?? 10_000;
    this.streamFlushIntervalMs = options.streamFlushIntervalMs ?? 75;
    this.streamFlushBytes = options.streamFlushBytes ?? 8 * 1024;
    this.permissions = new RuntimePermissionBroker({
      store: this.store,
      getRuntime: (sessionId) => this.active.get(sessionId),
      publish: (event) => this.publish(event),
      createMessage: (input) => this.createMessage(input),
      now: this.now,
      idFactory: this.idFactory,
      permissionTtlMs: options.permissionTtlMs ?? 30 * 60 * 1_000,
    });
    this.scheduler = new RuntimeScheduler<RuntimeTurnPayload, void>({
      limits: options.limits,
      now: this.now,
      idFactory: this.idFactory,
      runner: ({ turn, signal }) => this.execute(turn, signal),
      onEvent: (event) => this.handleSchedulerEvent(event),
    });
  }

  async submit(input: SubmitTurnInput): Promise<Readonly<ScheduledTurn<RuntimeTurnPayload, void>>> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) throw new Error(`Session ${input.sessionId} was not found.`);
    if (session.teamId !== input.teamId) throw new Error("Session does not belong to the submitted team.");
    const now = this.now();
    this.turnsSubmitted += 1;
    this.lastActivityAt = now;
    const turnId = input.turnId ?? this.idFactory();
    const turn: Turn = {
      id: turnId,
      sessionId: input.sessionId,
      requestedByUserId: input.userId,
      status: "queued",
      prompt: input.prompt,
      retryOfMessageId: input.retryOfMessageId ?? null,
      claudeSessionId: session.claudeSessionId,
      startedAt: null,
      finishedAt: null,
      stopReason: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createTurn(turn);
    await this.store.updateSession(session.id, { status: "queued", updatedAt: now });
    await this.publish({ type: "session.status.changed", sessionId: session.id, status: "queued" });
    return this.scheduler.enqueue({
      id: turnId,
      sessionId: input.sessionId,
      teamId: input.teamId,
      userId: input.userId,
      payload: { sessionId: input.sessionId, teamId: input.teamId, userId: input.userId, prompt: input.prompt },
      createdAt: now,
    });
  }

  metricsSnapshot(): RuntimeMetricsSnapshot {
    const stream = { ...this.completedStreamMetrics };
    let permissionsPending = 0;
    for (const runtime of this.active.values()) {
      const current = runtime.deltaBuffer.snapshot();
      stream.bufferedBytes += current.bufferedBytes;
      stream.appendedBytes += current.appendedBytes;
      stream.persistedBytes += current.persistedBytes;
      stream.flushes += current.flushes;
      stream.flushFailures += current.flushFailures;
      stream.lastFlushAt = Math.max(stream.lastFlushAt ?? 0, current.lastFlushAt ?? 0) || null;
      permissionsPending += runtime.pendingPermissionResolvers.size;
    }
    return {
      activeSessions: this.active.size,
      schedulerQueued: this.scheduler.listQueued().length,
      schedulerRunning: this.scheduler.listRunning().length,
      turnsSubmitted: this.turnsSubmitted,
      turnsCompleted: this.turnsCompleted,
      turnsFailed: this.turnsFailed,
      turnsStopped: this.turnsStopped,
      permissionsPending,
      streamBufferedBytes: stream.bufferedBytes,
      streamAppendedBytes: stream.appendedBytes,
      streamPersistedBytes: stream.persistedBytes,
      streamFlushes: stream.flushes,
      streamFlushFailures: stream.flushFailures,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadInputTokens: this.cacheReadInputTokens,
      cacheCreationInputTokens: this.cacheCreationInputTokens,
      totalCostUsd: Number(this.totalCostUsd.toFixed(6)),
      averageTurnDurationMs: this.measuredTurns ? Math.round(this.totalTurnDurationMs / this.measuredTurns) : null,
      lastActivityAt: this.lastActivityAt,
    };
  }

  recover(turns: ReadonlyArray<PersistedTurn<RuntimeTurnPayload>>): void {
    this.scheduler.recover(turns, new InterruptRunningRecoveryPolicy());
  }

  sendGuidance(sessionId: string, content: string, priority: "now" | "next" | "later" = "next"): boolean {
    return this.active.get(sessionId)?.promptQueue.push(content, priority) ?? false;
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const runtime = this.active.get(sessionId);
    if (!runtime?.queryHandle?.interrupt) return false;
    await runtime.queryHandle.interrupt();
    return true;
  }

  stop(sessionId: string, reason = "Stopped by user."): boolean {
    const activeTurn = this.scheduler.getActiveTurnForSession(sessionId);
    if (!activeTurn) return false;
    const runtime = this.active.get(sessionId);
    if (runtime) {
      runtime.stopRequested = true;
      runtime.promptQueue.close();
      try {
        runtime.queryHandle?.close?.();
      } catch (error: unknown) {
        // Closing is advisory; the scheduler abort below is authoritative and
        // must still run so execute() reaches its terminal durability flush.
        void this.publish({ type: "agent.error", sessionId, message: errorMessage(error) });
      }
      for (const [permissionId, resolver] of runtime.pendingPermissionResolvers) {
        void this.store.expirePermission(permissionId, this.now())
          .then((expired) => expired ? this.publish({ type: "permission.updated", sessionId, permission: expired }) : undefined);
        resolver({ behavior: "deny", message: reason, decisionClassification: "user_reject" });
      }
      runtime.pendingPermissionResolvers.clear();
    }
    return this.scheduler.cancel(activeTurn.id, reason);
  }

  async decidePermission(permissionId: string, decision: unknown, decidedBy: string): Promise<PermissionResolution> {
    return this.permissions.decide(permissionId, decision, decidedBy);
  }
  private async execute(turn: Readonly<ScheduledTurn<RuntimeTurnPayload, void>>, signal: AbortSignal): Promise<void> {
    const session = await this.store.getSession(turn.sessionId);
    if (!session) throw new Error(`Session ${turn.sessionId} disappeared before execution.`);
    const agent = await this.store.getAgent(session.agentId);
    if (!agent) throw new Error(`Agent ${session.agentId} was not found.`);
    const config = await this.store.getConfig(session.teamId);
    const now = this.now();
    const cwd = await resolveAllowedRealPath(session.cwd, [config.workspaceRoot]);
    session.cwd = cwd;
    const safeApprovals = sanitizeCachedApprovals(session.toolApprovals);
    if (JSON.stringify(safeApprovals) !== JSON.stringify(session.toolApprovals)) {
      session.toolApprovals = safeApprovals;
      await this.store.updateToolApprovals(session.id, safeApprovals);
    }
    await this.store.updateTurn(turn.id, { status: "running", startedAt: now, updatedAt: now });
    await this.store.updateSession(session.id, { status: "running", updatedAt: now });
    await this.store.updateAgent(agent.id, { status: "running", updatedAt: now });

    const currentMessage = await this.createMessage({
      sessionId: session.id,
      senderType: "agent",
      senderId: agent.id,
      content: "",
      metadata: { turnId: turn.id },
    });
    const thinkingMessage = await this.createMessage({
      sessionId: session.id,
      senderType: "tool",
      senderId: agent.id,
      content: "",
      metadata: { type: "thinking", status: "thinking", subject: "正在分析", waitedSeconds: 0, turnId: turn.id },
    });
    const abortController = new AbortController();
    signal.addEventListener("abort", () => abortController.abort(signal.reason), { once: true });
    if (signal.aborted) abortController.abort(signal.reason);
    const promptQueue = createPromptQueue(guardedPrompt(session, config, turn.payload.prompt));
    let runtime: ActiveRuntime;
    const deltaBuffer = new OrderedStreamBuffer<JsonObject, Message>({
      flushIntervalMs: this.streamFlushIntervalMs,
      maximumBytes: this.streamFlushBytes,
      now: this.now,
      flush: (messageId, text, metadata) => this.store.appendMessageDelta(messageId, text, metadata),
      onFlushed: async (message, text) => {
        if (message.id === runtime.currentMessage.id) runtime.currentMessage = message;
        if (message.id === runtime.thinkingMessage.id) runtime.thinkingMessage = message;
        this.lastActivityAt = this.now();
        await this.publish({ type: "session.message.delta", sessionId: session.id, messageId: message.id, text, message });
      },
    });
    runtime = {
      payload: turn.payload,
      session,
      agent,
      abortController,
      promptQueue,
      currentMessage,
      thinkingMessage,
      planMessage: null,
      turnId: turn.id,
      startedAt: now,
      lastOutputAt: now,
      heartbeat: null,
      heartbeatTail: Promise.resolve(),
      heartbeatCount: 0,
      streamParts: new Map(),
      toolMessages: new Map(),
      planItems: [],
      planTaskIndex: new Map(),
      pendingPermissionResolvers: new Map(),
      finalText: "",
      result: null,
      error: "",
      usedPartialText: false,
      stopRequested: false,
      terminal: false,
      deltaBuffer,
    };
    this.active.set(session.id, runtime);
    this.startHeartbeat(runtime);
    await this.publish({ type: "turn.started", sessionId: session.id, turnId: turn.id });
    await this.publish({ type: "session.status.changed", sessionId: session.id, status: "running" });

    const allowedTools = approvedToolSpecs(session, config);
    const sanitizedArgs = sanitizeClaudeExtraArgs(splitArguments(config.args));
    const executablePath = resolveClaudeExecutable(config.command);
    const sdkOptions: ClaudeOptions = {
      abortController,
      cwd,
      env: claudeRuntimeEnvironment(),
      includePartialMessages: true,
      includeHookEvents: true,
      extraArgs: cliArgsToExtraArgs(sanitizedArgs),
      settings: {
        autoCompactEnabled: config.autoCompactEnabled,
        autoCompactWindow: autoCompactWindow(config),
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: false,
        filesystem: {
          denyRead: [parse(cwd).root],
          allowRead: [cwd],
          allowWrite: [cwd],
        },
      },
      hooks: {
        PostCompact: [{
          hooks: [async (input) => {
            const inputRecord = toJsonObject(input);
            await this.recordCompact(runtime, inputRecord, stringAt(input, "compact_summary") ?? "");
            return { continue: true, suppressOutput: true };
          }],
        }],
      },
      ...(session.claudeSessionId ? { resume: session.claudeSessionId } : {}),
      ...(allowedTools.length > 0 ? { allowedTools } : {}),
      ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
      canUseTool: (toolName, input, permissionOptions) =>
        this.permissions.request(runtime, config, toolName, input, permissionOptions),
    };

    await this.createMessage({
      sessionId: session.id,
      senderType: "tool",
      senderId: agent.id,
      content: `${session.claudeSessionId ? "恢复" : "启动"} Claude Code SDK 会话\ncommand: ${executablePath ?? "SDK bundled Claude Code"}\npreauthorizedTools: ${allowedTools.join(", ") || "(none)"}\nautoCompact: ${config.autoCompactEnabled ? `${autoCompactWindow(config)} tokens` : "disabled"}\ncwd: ${cwd}`,
      metadata: { type: "command", command: executablePath ?? "sdk-bundled", args: allowedTools, cwd, runtime: "sdk", claudeSessionId: session.claudeSessionId },
    });

    let exitCode = 0;
    try {
      const handle = this.queryFactory({ prompt: promptQueue.stream, options: sdkOptions });
      runtime.queryHandle = handle;
      for await (const event of handle) {
        runtime.lastOutputAt = this.now();
        await this.handleEvent(runtime, event);
      }
    } catch (error: unknown) {
      exitCode = runtime.stopRequested || abortController.signal.aborted ? 130 : 1;
      runtime.error = errorMessage(error);
      if (exitCode !== 130) await this.publish({ type: "agent.error", sessionId: session.id, message: runtime.error });
    } finally {
      promptQueue.close();
      this.clearHeartbeat(runtime);
      try {
        await this.complete(runtime, exitCode);
      } finally {
        this.retainStreamMetrics(runtime.deltaBuffer.snapshot());
        if (this.active.get(session.id) === runtime) this.active.delete(session.id);
      }
    }
  }

  private async handleEvent(runtime: ActiveRuntime, event: unknown): Promise<void> {
    if (!isRecord(event)) return;
    const sessionId = stringAt(event, "session_id");
    if (sessionId && sessionId !== runtime.session.claudeSessionId) {
      runtime.session.claudeSessionId = sessionId;
      await this.store.updateSession(runtime.session.id, { claudeSessionId: sessionId, updatedAt: this.now() });
      await this.store.updateTurn(runtime.turnId, { claudeSessionId: sessionId, updatedAt: this.now() });
    }
    const type = stringAt(event, "type");
    if (type === "stream_event") return this.handlePartialEvent(runtime, event);
    if (type === "system") return this.handleSystemEvent(runtime, event);
    if (type === "assistant") return this.handleAssistantEvent(runtime, event);
    if (type === "user") return this.handleUserEvent(runtime, event);
    if (type === "result") {
      runtime.result = event;
      const usage = recordAt(event, "usage");
      this.inputTokens += usage ? numberAt(usage, "input_tokens") ?? 0 : 0;
      this.outputTokens += usage ? numberAt(usage, "output_tokens") ?? 0 : 0;
      this.cacheReadInputTokens += usage ? numberAt(usage, "cache_read_input_tokens") ?? 0 : 0;
      this.cacheCreationInputTokens += usage ? numberAt(usage, "cache_creation_input_tokens") ?? 0 : 0;
      this.totalCostUsd += numberAt(event, "total_cost_usd") ?? 0;
      const durationMs = numberAt(event, "duration_ms");
      if (durationMs !== undefined) {
        this.totalTurnDurationMs += Math.max(0, durationMs);
        this.measuredTurns += 1;
      }
      runtime.promptQueue.close();
      const result = stringAt(event, "result");
      if (!runtime.finalText && result) await this.appendAgentDelta(runtime, result);
    }
  }

  private async handlePartialEvent(runtime: ActiveRuntime, wrapper: UnknownRecord): Promise<void> {
    const event = recordAt(wrapper, "event");
    if (!event) return;
    if (stringAt(event, "type") === "content_block_start") {
      const block = recordAt(event, "content_block");
      if (block && stringAt(block, "type") === "tool_use") await this.upsertTool(runtime, block, "running");
      return;
    }
    if (stringAt(event, "type") !== "content_block_delta") return;
    const delta = recordAt(event, "delta");
    if (!delta) return;
    if (stringAt(delta, "type") === "text_delta") {
      const text = stringAt(delta, "text");
      if (text) {
        runtime.usedPartialText = true;
        await this.appendAgentDelta(runtime, text);
      }
    } else if (["thinking_delta", "signature_delta"].includes(stringAt(delta, "type") ?? "")) {
      const thinking = stringAt(delta, "thinking");
      if (thinking) await this.appendThinkingDelta(runtime, thinking, "正在分析");
    }
  }

  private async handleSystemEvent(runtime: ActiveRuntime, event: UnknownRecord): Promise<void> {
    const subtype = stringAt(event, "subtype");
    if (subtype === "compact_boundary") {
      await this.recordCompact(runtime, toJsonObject(recordAt(event, "compact_metadata") ?? {}), "");
    } else if (subtype === "status" && stringAt(event, "status") === "compacting") {
      await this.appendThinkingDelta(runtime, "Claude Code 正在进行原生上下文压缩。\n", "上下文压缩");
    } else if (subtype === "hook_response") {
      const input = recordAt(event, "input");
      if (stringAt(input, "hook_event_name") === "PostCompact") {
        await this.recordCompact(runtime, toJsonObject(input), stringAt(input, "compact_summary") ?? "");
      }
    } else if (subtype === "api_retry") {
      const seconds = Math.max(1, Math.round((numberAt(event, "retry_delay_ms") ?? 0) / 1_000));
      await this.appendThinkingDelta(runtime, `API 重试 ${numberAt(event, "attempt") ?? "?"}/${numberAt(event, "max_retries") ?? "?"}，约 ${seconds}s 后继续。\n`, "连接模型");
    }
  }

  private async handleAssistantEvent(runtime: ActiveRuntime, event: UnknownRecord): Promise<void> {
    const message = recordAt(event, "message");
    const content = arrayAt(message, "content");
    if (!content) return;
    const messageId = stringAt(message, "id") ?? stringAt(event, "uuid") ?? runtime.turnId;
    for (const [index, value] of content.entries()) {
      if (!isRecord(value)) continue;
      const partType = stringAt(value, "type") ?? "text";
      const key = `${messageId}:${index}:${partType}`;
      if (partType === "text") {
        if (runtime.usedPartialText) continue;
        const text = stringAt(value, "text") ?? stringAt(value, "content") ?? "";
        const delta = this.streamPartDelta(runtime, key, text);
        if (delta) await this.appendAgentDelta(runtime, delta);
      } else if (partType === "thinking") {
        const text = stringAt(value, "thinking") ?? stringAt(value, "text") ?? "";
        const delta = this.streamPartDelta(runtime, key, text);
        if (delta) await this.appendThinkingDelta(runtime, delta, stringAt(value, "subject") ?? "正在分析");
      } else if (partType === "tool_use") await this.upsertTool(runtime, value, "running");
    }
  }

  private async handleUserEvent(runtime: ActiveRuntime, event: UnknownRecord): Promise<void> {
    const content = arrayAt(recordAt(event, "message"), "content");
    if (!content) return;
    for (const part of content) {
      if (isRecord(part) && stringAt(part, "type") === "tool_result") await this.upsertTool(runtime, part, "completed");
    }
  }

  private async upsertTool(runtime: ActiveRuntime, part: UnknownRecord, status: "running" | "completed"): Promise<void> {
    // A tool event is an ordering boundary: text/thinking received before it must
    // be durable and visible before the tool message is published.
    await runtime.deltaBuffer.flushAll();
    const callId = stringAt(part, "id") ?? stringAt(part, "tool_use_id") ?? stringAt(part, "call_id") ?? this.idFactory();
    const existing = runtime.toolMessages.get(callId);
    const name = stringAt(part, "name") ?? stringAt(part, "tool_name") ?? stringAt(existing?.metadata, "name") ?? "tool";
    const parsedName = parseMcpToolName(name);
    await this.store.recordToolInventory(name, parsedName.serverName || null);
    const input = recordAt(part, "input") ?? recordAt(part, "args") ?? recordAt(existing?.metadata, "input") ?? {};
    const output = part.content ?? part.output;
    await this.updatePlanFromTool(runtime, name, input, status);
    const renderedOutput = typeof output === "string" ? output : output === undefined ? "" : JSON.stringify(toJsonValue(output), null, 2);
    const content = status === "completed"
      ? `${name} 完成${renderedOutput ? `\n${renderedOutput}` : ""}`
      : `${name} 运行中\n${JSON.stringify(toJsonObject(input), null, 2)}`;
    const metadata: JsonObject = { type: "tool_call", callId, name, status, input: toJsonObject(input), turnId: runtime.turnId };
    if (existing) {
      const updated = await this.store.updateMessage(existing.id, content, metadata);
      runtime.toolMessages.set(callId, updated);
      await this.publish({ type: "session.message.updated", sessionId: runtime.session.id, message: updated });
    } else {
      const created = await this.createMessage({ sessionId: runtime.session.id, senderType: "tool", senderId: runtime.agent.id, content, metadata });
      runtime.toolMessages.set(callId, created);
    }
  }

  private async updatePlanFromTool(runtime: ActiveRuntime, name: string, input: UnknownRecord, status: "running" | "completed"): Promise<void> {
    if (status !== "running") return;
    const tool = name.toLowerCase();
    if (tool === "todowrite") {
      const todos = arrayAt(input, "todos");
      if (!todos) return;
      runtime.planItems = todos.map((todo, index): PlanItem => ({
        id: stringAt(todo, "id") ?? `todo_${index + 1}`,
        content: stringAt(todo, "content") ?? stringAt(todo, "title") ?? `步骤 ${index + 1}`,
        activeForm: stringAt(todo, "activeForm") ?? stringAt(todo, "active_form") ?? stringAt(todo, "content") ?? "",
        status: normalizePlanStatus(isRecord(todo) ? todo.status : undefined),
      }));
      await this.upsertPlan(runtime);
      return;
    }
    if (tool === "taskcreate") {
      const taskId = stringAt(input, "taskId") ?? stringAt(input, "id") ?? this.idFactory();
      if (runtime.planTaskIndex.has(taskId)) return;
      const item: PlanItem = {
        id: taskId,
        content: stringAt(input, "subject") ?? stringAt(input, "title") ?? stringAt(input, "description") ?? "新任务",
        activeForm: stringAt(input, "activeForm") ?? stringAt(input, "active_form") ?? stringAt(input, "subject") ?? "",
        status: "pending",
      };
      runtime.planTaskIndex.set(taskId, item);
      runtime.planItems.push(item);
      await this.upsertPlan(runtime);
      return;
    }
    if (tool === "taskupdate") {
      const taskId = stringAt(input, "taskId") ?? stringAt(input, "id");
      if (!taskId) return;
      let item = runtime.planTaskIndex.get(taskId);
      if (!item) {
        item = { id: taskId, content: stringAt(input, "subject") ?? stringAt(input, "description") ?? taskId, activeForm: "", status: "pending" };
        runtime.planTaskIndex.set(taskId, item);
        runtime.planItems.push(item);
      }
      item.content = stringAt(input, "subject") ?? stringAt(input, "description") ?? item.content;
      item.activeForm = stringAt(input, "activeForm") ?? stringAt(input, "active_form") ?? item.activeForm;
      if (input.status !== undefined) item.status = normalizePlanStatus(input.status);
      await this.upsertPlan(runtime);
    }
  }

  private async upsertPlan(runtime: ActiveRuntime): Promise<void> {
    const items = runtime.planItems.filter((item) => item.status !== "deleted");
    if (items.length === 0) return;
    const plan: RuntimePlan = { items, turnId: runtime.turnId, updatedAt: this.now() };
    const metadata: JsonObject = {
      type: "plan",
      status: items.every((item) => item.status === "completed") ? "done" : "running",
      items: toJsonValue(items),
      turnId: runtime.turnId,
    };
    if (runtime.planMessage) {
      runtime.planMessage = await this.store.updateMessage(runtime.planMessage.id, planSummary(items), metadata);
      await this.publish({ type: "session.message.updated", sessionId: runtime.session.id, message: runtime.planMessage });
    } else {
      runtime.planMessage = await this.createMessage({ sessionId: runtime.session.id, senderType: "tool", senderId: runtime.agent.id, content: planSummary(items), metadata });
    }
    await this.store.updatePlan(runtime.session.id, plan);
    await this.publish({ type: "session.plan.updated", sessionId: runtime.session.id, plan });
  }

  private async appendAgentDelta(runtime: ActiveRuntime, text: string): Promise<void> {
    if (!text) return;
    runtime.finalText += text;
    const metadata: JsonObject = { ...runtime.currentMessage.metadata, claudeSessionId: runtime.session.claudeSessionId };
    runtime.deltaBuffer.append(runtime.currentMessage.id, text, metadata);
    this.lastActivityAt = this.now();
  }

  private async appendThinkingDelta(runtime: ActiveRuntime, text: string, subject: string): Promise<void> {
    if (!text) return;
    const metadata: JsonObject = { ...runtime.thinkingMessage.metadata, type: "thinking", status: "thinking", subject, turnId: runtime.turnId };
    runtime.deltaBuffer.append(runtime.thinkingMessage.id, text, metadata);
    this.lastActivityAt = this.now();
  }

  private streamPartDelta(runtime: ActiveRuntime, key: string, value: string): string {
    if (!value) return "";
    const previous = runtime.streamParts.get(key) ?? "";
    runtime.streamParts.set(key, value);
    return value.startsWith(previous) ? value.slice(previous.length) : value;
  }

  private async recordCompact(runtime: ActiveRuntime, metadata: JsonObject, summary: string): Promise<void> {
    await runtime.deltaBuffer.flushAll();
    await this.store.recordCompact(runtime.session.id, { occurredAt: this.now(), metadata, summary });
    const detail = summary
      ? `Claude Code 压缩摘要：\n${summary}`
      : `Claude Code 已执行上下文压缩。\ntrigger: ${String(metadata.trigger ?? "unknown")}\npre_tokens: ${String(metadata.pre_tokens ?? "unknown")}\npost_tokens: ${String(metadata.post_tokens ?? "unknown")}`;
    await this.createMessage({
      sessionId: runtime.session.id,
      senderType: "tool",
      senderId: runtime.agent.id,
      content: detail,
      metadata: { type: "thinking", status: "done", subject: "上下文压缩", turnId: runtime.turnId },
    });
  }

  private startHeartbeat(runtime: ActiveRuntime): void {
    runtime.heartbeat = setInterval(() => {
      runtime.heartbeatTail = runtime.heartbeatTail.then(async () => {
        if (runtime.terminal || this.now() - runtime.lastOutputAt < this.heartbeatSilenceMs) return;
        runtime.heartbeatCount += 1;
        runtime.lastOutputAt = this.now();
        const waitedSeconds = Math.round((this.now() - runtime.startedAt) / 1_000);
        const metadata: JsonObject = { ...runtime.thinkingMessage.metadata, type: "thinking", status: "thinking", count: runtime.heartbeatCount, waitedSeconds, turnId: runtime.turnId };
        await runtime.deltaBuffer.flushMessage(runtime.thinkingMessage.id);
        if (runtime.terminal) return;
        const message = await this.store.updateMessage(runtime.thinkingMessage.id, runtime.thinkingMessage.content, metadata);
        runtime.thinkingMessage = message;
        await this.publish({ type: "session.message.updated", sessionId: runtime.session.id, message });
      }).catch((error: unknown) => {
        void this.publish({ type: "agent.error", sessionId: runtime.session.id, message: errorMessage(error) }).catch(() => undefined);
      });
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(runtime: ActiveRuntime): void {
    if (runtime.heartbeat) clearInterval(runtime.heartbeat);
    runtime.heartbeat = null;
  }

  private async complete(runtime: ActiveRuntime, exitCode: number): Promise<void> {
    runtime.terminal = true;
    await runtime.heartbeatTail;
    await runtime.deltaBuffer.flushAll();
    const now = this.now();
    const pendingPermission = await this.store.hasPendingPermission(runtime.session.id, runtime.turnId);
    const resultError = runtime.result?.is_error === true;
    const status: Turn["status"] = runtime.stopRequested || runtime.abortController.signal.aborted
      ? "stopped"
      : pendingPermission
        ? "waiting_permission"
        : exitCode === 0 && !resultError
          ? "completed"
          : "failed";
    const sessionStatus: SessionStatus = status;
    const fallback = status === "stopped"
      ? "本轮已手动停止。"
      : status === "waiting_permission"
        ? "本轮等待用户确认后继续。"
        : status === "completed"
          ? "Claude Code 本轮没有返回文本。"
          : runtime.error || `Claude Code exited with code ${exitCode}.`;
    if (!runtime.currentMessage.content.trim()) {
      runtime.currentMessage = await this.store.updateMessage(runtime.currentMessage.id, fallback, {
        ...runtime.currentMessage.metadata,
        claudeSessionId: runtime.session.claudeSessionId,
        ...(runtime.error ? { error: runtime.error } : {}),
      });
      await this.publish({ type: "session.message.updated", sessionId: runtime.session.id, message: runtime.currentMessage });
    }
    runtime.thinkingMessage = await this.store.updateMessage(runtime.thinkingMessage.id, runtime.thinkingMessage.content, {
      ...runtime.thinkingMessage.metadata,
      type: "thinking",
      status: "done",
      durationMs: Math.max(0, now - runtime.startedAt),
      turnId: runtime.turnId,
    });
    await this.publish({ type: "session.message.updated", sessionId: runtime.session.id, message: runtime.thinkingMessage });
    await this.createMessage({
      sessionId: runtime.session.id,
      senderType: "tool",
      senderId: runtime.agent.id,
      content: status === "completed" ? "本轮完成，可继续发送下一轮。" : fallback,
      metadata: { type: "exit", code: exitCode, claudeSessionId: runtime.session.claudeSessionId, turnId: runtime.turnId },
    });
    await this.store.updateTurn(runtime.turnId, {
      status,
      finishedAt: now,
      stopReason: status === "stopped" ? "user" : null,
      error: status === "failed" ? runtime.error || fallback : null,
      claudeSessionId: runtime.session.claudeSessionId,
      updatedAt: now,
    });
    await this.store.updateSession(runtime.session.id, { status: sessionStatus, updatedAt: now });
    await this.store.updateAgent(runtime.agent.id, { status: "idle", updatedAt: now });
    if (status !== "waiting_permission" && runtime.session.toolApprovals.onceTools.length > 0) {
      const approvals = { ...runtime.session.toolApprovals, onceTools: [] };
      await this.store.updateToolApprovals(runtime.session.id, approvals);
    }
    if (status === "completed") this.turnsCompleted += 1;
    else if (status === "failed") this.turnsFailed += 1;
    else if (status === "stopped") this.turnsStopped += 1;
    this.lastActivityAt = now;
    this.finalizedTurnIds.add(runtime.turnId);
    await this.publish({ type: "turn.finished", sessionId: runtime.session.id, turnId: runtime.turnId, status });
    await this.publish({ type: "session.status.changed", sessionId: runtime.session.id, status: sessionStatus });
  }

  private retainStreamMetrics(snapshot: StreamBufferSnapshot): void {
    this.completedStreamMetrics = {
      bufferedBytes: 0,
      appendedBytes: this.completedStreamMetrics.appendedBytes + snapshot.appendedBytes,
      persistedBytes: this.completedStreamMetrics.persistedBytes + snapshot.persistedBytes,
      flushes: this.completedStreamMetrics.flushes + snapshot.flushes,
      flushFailures: this.completedStreamMetrics.flushFailures + snapshot.flushFailures,
      lastFlushAt: Math.max(this.completedStreamMetrics.lastFlushAt ?? 0, snapshot.lastFlushAt ?? 0) || null,
    };
  }

  private async createMessage(input: CreateMessageInput): Promise<Message> {
    const message = await this.store.createMessage(input);
    await this.publish({ type: "session.message.created", sessionId: input.sessionId, message });
    return message;
  }

  private async publish(event: RuntimeEvent): Promise<void> {
    await this.events.publish(event);
  }

  private async handleSchedulerEvent(event: SchedulerEvent<RuntimeTurnPayload, void>): Promise<void> {
    if (event.type === "queued") {
      await this.publish({ type: "turn.queued", sessionId: event.turn.sessionId, turnId: event.turn.id });
      return;
    }
    if (event.type !== "finished") return;
    if (this.finalizedTurnIds.delete(event.turn.id)) return;
    if (event.turn.status === "cancelled" && !this.active.has(event.turn.sessionId)) {
      const now = this.now();
      this.turnsStopped += 1;
      this.lastActivityAt = now;
      await this.store.updateTurn(event.turn.id, {
        status: "stopped",
        finishedAt: now,
        stopReason: event.turn.cancelReason ?? "cancelled",
        updatedAt: now,
      });
      await this.store.updateSession(event.turn.sessionId, { status: "stopped", updatedAt: now });
      await this.publish({ type: "turn.finished", sessionId: event.turn.sessionId, turnId: event.turn.id, status: "stopped" });
      await this.publish({ type: "session.status.changed", sessionId: event.turn.sessionId, status: "stopped" });
    } else if (event.turn.status === "interrupted") {
      const now = this.now();
      this.turnsStopped += 1;
      this.lastActivityAt = now;
      await this.store.updateTurn(event.turn.id, { status: "interrupted", finishedAt: now, updatedAt: now });
      await this.store.updateSession(event.turn.sessionId, { status: "interrupted", updatedAt: now });
      await this.publish({ type: "turn.finished", sessionId: event.turn.sessionId, turnId: event.turn.id, status: "interrupted" });
      await this.publish({ type: "session.status.changed", sessionId: event.turn.sessionId, status: "interrupted" });
    } else if (event.turn.status === "failed") {
      const now = this.now();
      this.turnsFailed += 1;
      this.lastActivityAt = now;
      const message = errorMessage(event.turn.error ?? "Claude runtime failed before completion.");
      await this.store.updateTurn(event.turn.id, { status: "failed", finishedAt: now, error: message, updatedAt: now });
      await this.store.updateSession(event.turn.sessionId, { status: "failed", updatedAt: now });
      const session = await this.store.getSession(event.turn.sessionId);
      if (session) await this.store.updateAgent(session.agentId, { status: "idle", updatedAt: now });
      await this.publish({ type: "turn.finished", sessionId: event.turn.sessionId, turnId: event.turn.id, status: "failed" });
      await this.publish({ type: "session.status.changed", sessionId: event.turn.sessionId, status: "failed" });
    }
  }
}

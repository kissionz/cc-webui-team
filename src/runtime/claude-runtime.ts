import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, parse, resolve } from "node:path";

import {
  query as claudeQuery,
  type Options as ClaudeOptions,
  type PermissionResult,
  type PermissionUpdate,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  Agent,
  ClaudeConfig,
  ConversationSession,
  JsonObject,
  JsonValue,
  Message,
  Permission,
  PermissionDecision,
  SessionStatus,
  ToolApprovals,
  Turn,
} from "../domain/models.js";
import {
  evaluatePermissionDecision,
  type PermissionDecision as SafePermissionDecision,
} from "../security/permissions.js";
import { resolveAllowedRealPath } from "../security/paths.js";
import {
  InterruptRunningRecoveryPolicy,
  RuntimeScheduler,
  type PersistedTurn,
  type SchedulerLimits,
  type SchedulerEvent,
  type ScheduledTurn,
} from "./scheduler.js";

export interface CreateMessageInput {
  sessionId: string;
  senderType: Message["senderType"];
  senderId: string | null;
  content: string;
  metadata: JsonObject;
}

export interface CreatePermissionInput {
  id: string;
  sessionId: string;
  agentId: string;
  requestedByUserId: string;
  type: "mcp_tool";
  risk: "low" | "medium" | "high" | "critical";
  summary: string;
  payload: string;
  turnId: string;
  status: "pending";
  expiresAt: number;
  toolName: string;
  serverName: string | null;
  toolInput: JsonObject;
  toolUseId: string | null;
  sdkPermission: true;
  permissionSuggestions: JsonValue[];
  reason: string;
  fallbackResume: boolean;
  metadata: JsonObject;
}

export interface CompactRecord {
  occurredAt: number;
  metadata: JsonObject;
  summary: string;
}

export interface PlanItem {
  id: string;
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

export interface RuntimePlan {
  items: PlanItem[];
  turnId: string;
  updatedAt: number;
}

/** Persistence boundary used by the runtime; SQLite implementations own transactions. */
export interface SessionRuntimeStore {
  getSession(sessionId: string): Promise<ConversationSession | null>;
  getAgent(agentId: string): Promise<Agent | null>;
  getConfig(): Promise<ClaudeConfig>;
  createTurn(turn: Turn): Promise<void>;
  updateTurn(turnId: string, patch: Partial<Turn>): Promise<void>;
  updateSession(sessionId: string, patch: Partial<ConversationSession>): Promise<void>;
  updateAgent(agentId: string, patch: Partial<Agent>): Promise<void>;
  createMessage(input: CreateMessageInput): Promise<Message>;
  updateMessage(messageId: string, content: string, metadata: JsonObject): Promise<Message>;
  appendMessageDelta(messageId: string, text: string, metadata: JsonObject): Promise<Message>;
  createPermission(input: CreatePermissionInput): Promise<Permission>;
  getPermission(permissionId: string): Promise<Permission | null>;
  /** Must compare-and-set pending status and expiry atomically. */
  decidePermission(
    permissionId: string,
    decision: PermissionDecision,
    status: "approved" | "rejected",
    decidedBy: string,
    decidedAt: number,
  ): Promise<Permission | null>;
  expirePermission(permissionId: string, expiredAt: number): Promise<Permission | null>;
  hasPendingPermission(sessionId: string, turnId: string): Promise<boolean>;
  updateToolApprovals(sessionId: string, approvals: ToolApprovals): Promise<void>;
  recordCompact(sessionId: string, record: CompactRecord): Promise<void>;
  recordToolInventory(toolName: string, serverName: string | null): Promise<void>;
  updatePlan(sessionId: string, plan: RuntimePlan): Promise<void>;
}

export type RuntimeEvent =
  | { type: "turn.queued"; sessionId: string; turnId: string }
  | { type: "turn.started"; sessionId: string; turnId: string }
  | { type: "turn.finished"; sessionId: string; turnId: string; status: Turn["status"] }
  | { type: "session.status.changed"; sessionId: string; status: SessionStatus }
  | { type: "session.message.created"; sessionId: string; message: Message }
  | { type: "session.message.updated"; sessionId: string; message: Message }
  | { type: "session.message.delta"; sessionId: string; messageId: string; text: string }
  | { type: "session.plan.updated"; sessionId: string; plan: RuntimePlan }
  | { type: "permission.created"; sessionId: string; permission: Permission }
  | { type: "permission.updated"; sessionId: string; permission: Permission }
  | { type: "agent.error"; sessionId: string; message: string };

export interface RuntimeEventSink {
  publish(event: RuntimeEvent): void | Promise<void>;
}

export interface ClaudeQueryHandle extends AsyncIterable<unknown> {
  close?: () => void;
  interrupt?: () => Promise<void>;
}

export interface ClaudeQueryInput {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeOptions;
}

export type ClaudeQueryFactory = (input: ClaudeQueryInput) => ClaudeQueryHandle;

export interface ClaudeRuntimeOptions {
  store: SessionRuntimeStore;
  events: RuntimeEventSink;
  limits: SchedulerLimits;
  queryFactory?: ClaudeQueryFactory;
  now?: () => number;
  idFactory?: () => string;
  heartbeatIntervalMs?: number;
  heartbeatSilenceMs?: number;
  permissionTtlMs?: number;
}

export interface RuntimeTurnPayload {
  sessionId: string;
  teamId: string;
  userId: string;
  prompt: string;
}

export interface SubmitTurnInput extends RuntimeTurnPayload {
  turnId?: string;
  retryOfMessageId?: string | null;
}

export type PermissionResolution =
  | { ok: true; permission: Permission }
  | { ok: false; reason: "not_found" | "invalid_decision" | "already_decided" | "expired" | "runtime_missing" };

interface PromptQueue {
  stream: AsyncIterable<SDKUserMessage>;
  push(content: string, priority?: "now" | "next" | "later"): boolean;
  close(): void;
}

interface ActiveRuntime {
  payload: RuntimeTurnPayload;
  session: ConversationSession;
  agent: Agent;
  abortController: AbortController;
  promptQueue: PromptQueue;
  queryHandle?: ClaudeQueryHandle;
  currentMessage: Message;
  thinkingMessage: Message;
  planMessage: Message | null;
  turnId: string;
  startedAt: number;
  lastOutputAt: number;
  heartbeat: ReturnType<typeof setInterval> | null;
  heartbeatCount: number;
  streamParts: Map<string, string>;
  toolMessages: Map<string, Message>;
  planItems: PlanItem[];
  planTaskIndex: Map<string, PlanItem>;
  pendingPermissionResolvers: Map<string, (result: PermissionResult) => void>;
  finalText: string;
  result: UnknownRecord | null;
  error: string;
  usedPartialText: boolean;
  stopRequested: boolean;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, key: string): UnknownRecord | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return typeof nested === "string" ? nested : undefined;
}

function numberAt(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return typeof nested === "number" && Number.isFinite(nested) ? nested : undefined;
}

function arrayAt(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return Array.isArray(nested) ? nested : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    const output: { [key: string]: JsonValue } = {};
    for (const [key, nested] of Object.entries(value)) output[key] = toJsonValue(nested);
    return output;
  }
  return String(value);
}

function toJsonObject(value: unknown): JsonObject {
  return isRecord(value) ? (toJsonValue(value) as JsonObject) : {};
}

function sdkUserMessage(
  content: string,
  priority: "now" | "next" | "later" = "next",
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    priority,
    timestamp: new Date().toISOString(),
  };
}

export function createPromptQueue(initialPrompt: string): PromptQueue {
  const queue: SDKUserMessage[] = [sdkUserMessage(initialPrompt, "now")];
  const waiters: Array<() => void> = [];
  let closed = false;
  const wake = (): void => {
    let waiter = waiters.shift();
    while (waiter) {
      waiter();
      waiter = waiters.shift();
    }
  };
  return {
    stream: (async function* stream(): AsyncGenerator<SDKUserMessage> {
      while (!closed || queue.length > 0) {
        const message = queue.shift();
        if (message) yield message;
        else await new Promise<void>((resolve) => waiters.push(resolve));
      }
    })(),
    push(content, priority = "next") {
      if (closed) return false;
      queue.push(sdkUserMessage(content, priority));
      wake();
      return true;
    },
    close() {
      closed = true;
      wake();
    },
  };
}

export function sanitizeClaudeExtraArgs(args: readonly string[]): string[] {
  const consumesValue = new Set([
    "--input-format", "--output-format", "--resume", "-r", "--session-id",
    "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  ]);
  const blocked = new Set([
    "-p", "--print", "--continue", "-c", "--replay-user-messages", ...consumesValue,
  ]);
  const sanitized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (blocked.has(argument)) {
      if (consumesValue.has(argument)) index += 1;
      continue;
    }
    if (/^--(?:input-format|output-format|resume|session-id|allowedTools|allowed-tools|disallowedTools|disallowed-tools)=/.test(argument)) continue;
    sanitized.push(argument);
  }
  return sanitized;
}

export function cliArgsToExtraArgs(args: readonly string[]): Record<string, string | null> {
  const output: Record<string, string | null> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals > 2) {
      output[argument.slice(2, equals)] = argument.slice(equals + 1);
      continue;
    }
    const key = argument.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("-")) output[key] = null;
    else {
      output[key] = next;
      index += 1;
    }
  }
  return output;
}

export function parseMcpToolName(name: string): { toolName: string; serverName: string } {
  if (!name.startsWith("mcp__")) return { toolName: name, serverName: "" };
  const parts = name.split("__");
  return { serverName: parts[1] ?? "", toolName: parts.slice(2).join("__") || name };
}

export function approvedToolSpecs(session: ConversationSession, config: ClaudeConfig): string[] {
  const specifications = new Set(config.mcpToolAllowlist);
  for (const tool of [...session.toolApprovals.onceTools, ...session.toolApprovals.alwaysTools]) {
    if (tool) specifications.add(tool);
  }
  for (const server of session.toolApprovals.alwaysServers) {
    if (server) specifications.add(`mcp__${server}__*`);
  }
  return [...specifications];
}

export function normalizePlanStatus(value: unknown): PlanItem["status"] {
  if (value === "completed" || value === "done") return "completed";
  if (value === "in_progress" || value === "running") return "in_progress";
  if (value === "deleted") return "deleted";
  return "pending";
}

function splitArguments(value: string): string[] {
  // Config arguments are administrator-controlled. Preserve quoted groups without
  // invoking a shell; escaped quote handling intentionally remains conservative.
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) =>
    part.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, double: string | undefined, single: string | undefined) => double ?? single ?? part),
  ) ?? [];
}

function autoCompactWindow(config: ClaudeConfig): number {
  const contextTokens = Math.max(1_000, config.modelContextTokens || 1_000_000);
  const ratio = Math.min(0.9, Math.max(0.1, config.autoCompactRatio || 0.62));
  return Math.floor(contextTokens * ratio);
}

/** Bare commands intentionally use the SDK-bundled Claude Code executable. */
export function resolveClaudeExecutable(command: string): string | undefined {
  if (!command) return undefined;
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  if (command.includes("/") || command.includes("\\")) {
    const candidate = resolve(command);
    return existsSync(candidate) ? candidate : undefined;
  }
  return undefined;
}

function isToolApproved(session: ConversationSession, config: ClaudeConfig, toolName: string): boolean {
  const parsed = parseMcpToolName(toolName);
  return config.mcpToolAllowlist.includes(toolName)
    || session.toolApprovals.onceTools.includes(toolName)
    || session.toolApprovals.alwaysTools.includes(toolName)
    || Boolean(parsed.serverName && session.toolApprovals.alwaysServers.includes(parsed.serverName));
}

function guardedPrompt(session: ConversationSession, config: ClaudeConfig, prompt: string): string {
  const allowed = approvedToolSpecs(session, config);
  return [
    "WebUI 工具边界提醒：",
    allowed.length > 0
      ? `WebUI 已预授权的工具：${allowed.join(", ")}`
      : "WebUI 当前没有预授权工具；这不限制 Claude Code 运行时已有的工具。",
    "实际可用工具以 Claude Code 运行时为准；需要工具时直接尝试，未预授权操作会触发审批。",
    "不要编造工具调用结果；真实调用失败时报告运行时错误。",
    "",
    "用户新消息：",
    prompt,
  ].join("\n");
}

function planSummary(items: readonly PlanItem[]): string {
  const visible = items.filter((item) => item.status !== "deleted");
  const completed = visible.filter((item) => item.status === "completed").length;
  const active = visible.find((item) => item.status === "in_progress");
  return `执行计划 ${completed}/${visible.length}${active ? `\n正在执行：${active.activeForm || active.content}` : ""}`;
}

function permissionUpdates(permission: Permission, decision: SafePermissionDecision): PermissionUpdate[] {
  if (decision === "allow_once") return [];
  const toolName = permission.toolName;
  const serverName = permission.serverName;
  const target = decision === "allow_always_server" && serverName
    ? `mcp__${serverName}__*`
    : toolName;
  return target
    ? [{ type: "addRules", rules: [{ toolName: target }], behavior: "allow", destination: "session" }]
    : [];
}

export function claudeRuntimeEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const exact = new Set([
    "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "HOME", "USERPROFILE", "PATH", "SHELL", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR",
    "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]);
  const result: Record<string, string> = { TERM: "xterm-256color" };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && exact.has(key)) result[key] = value;
  }
  return result;
}

function sanitizeCachedApprovals(approvals: ToolApprovals): ToolApprovals {
  const highRisk = new Set(["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
  return {
    onceTools: approvals.onceTools.filter((tool) => !highRisk.has(tool)),
    alwaysTools: approvals.alwaysTools.filter((tool) => !highRisk.has(tool)),
    alwaysServers: [...approvals.alwaysServers],
  };
}

export class ClaudeRuntimeManager {
  readonly scheduler: RuntimeScheduler<RuntimeTurnPayload, void>;
  private readonly store: SessionRuntimeStore;
  private readonly events: RuntimeEventSink;
  private readonly queryFactory: ClaudeQueryFactory;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatSilenceMs: number;
  private readonly permissionTtlMs: number;
  private readonly active = new Map<string, ActiveRuntime>();

  constructor(options: ClaudeRuntimeOptions) {
    this.store = options.store;
    this.events = options.events;
    this.queryFactory = options.queryFactory ?? ((input) => claudeQuery(input));
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.heartbeatSilenceMs = options.heartbeatSilenceMs ?? 10_000;
    this.permissionTtlMs = options.permissionTtlMs ?? 30 * 60 * 1_000;
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
      runtime.queryHandle?.close?.();
      for (const [permissionId, resolver] of runtime.pendingPermissionResolvers) {
        void this.store.expirePermission(permissionId, this.now())
          .then((expired) => expired ? this.publish({ type: "permission.updated", sessionId, permission: expired }) : undefined);
        resolver({ behavior: "deny", message: reason, decisionClassification: "user_reject" });
      }
      runtime.pendingPermissionResolvers.clear();
    }
    return this.scheduler.cancel(activeTurn.id, reason);
  }

  async decidePermission(
    permissionId: string,
    decision: unknown,
    decidedBy: string,
  ): Promise<PermissionResolution> {
    const permission = await this.store.getPermission(permissionId);
    if (!permission) return { ok: false, reason: "not_found" };
    const evaluated = evaluatePermissionDecision(permission, decision, this.now());
    if (!evaluated.ok) return { ok: false, reason: evaluated.reason };
    // `approved` is the platform-gate shorthand; for a tool resolver it has
    // the safe, non-persistent semantics of allow-once.
    const toolDecision: PermissionDecision = evaluated.decision === "approved"
      ? "allow_once"
      : evaluated.decision;
    const runtime = this.active.get(permission.sessionId);
    const resolver = runtime?.pendingPermissionResolvers.get(permission.id);
    if (!runtime || !resolver) return { ok: false, reason: "runtime_missing" };
    const persisted = await this.store.decidePermission(
      permission.id,
      toolDecision,
      evaluated.status,
      decidedBy,
      evaluated.decidedAt,
    );
    if (!persisted) return { ok: false, reason: "already_decided" };
    runtime.pendingPermissionResolvers.delete(permission.id);

    if (evaluated.status === "approved") {
      const session = await this.store.getSession(permission.sessionId);
      if (session) {
        const approvals = this.applyApproval(session.toolApprovals, permission, toolDecision);
        await this.store.updateToolApprovals(session.id, approvals);
        runtime.session.toolApprovals = approvals;
      }
      resolver({
        behavior: "allow",
        updatedInput: permission.toolInput,
        updatedPermissions: permissionUpdates(permission, toolDecision),
        ...(permission.toolUseId ? { toolUseID: permission.toolUseId } : {}),
        decisionClassification: toolDecision === "allow_once" ? "user_temporary" : "user_permanent",
      });
    } else {
      resolver({
        behavior: "deny",
        message: "User denied permission",
        ...(permission.toolUseId ? { toolUseID: permission.toolUseId } : {}),
        decisionClassification: "user_reject",
      });
    }
    await this.store.updateSession(permission.sessionId, { status: "running", updatedAt: this.now() });
    await this.store.updateAgent(permission.agentId, { status: "running", updatedAt: this.now() });
    await this.publish({ type: "permission.updated", sessionId: permission.sessionId, permission: persisted });
    await this.publish({ type: "session.status.changed", sessionId: permission.sessionId, status: "running" });
    return { ok: true, permission: persisted };
  }

  private applyApproval(
    current: ToolApprovals,
    permission: Permission,
    decision: SafePermissionDecision,
  ): ToolApprovals {
    const next: ToolApprovals = {
      onceTools: [...current.onceTools],
      alwaysTools: [...current.alwaysTools],
      alwaysServers: [...current.alwaysServers],
    };
    const add = (values: string[], value: string | null): void => {
      if (value && !values.includes(value)) values.push(value);
    };
    if (decision === "allow_once") add(next.onceTools, permission.toolName);
    if (decision === "allow_always_tool") add(next.alwaysTools, permission.toolName);
    if (decision === "allow_always_server") {
      add(next.alwaysServers, permission.serverName);
      add(next.alwaysTools, permission.toolName);
    }
    return next;
  }

  private async execute(turn: Readonly<ScheduledTurn<RuntimeTurnPayload, void>>, signal: AbortSignal): Promise<void> {
    const session = await this.store.getSession(turn.sessionId);
    if (!session) throw new Error(`Session ${turn.sessionId} disappeared before execution.`);
    const agent = await this.store.getAgent(session.agentId);
    if (!agent) throw new Error(`Agent ${session.agentId} was not found.`);
    const config = await this.store.getConfig();
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
    const runtime: ActiveRuntime = {
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
        this.requestToolPermission(runtime, config, toolName, input, permissionOptions),
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
        if (this.active.get(session.id) === runtime) this.active.delete(session.id);
      }
    }
  }

  private async requestToolPermission(
    runtime: ActiveRuntime,
    config: ClaudeConfig,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<NonNullable<ClaudeOptions["canUseTool"]>>[2],
  ): Promise<PermissionResult> {
    if (toolName === "AskUserQuestion") {
      return { behavior: "allow", updatedInput: input, toolUseID: options.toolUseID, decisionClassification: "user_temporary" };
    }
    const parsed = parseMcpToolName(toolName);
    await this.store.recordToolInventory(toolName, parsed.serverName || null);
    if (isToolApproved(runtime.session, config, toolName)) {
      return { behavior: "allow", updatedInput: input, toolUseID: options.toolUseID, decisionClassification: "user_permanent" };
    }

    const permission = await this.store.createPermission({
      id: this.idFactory(),
      sessionId: runtime.session.id,
      agentId: runtime.agent.id,
      requestedByUserId: runtime.session.createdBy,
      type: "mcp_tool",
      risk: ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName) ? "critical" : toolName.startsWith("mcp__") ? "medium" : "low",
      summary: options.title || `Claude Code 请求使用 ${parsed.serverName ? `${parsed.serverName} / ` : ""}${options.displayName || parsed.toolName}`,
      payload: runtime.payload.prompt,
      turnId: runtime.turnId,
      status: "pending",
      expiresAt: this.now() + this.permissionTtlMs,
      toolName,
      serverName: parsed.serverName || null,
      toolInput: toJsonObject(input),
      toolUseId: options.toolUseID,
      sdkPermission: true,
      permissionSuggestions: (options.suggestions ?? []).map(toJsonValue),
      reason: options.description || options.decisionReason || "Claude Code 请求使用该工具。",
      fallbackResume: false,
      metadata: {
        ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
        ...(options.agentID ? { agentId: options.agentID } : {}),
      },
    });
    await this.store.updateSession(runtime.session.id, { status: "waiting_permission", updatedAt: this.now() });
    await this.store.updateAgent(runtime.agent.id, { status: "waiting", updatedAt: this.now() });
    await this.createMessage({
      sessionId: runtime.session.id,
      senderType: "tool",
      senderId: runtime.agent.id,
      content: `${permission.summary}\n${permission.reason ?? ""}`,
      metadata: { type: "permission_request", permissionId: permission.id, toolName, serverName: parsed.serverName, turnId: runtime.turnId },
    });
    return new Promise<PermissionResult>((resolve) => {
      runtime.pendingPermissionResolvers.set(permission.id, resolve);
      const expiry = setTimeout(() => {
        if (!runtime.pendingPermissionResolvers.delete(permission.id)) return;
        void this.store.expirePermission(permission.id, this.now())
          .then((expired) => expired ? this.publish({ type: "permission.updated", sessionId: runtime.session.id, permission: expired }) : undefined)
          .finally(() => resolve({ behavior: "deny", message: "Permission request expired.", toolUseID: options.toolUseID, decisionClassification: "user_reject" }));
      }, Math.max(1, permission.expiresAt - this.now()));
      expiry.unref();
      options.signal.addEventListener("abort", () => {
        if (!runtime.pendingPermissionResolvers.delete(permission.id)) return;
        clearTimeout(expiry);
        void this.store.expirePermission(permission.id, this.now())
          .then((expired) => expired ? this.publish({ type: "permission.updated", sessionId: runtime.session.id, permission: expired }) : undefined)
          .finally(() => resolve({ behavior: "deny", message: "Permission request was aborted.", toolUseID: options.toolUseID, decisionClassification: "user_reject" }));
      }, { once: true });
      void this.publish({ type: "permission.created", sessionId: runtime.session.id, permission })
        .then(() => this.publish({ type: "session.status.changed", sessionId: runtime.session.id, status: "waiting_permission" }))
        .catch(() => {
          clearTimeout(expiry);
          if (runtime.pendingPermissionResolvers.delete(permission.id)) {
            resolve({ behavior: "deny", message: "Permission request could not be published.", toolUseID: options.toolUseID, decisionClassification: "user_reject" });
          }
        });
    });
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
    runtime.currentMessage = await this.store.appendMessageDelta(runtime.currentMessage.id, text, metadata);
    await this.publish({ type: "session.message.delta", sessionId: runtime.session.id, messageId: runtime.currentMessage.id, text });
  }

  private async appendThinkingDelta(runtime: ActiveRuntime, text: string, subject: string): Promise<void> {
    if (!text) return;
    const metadata: JsonObject = { ...runtime.thinkingMessage.metadata, type: "thinking", status: "thinking", subject, turnId: runtime.turnId };
    runtime.thinkingMessage = await this.store.appendMessageDelta(runtime.thinkingMessage.id, text, metadata);
    await this.publish({ type: "session.message.delta", sessionId: runtime.session.id, messageId: runtime.thinkingMessage.id, text });
  }

  private streamPartDelta(runtime: ActiveRuntime, key: string, value: string): string {
    if (!value) return "";
    const previous = runtime.streamParts.get(key) ?? "";
    runtime.streamParts.set(key, value);
    return value.startsWith(previous) ? value.slice(previous.length) : value;
  }

  private async recordCompact(runtime: ActiveRuntime, metadata: JsonObject, summary: string): Promise<void> {
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
      if (this.now() - runtime.lastOutputAt < this.heartbeatSilenceMs) return;
      runtime.heartbeatCount += 1;
      runtime.lastOutputAt = this.now();
      const waitedSeconds = Math.round((this.now() - runtime.startedAt) / 1_000);
      const metadata: JsonObject = { ...runtime.thinkingMessage.metadata, type: "thinking", status: "thinking", count: runtime.heartbeatCount, waitedSeconds, turnId: runtime.turnId };
      void this.store.updateMessage(runtime.thinkingMessage.id, runtime.thinkingMessage.content, metadata)
        .then(async (message) => {
          runtime.thinkingMessage = message;
          await this.publish({ type: "session.message.updated", sessionId: runtime.session.id, message });
        })
        .catch((error: unknown) => this.publish({ type: "agent.error", sessionId: runtime.session.id, message: errorMessage(error) }));
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(runtime: ActiveRuntime): void {
    if (runtime.heartbeat) clearInterval(runtime.heartbeat);
    runtime.heartbeat = null;
  }

  private async complete(runtime: ActiveRuntime, exitCode: number): Promise<void> {
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
    await this.publish({ type: "turn.finished", sessionId: runtime.session.id, turnId: runtime.turnId, status });
    await this.publish({ type: "session.status.changed", sessionId: runtime.session.id, status: sessionStatus });
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
    if (event.turn.status === "cancelled" && !this.active.has(event.turn.sessionId)) {
      const now = this.now();
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
      await this.store.updateTurn(event.turn.id, { status: "interrupted", finishedAt: now, updatedAt: now });
      await this.store.updateSession(event.turn.sessionId, { status: "interrupted", updatedAt: now });
      await this.publish({ type: "turn.finished", sessionId: event.turn.sessionId, turnId: event.turn.id, status: "interrupted" });
      await this.publish({ type: "session.status.changed", sessionId: event.turn.sessionId, status: "interrupted" });
    } else if (event.turn.status === "failed") {
      const now = this.now();
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

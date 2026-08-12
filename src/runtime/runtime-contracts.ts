import type {
  Options as ClaudeOptions,
  SDKUserMessage,
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
import type { SchedulerLimits } from "./scheduler.js";

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
  getConfig(teamId?: string): Promise<ClaudeConfig>;
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
  | { type: "session.message.delta"; sessionId: string; messageId: string; text: string; message: Message }
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
  streamFlushIntervalMs?: number;
  streamFlushBytes?: number;
}

export interface RuntimeMetricsSnapshot {
  activeSessions: number;
  schedulerQueued: number;
  schedulerRunning: number;
  turnsSubmitted: number;
  turnsCompleted: number;
  turnsFailed: number;
  turnsStopped: number;
  permissionsPending: number;
  streamBufferedBytes: number;
  streamAppendedBytes: number;
  streamPersistedBytes: number;
  streamFlushes: number;
  streamFlushFailures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  averageTurnDurationMs: number | null;
  lastActivityAt: number | null;
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

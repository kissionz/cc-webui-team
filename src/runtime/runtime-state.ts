import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import type { Agent, ConversationSession, JsonObject, Message } from "../domain/models.js";
import type { ClaudeQueryHandle, PlanItem, RuntimeTurnPayload } from "./runtime-contracts.js";
import type { PromptQueue, UnknownRecord } from "./runtime-helpers.js";
import { OrderedStreamBuffer, type StreamBufferSnapshot } from "./stream-buffer.js";

export interface ActiveRuntime {
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
  heartbeatTail: Promise<void>;
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
  terminal: boolean;
  deltaBuffer: OrderedStreamBuffer<JsonObject, Message>;
}

export function emptyStreamBufferSnapshot(): StreamBufferSnapshot {
  return {
    bufferedBytes: 0,
    appendedBytes: 0,
    persistedBytes: 0,
    flushes: 0,
    flushFailures: 0,
    lastFlushAt: null,
  };
}

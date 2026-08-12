import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";

import type {
  Agent,
  ClaudeConfig,
  ConversationSession,
  Message,
  Permission,
  ToolApprovals,
  Turn,
} from "../src/domain/models.js";
import {
  ClaudeRuntimeManager,
  claudeRuntimeEnvironment,
  cliArgsToExtraArgs,
  createPromptQueue,
  normalizePlanStatus,
  sanitizeClaudeExtraArgs,
  type CompactRecord,
  type CreateMessageInput,
  type CreatePermissionInput,
  type RuntimeEvent,
  type RuntimePlan,
  type SessionRuntimeStore,
} from "../src/runtime/claude-runtime.js";

function sessionFixture(): ConversationSession {
  return {
    id: "session-1",
    teamId: "team-1",
    agentId: "agent-1",
    createdBy: "user-1",
    title: "Runtime test",
    summary: null,
    summaryUpdatedAt: null,
    visibility: "private",
    status: "idle",
    cwd: process.cwd(),
    claudeSessionId: "resume-me",
    toolApprovals: { onceTools: [], alwaysTools: [], alwaysServers: [] },
    archivedAt: null,
    pinnedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function agentFixture(): Agent {
  return {
    id: "agent-1",
    teamId: "team-1",
    name: "Claude",
    type: "claude_code",
    command: "claude",
    enabled: true,
    status: "idle",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

function configFixture(): ClaudeConfig {
  return {
    command: "claude",
    args: "--model sonnet --resume forbidden --allowed-tools Bash --verbose",
    workspaceRoot: process.cwd(),
    modelContextTokens: 100_000,
    autoCompactRatio: 0.6,
    autoCompactEnabled: true,
    mcpToolAllowlist: [],
    enabled: true,
    available: true,
    version: "test",
    latencyMs: 1,
    authenticated: true,
    lastCheckAt: 1,
    healthMessage: null,
    updatedAt: 1,
  };
}

class MemoryStore implements SessionRuntimeStore {
  readonly session = sessionFixture();
  readonly agent = agentFixture();
  readonly config = configFixture();
  readonly turns = new Map<string, Turn>();
  readonly messages = new Map<string, Message>();
  readonly permissions = new Map<string, Permission>();
  readonly compacts: CompactRecord[] = [];
  readonly inventories: Array<[string, string | null]> = [];
  readonly deltaWrites: Array<{ messageId: string; text: string }> = [];
  plans: RuntimePlan[] = [];
  private sequence = 0;

  async getSession(sessionId: string): Promise<ConversationSession | null> {
    return sessionId === this.session.id ? this.session : null;
  }
  async getAgent(agentId: string): Promise<Agent | null> {
    return agentId === this.agent.id ? this.agent : null;
  }
  async getConfig(_teamId?: string): Promise<ClaudeConfig> { return this.config; }
  async createTurn(turn: Turn): Promise<void> { this.turns.set(turn.id, turn); }
  async updateTurn(turnId: string, patch: Partial<Turn>): Promise<void> {
    const current = this.turns.get(turnId);
    if (current) Object.assign(current, patch);
  }
  async updateSession(_sessionId: string, patch: Partial<ConversationSession>): Promise<void> {
    Object.assign(this.session, patch);
  }
  async updateAgent(_agentId: string, patch: Partial<Agent>): Promise<void> { Object.assign(this.agent, patch); }
  async createMessage(input: CreateMessageInput): Promise<Message> {
    const message: Message = {
      id: `message-${++this.sequence}`,
      ...input,
      createdAt: this.sequence,
      updatedAt: null,
    };
    this.messages.set(message.id, message);
    return message;
  }
  async updateMessage(messageId: string, content: string, metadata: Message["metadata"]): Promise<Message> {
    const message = this.messages.get(messageId);
    if (!message) throw new Error("missing message");
    message.content = content;
    message.metadata = metadata;
    message.updatedAt = ++this.sequence;
    return message;
  }
  async appendMessageDelta(messageId: string, text: string, metadata: Message["metadata"]): Promise<Message> {
    this.deltaWrites.push({ messageId, text });
    const message = this.messages.get(messageId);
    if (!message) throw new Error("missing message");
    message.content += text;
    message.metadata = metadata;
    message.updatedAt = ++this.sequence;
    return message;
  }
  async createPermission(input: CreatePermissionInput): Promise<Permission> {
    const permission: Permission = {
      ...input,
      decidedBy: null,
      decidedAt: null,
      decision: null,
      controlRequestId: null,
      createdAt: this.sequence,
      updatedAt: this.sequence,
    };
    this.permissions.set(permission.id, permission);
    return permission;
  }
  async getPermission(permissionId: string): Promise<Permission | null> {
    return this.permissions.get(permissionId) ?? null;
  }
  async decidePermission(
    permissionId: string,
    decision: Permission["decision"] & string,
    status: "approved" | "rejected",
    decidedBy: string,
    decidedAt: number,
  ): Promise<Permission | null> {
    const permission = this.permissions.get(permissionId);
    if (!permission || permission.status !== "pending" || permission.expiresAt <= decidedAt) return null;
    Object.assign(permission, { decision, status, decidedBy, decidedAt, updatedAt: decidedAt });
    return permission;
  }
  async expirePermission(permissionId: string, expiredAt: number): Promise<Permission | null> {
    const permission = this.permissions.get(permissionId);
    if (!permission || permission.status !== "pending") return permission ?? null;
    Object.assign(permission, { status: "expired", updatedAt: expiredAt });
    return permission;
  }
  async hasPendingPermission(sessionId: string, turnId: string): Promise<boolean> {
    return [...this.permissions.values()].some((item) => item.sessionId === sessionId && item.turnId === turnId && item.status === "pending");
  }
  async updateToolApprovals(_sessionId: string, approvals: ToolApprovals): Promise<void> {
    this.session.toolApprovals = approvals;
  }
  async recordCompact(_sessionId: string, record: CompactRecord): Promise<void> { this.compacts.push(record); }
  async recordToolInventory(toolName: string, serverName: string | null): Promise<void> { this.inventories.push([toolName, serverName]); }
  async updatePlan(_sessionId: string, plan: RuntimePlan): Promise<void> { this.plans.push(plan); }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for runtime state.");
    await delay(2);
  }
}

describe("Claude runtime pure helpers", () => {
  test("passes only explicit runtime environment variables", () => {
    const environment = claudeRuntimeEnvironment({
      PATH: "/bin",
      HOME: "/runtime-home",
      ANTHROPIC_API_KEY: "runtime-key",
      ADMIN_PASSWORD: "must-not-leak",
      DATABASE_URL: "must-not-leak",
    });
    expect(environment).toMatchObject({ PATH: "/bin", HOME: "/runtime-home" });
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.ADMIN_PASSWORD).toBeUndefined();
    expect(environment.DATABASE_URL).toBeUndefined();
  });
  test("prompt queue supports guidance priorities and closes", async () => {
    const queue = createPromptQueue("first");
    queue.push("guidance", "next");
    queue.close();
    const messages = [];
    for await (const message of queue.stream) messages.push(message);
    expect(messages.map((item) => item.message.content)).toEqual(["first", "guidance"]);
    expect(queue.push("late")).toBe(false);
  });

  test("sanitizes SDK-owned CLI arguments and parses safe extras", () => {
    expect(sanitizeClaudeExtraArgs(["--model", "sonnet", "--resume", "id", "--verbose", "--allowed-tools=Bash"]))
      .toEqual(["--model", "sonnet", "--verbose"]);
    expect(cliArgsToExtraArgs(["--model", "sonnet", "--verbose"])).toEqual({ model: "sonnet", verbose: null });
    expect(normalizePlanStatus("running")).toBe("in_progress");
  });
});

describe("ClaudeRuntimeManager", () => {
  test("coalesces burst deltas and flushes them before turn completion", async () => {
    const store = new MemoryStore();
    const events: RuntimeEvent[] = [];
    const manager = new ClaudeRuntimeManager({
      store,
      events: { publish: (event) => { events.push(event); } },
      limits: { global: 1, perTeam: 1, perUser: 1 },
      streamFlushIntervalMs: 1_000,
      streamFlushBytes: 64 * 1_024,
      queryFactory: () => (async function* () {
        for (const text of ["one", "-", "two", "-", "three"]) {
          yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } };
        }
        yield {
          type: "result", result: "ignored", is_error: false, session_id: "resume-me",
          duration_ms: 1250, total_cost_usd: 0.0125,
          usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
        };
      })(),
    });

    const turn = await manager.submit({ sessionId: "session-1", teamId: "team-1", userId: "user-1", prompt: "burst" });
    await waitFor(() => store.turns.get(turn.id)?.status === "completed");
    expect(store.deltaWrites).toHaveLength(1);
    expect(store.deltaWrites[0]?.text).toBe("one-two-three");
    const deltaIndex = events.findIndex((event) => event.type === "session.message.delta");
    const finishIndex = events.findIndex((event) => event.type === "turn.finished");
    expect(deltaIndex).toBeGreaterThan(-1);
    expect(finishIndex).toBeGreaterThan(deltaIndex);
    expect(manager.metricsSnapshot()).toMatchObject({
      streamBufferedBytes: 0, streamFlushes: 1, streamFlushFailures: 0,
      inputTokens: 120, outputTokens: 45, cacheReadInputTokens: 30,
      cacheCreationInputTokens: 10, totalCostUsd: 0.0125, averageTurnDurationMs: 1250,
    });
  });

  test("does not report completion when the terminal durability flush fails", async () => {
    const store = new MemoryStore();
    store.appendMessageDelta = async () => { throw new Error("sqlite busy"); };
    const manager = new ClaudeRuntimeManager({
      store,
      events: { publish: () => undefined },
      limits: { global: 1, perTeam: 1, perUser: 1 },
      streamFlushIntervalMs: 1_000,
      queryFactory: () => (async function* () {
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "not durable yet" } } };
        yield { type: "result", result: "ignored", is_error: false, session_id: "resume-me" };
      })(),
    });

    const turn = await manager.submit({ sessionId: "session-1", teamId: "team-1", userId: "user-1", prompt: "fail flush" });
    await waitFor(() => store.turns.get(turn.id)?.status === "failed");
    expect(store.turns.get(turn.id)?.error).toContain("sqlite busy");
    expect(manager.metricsSnapshot().streamFlushFailures).toBe(1);
  });

  test("still aborts and flushes buffered text when the SDK close hook throws", async () => {
    const store = new MemoryStore();
    const manager = new ClaudeRuntimeManager({
      store,
      events: { publish: () => undefined },
      limits: { global: 1, perTeam: 1, perUser: 1 },
      streamFlushIntervalMs: 1_000,
      queryFactory: ({ options }) => ({
        close: () => { throw new Error("close hook failed"); },
        async *[Symbol.asyncIterator]() {
          yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "keep me" } } };
          await new Promise<void>((resolve) => options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error("aborted");
        },
      }),
    });

    const turn = await manager.submit({ sessionId: "session-1", teamId: "team-1", userId: "user-1", prompt: "stop" });
    await waitFor(() => manager.metricsSnapshot().streamBufferedBytes > 0);
    expect(manager.stop("session-1")).toBe(true);
    await waitFor(() => store.turns.get(turn.id)?.status === "stopped");
    expect(store.deltaWrites.map((item) => item.text).join("")).toBe("keep me");
    expect(manager.metricsSnapshot()).toMatchObject({ streamBufferedBytes: 0, turnsStopped: 1 });
  });

  test("resumes SDK sessions and persists partial text, thinking, tools, plans, compact and completion", async () => {
    const store = new MemoryStore();
    const events: RuntimeEvent[] = [];
    let capturedResume: string | undefined;
    const manager = new ClaudeRuntimeManager({
      store,
      events: { publish: (event) => { events.push(event); } },
      limits: { global: 1, perTeam: 1, perUser: 1 },
      queryFactory: ({ options }) => {
        capturedResume = options.resume;
        return (async function* () {
          yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "think" } } };
          yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } };
          yield { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "call-1", name: "TodoWrite", input: { todos: [{ content: "Ship", status: "in_progress" }] } }] } };
          yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] } };
          yield { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 90, post_tokens: 20 } };
          yield { type: "result", session_id: "claude-new", result: "ignored because partial exists", is_error: false };
        })();
      },
    });

    const turn = await manager.submit({ sessionId: "session-1", teamId: "team-1", userId: "user-1", prompt: "work" });
    await waitFor(() => store.turns.get(turn.id)?.status === "completed");
    expect(capturedResume).toBe("resume-me");
    expect(store.session.claudeSessionId).toBe("claude-new");
    expect([...store.messages.values()].some((message) => message.senderType === "agent" && message.content === "Hello ")).toBe(true);
    expect([...store.messages.values()].some((message) => message.metadata.type === "thinking" && message.content.includes("think"))).toBe(true);
    expect([...store.messages.values()].some((message) => message.metadata.type === "tool_call" && message.content.includes("完成"))).toBe(true);
    expect(store.plans.at(-1)?.items[0]?.status).toBe("in_progress");
    expect(store.compacts).toHaveLength(1);
    expect(events.some((event) => event.type === "turn.finished")).toBe(true);
  });

  test("canUseTool waits for an atomic decision and persists always-tool approval", async () => {
    const store = new MemoryStore();
    let permissionResult: unknown;
    const manager = new ClaudeRuntimeManager({
      store,
      events: { publish: () => undefined },
      limits: { global: 1, perTeam: 1, perUser: 1 },
      queryFactory: ({ options }) => (async function* () {
        permissionResult = await options.canUseTool?.(
          "mcp__github__create_issue",
          { title: "Bug" },
          { signal: new AbortController().signal, toolUseID: "tool-use-1", title: "Create issue", suggestions: [] },
        );
        yield { type: "result", result: "done", is_error: false, session_id: "resume-me" };
      })(),
    });

    const turn = await manager.submit({ sessionId: "session-1", teamId: "team-1", userId: "user-1", prompt: "create" });
    await waitFor(() => store.permissions.size === 1);
    const permission = [...store.permissions.values()][0];
    expect(permission).toBeDefined();
    const resolution = await manager.decidePermission(permission!.id, "allow_always_tool", "approver-1");
    expect(resolution.ok).toBe(true);
    await waitFor(() => store.turns.get(turn.id)?.status === "completed");
    expect(permissionResult).toMatchObject({ behavior: "allow", toolUseID: "tool-use-1" });
    expect(store.session.toolApprovals.alwaysTools).toContain("mcp__github__create_issue");
    expect(store.inventories).toContainEqual(["mcp__github__create_issue", "github"]);
  });
});

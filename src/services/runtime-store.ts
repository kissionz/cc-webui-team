import type {
  Agent,
  ClaudeConfig,
  ConversationSession,
  JsonObject,
  Message,
  Permission,
  PermissionDecision,
  ToolApprovals,
  Turn,
} from "../domain/index.js";
import { createId } from "../domain/index.js";
import type { PersistenceRepository } from "../persistence/index.js";
import type {
  CompactRecord,
  CreateMessageInput,
  CreatePermissionInput,
  RuntimePlan,
  SessionRuntimeStore,
} from "../runtime/claude-runtime.js";

function mergeDefined<T extends object>(current: T, patch: Partial<T>): T {
  return { ...current, ...patch };
}

/** Bridges the synchronous SQLite repository to the runtime's asynchronous port. */
export class SqliteRuntimeStore implements SessionRuntimeStore {
  constructor(
    private readonly repository: PersistenceRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async getSession(sessionId: string): Promise<ConversationSession | null> {
    return this.repository.getSession(sessionId);
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    return this.repository.getAgent(agentId);
  }

  async getConfig(teamId?: string): Promise<ClaudeConfig> {
    const config = this.repository.getClaudeConfig();
    if (!config) throw new Error("Claude runtime configuration is missing.");
    if (!teamId) return config;
    const overrides = this.repository.getTeam(teamId)?.runtimeDefaults;
    if (!overrides) return config;
    return {
      ...config,
      ...(overrides.modelContextTokens === undefined ? {} : { modelContextTokens: overrides.modelContextTokens }),
      ...(overrides.autoCompactRatio === undefined ? {} : { autoCompactRatio: overrides.autoCompactRatio }),
      ...(overrides.autoCompactEnabled === undefined ? {} : { autoCompactEnabled: overrides.autoCompactEnabled }),
      ...(overrides.mcpToolAllowlist === undefined ? {} : { mcpToolAllowlist: [...overrides.mcpToolAllowlist] }),
    };
  }

  async createTurn(turn: Turn): Promise<void> {
    this.repository.createTurn(turn);
  }

  async updateTurn(turnId: string, patch: Partial<Turn>): Promise<void> {
    const current = this.repository.getTurn(turnId);
    if (!current) throw new Error(`Turn ${turnId} was not found.`);
    this.repository.saveTurn(mergeDefined(current, patch));
  }

  async updateSession(sessionId: string, patch: Partial<ConversationSession>): Promise<void> {
    const current = this.repository.getSession(sessionId);
    if (!current) throw new Error(`Session ${sessionId} was not found.`);
    this.repository.saveSession(mergeDefined(current, patch));
  }

  async updateAgent(agentId: string, patch: Partial<Agent>): Promise<void> {
    const current = this.repository.getAgent(agentId);
    if (!current) throw new Error(`Agent ${agentId} was not found.`);
    this.repository.saveAgent(mergeDefined(current, patch));
  }

  async createMessage(input: CreateMessageInput): Promise<Message> {
    const createdAt = this.now();
    const message: Message = {
      id: createId("message"),
      sessionId: input.sessionId,
      senderType: input.senderType,
      senderId: input.senderId,
      content: input.content,
      metadata: input.metadata,
      createdAt,
      updatedAt: null,
    };
    this.repository.appendMessage(message);
    return message;
  }

  async updateMessage(messageId: string, content: string, metadata: JsonObject): Promise<Message> {
    const current = this.repository.getMessage(messageId);
    if (!current) throw new Error(`Message ${messageId} was not found.`);
    const message = { ...current, content, metadata, updatedAt: this.now() };
    this.repository.saveMessage(message);
    return message;
  }

  async appendMessageDelta(messageId: string, text: string, metadata: JsonObject): Promise<Message> {
    const current = this.repository.getMessage(messageId);
    if (!current) throw new Error(`Message ${messageId} was not found.`);
    const message = {
      ...current,
      content: `${current.content}${text}`,
      metadata: { ...current.metadata, ...metadata },
      updatedAt: this.now(),
    };
    this.repository.saveMessage(message);
    return message;
  }

  async createPermission(input: CreatePermissionInput): Promise<Permission> {
    const createdAt = this.now();
    const permission: Permission = {
      ...input,
      decidedBy: null,
      decidedAt: null,
      decision: null,
      controlRequestId: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.repository.createPermission(permission);
    return permission;
  }

  async getPermission(permissionId: string): Promise<Permission | null> {
    return this.repository.getPermission(permissionId);
  }

  async decidePermission(
    permissionId: string,
    decision: PermissionDecision,
    status: "approved" | "rejected",
    decidedBy: string,
    decidedAt: number,
  ): Promise<Permission | null> {
    const result = this.repository.decidePermissionAtomic(permissionId, decidedBy, status, decision, decidedAt);
    return result.outcome === "decided" ? result.permission : null;
  }

  async expirePermission(permissionId: string, expiredAt: number): Promise<Permission | null> {
    return this.repository.expirePermission(permissionId, expiredAt);
  }

  async hasPendingPermission(sessionId: string, turnId: string): Promise<boolean> {
    return this.repository
      .listPermissions(sessionId, ["pending"])
      .some((permission) => permission.turnId === turnId);
  }

  async updateToolApprovals(sessionId: string, approvals: ToolApprovals): Promise<void> {
    await this.updateSession(sessionId, { toolApprovals: approvals, updatedAt: this.now() });
  }

  async recordCompact(sessionId: string, record: CompactRecord): Promise<void> {
    const session = this.repository.getSession(sessionId);
    if (!session) return;
    this.repository.saveSession({
      ...session,
      summary: record.summary || session.summary,
      summaryUpdatedAt: record.occurredAt,
      updatedAt: record.occurredAt,
    });
    this.repository.appendAuditLog({
      id: createId("audit"),
      userId: session.createdBy,
      action: "session.compacted",
      targetType: "session",
      targetId: sessionId,
      metadata: record.metadata,
      createdAt: record.occurredAt,
    });
  }

  async recordToolInventory(toolName: string, serverName: string | null): Promise<void> {
    const tools = parseStringArray(this.repository.getMeta("tool_inventory.tools"));
    const servers = parseStringArray(this.repository.getMeta("tool_inventory.servers"));
    if (!tools.includes(toolName)) tools.push(toolName);
    if (serverName && !servers.includes(serverName)) servers.push(serverName);
    this.repository.setMeta("tool_inventory.tools", JSON.stringify(tools.sort()));
    this.repository.setMeta("tool_inventory.servers", JSON.stringify(servers.sort()));
  }

  async updatePlan(sessionId: string, plan: RuntimePlan): Promise<void> {
    this.repository.setMeta(`session_plan.${sessionId}`, JSON.stringify(plan));
  }
}

export function readToolInventory(repository: PersistenceRepository): { tools: string[]; servers: string[] } {
  return {
    tools: parseStringArray(repository.getMeta("tool_inventory.tools")),
    servers: parseStringArray(repository.getMeta("tool_inventory.servers")),
  };
}

export function readSessionPlan(repository: PersistenceRepository, sessionId: string): RuntimePlan | null {
  const raw = repository.getMeta(`session_plan.${sessionId}`);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as RuntimePlan;
    return Array.isArray(value.items) ? value : null;
  } catch {
    return null;
  }
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

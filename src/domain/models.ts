export type Timestamp = number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type SystemRole = "admin" | "member";
export type UserStatus = "active" | "disabled";
export type TeamRole = "owner" | "admin" | "member" | "viewer";
export type WorkspaceMode = "shared" | "isolated";
export type AgentStatus = "idle" | "queued" | "running" | "waiting" | "offline" | "error";
export type SessionVisibility = "private" | "team";
export type SessionStatus =
  | "idle"
  | "queued"
  | "running"
  | "compacting"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";
export type TurnStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";
export type MessageSenderType = "user" | "agent" | "system" | "tool";
export type PermissionType = "platform_gate" | "mcp_tool";
export type PermissionRisk = "low" | "medium" | "high" | "critical";
export type PermissionStatus = "pending" | "approved" | "rejected" | "expired" | "stale";
export type PermissionDecision = "allow_once" | "allow_always_tool" | "allow_always_server" | "rejected";
export type FileChangeType = "created" | "modified" | "deleted" | "renamed";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string;
  email: string;
  role: SystemRole;
  status: UserStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export interface AuthSession {
  token: string;
  userId: string;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  lastSeenAt: Timestamp;
}

export interface Team {
  id: string;
  name: string;
  workspacePath: string;
  workspaceMode: WorkspaceMode;
  runtimeDefaults: ClaudeRuntimeDefaults;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Per-team overrides for non-sensitive runtime policy only. */
export interface ClaudeRuntimeDefaults {
  modelContextTokens?: number;
  autoCompactRatio?: number;
  autoCompactEnabled?: boolean;
  mcpToolAllowlist?: string[];
}

export interface TeamMember {
  teamId: string;
  userId: string;
  role: TeamRole;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Reusable, non-secret team defaults. Workspace paths are intentionally absent. */
export interface TeamConfigTemplate {
  id: string;
  name: string;
  description: string;
  workspaceMode: WorkspaceMode;
  modelContextTokens: number;
  autoCompactRatio: number;
  autoCompactEnabled: boolean;
  mcpToolAllowlist: string[];
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Agent {
  id: string;
  teamId: string | null;
  name: string;
  type: "claude_code";
  command: string;
  enabled: boolean;
  status: AgentStatus;
  metadata: JsonObject;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ToolApprovals {
  onceTools: string[];
  alwaysTools: string[];
  alwaysServers: string[];
}

export interface ConversationSession {
  id: string;
  teamId: string;
  agentId: string;
  createdBy: string;
  title: string;
  summary: string | null;
  summaryUpdatedAt: Timestamp | null;
  visibility: SessionVisibility;
  status: SessionStatus;
  cwd: string;
  claudeSessionId: string | null;
  toolApprovals: ToolApprovals;
  archivedAt: Timestamp | null;
  pinnedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Turn {
  id: string;
  sessionId: string;
  requestedByUserId: string | null;
  status: TurnStatus;
  prompt: string;
  retryOfMessageId: string | null;
  claudeSessionId: string | null;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  stopReason: string | null;
  error: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Message {
  id: string;
  sessionId: string;
  senderType: MessageSenderType;
  senderId: string | null;
  content: string;
  metadata: JsonObject;
  createdAt: Timestamp;
  updatedAt: Timestamp | null;
}

export interface Permission {
  id: string;
  sessionId: string;
  agentId: string;
  requestedByUserId: string;
  type: PermissionType;
  risk: PermissionRisk;
  summary: string;
  payload: string;
  turnId: string | null;
  status: PermissionStatus;
  expiresAt: Timestamp;
  decidedBy: string | null;
  decidedAt: Timestamp | null;
  decision: PermissionDecision | null;
  toolName: string | null;
  serverName: string | null;
  toolInput: JsonObject;
  toolUseId: string | null;
  controlRequestId: string | null;
  sdkPermission: boolean;
  permissionSuggestions: JsonValue[];
  reason: string | null;
  fallbackResume: boolean;
  metadata: JsonObject;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface FileChange {
  id: string;
  sessionId: string;
  turnId: string | null;
  path: string;
  previousPath: string | null;
  changeType: FileChangeType;
  additions: number | null;
  deletions: number | null;
  metadata: JsonObject;
  createdAt: Timestamp;
}

export interface AuditLog {
  id: string;
  userId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata: JsonObject;
  createdAt: Timestamp;
}

export interface ClaudeConfig {
  command: string;
  args: string;
  workspaceRoot: string;
  modelContextTokens: number;
  autoCompactRatio: number;
  autoCompactEnabled: boolean;
  mcpToolAllowlist: string[];
  enabled: boolean;
  available: boolean;
  version: string;
  latencyMs: number;
  authenticated: boolean;
  lastCheckAt: Timestamp | null;
  healthMessage: string | null;
  updatedAt: Timestamp;
}

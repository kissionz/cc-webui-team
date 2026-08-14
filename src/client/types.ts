export type AppView = "teams" | "team" | "lineage" | "settings" | "sync" | "users" | "audit" | "permissions";
export type AppDirectory = "teams" | "lineage" | "system";
export type SystemRole = "admin" | "member";
export type TeamRole = "owner" | "admin" | "member" | "viewer";
export type SessionStatus = "idle" | "queued" | "running" | "compacting" | "waiting_permission" | "completed" | "failed" | "stopped" | "interrupted";
export type SessionVisibility = "private" | "team";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "stale";
export type SenderType = "user" | "agent" | "tool" | "system";

export interface User { id: string; username: string; displayName: string; email?: string; role: SystemRole; status: "active" | "disabled" }
export interface Team { id: string; name: string; workspacePath: string; updatedAt: number }
export interface Member { teamId: string; userId: string; role: TeamRole }
export interface Agent { id: string; teamId: string | null; name: string; command: string; status?: "idle" | "running" | "waiting" }
export interface ToolApprovals { alwaysTools?: string[]; alwaysServers?: string[]; onceTools?: string[] }
export interface PlanItem { id?: string; content?: string; activeForm?: string; status?: "pending" | "in_progress" | "completed" | "deleted" }
export interface Session { id: string; teamId: string; agentId?: string; title?: string; status: SessionStatus; visibility?: SessionVisibility; createdBy: string; createdAt: number; updatedAt: number; archivedAt?: number | null; archived?: boolean; plan?: PlanItem[]; toolApprovals?: ToolApprovals }
export interface MessageMetadata { type?: string; turnId?: string; guidance?: boolean; interrupt?: boolean; items?: PlanItem[]; status?: string; name?: string; permissionId?: string; claudeSessionId?: string; serverName?: string; toolName?: string; durationMs?: number; waitedSeconds?: number; code?: number }
export interface Message { id: string; sessionId: string; senderId: string | null; senderType: SenderType; content: string; createdAt: number; updatedAt?: number | null; metadata?: MessageMetadata }
export interface Permission { id: string; sessionId: string; requestedByUserId: string; type: string; status: ApprovalStatus; risk?: string; summary?: string; reason?: string; expiresAt: number; serverName?: string | null; toolInput?: Record<string, unknown>; payload?: unknown }
export interface FileChange { sessionId: string; changeType: string; path: string; createdAt: number }
export interface AuditLog { id?: string; action: string; userId: string | null; targetType?: string; targetId?: string; createdAt: number }
export interface ClaudeConfig { command: string; args: string; workspaceRoot: string; modelContextTokens: number; autoCompactRatio: number; autoCompactEnabled: boolean; mcpToolAllowlist: string[]; enabled: boolean; available: boolean; version?: string; latencyMs?: number; authenticated?: boolean; lastCheckAt?: number | null; message?: string | null }
export interface ServerInfo { appVersion?: string; nodeVersion?: string; sdkPackage?: string; startedAt?: number; dataDir?: string; workspaceRoot?: string }
export interface ToolInventory { tools: string[]; servers: string[] }
export interface PaginationState { nextCursor: string | null; loading: boolean; initialized: boolean }
export interface Toast { id: number; message: string; tone: "success" | "error" | "info" }
export interface AppState { currentUserId: string | null; activeView: AppView; selectedTeamId: string; selectedSessionId: string; sidebarCollapsed: boolean; sessionMemberFilter: string; sessionSearch: string; sessionStatusFilter: "all" | SessionStatus; sessionArchiveFilter: "active" | "archived" | "all"; teamRailOpen: boolean; rightRailOpen: boolean; mobileNavOpen: boolean; allowedDirectories: AppDirectory[]; roleDirectoryPermissions: Record<SystemRole, AppDirectory[]>; users: User[]; teams: Team[]; members: Member[]; agents: Agent[]; sessions: Session[]; messages: Message[]; permissions: Permission[]; fileChanges: FileChange[]; auditLogs: AuditLog[]; claudeConfig: ClaudeConfig; serverInfo: ServerInfo; toolInventory: ToolInventory; sessionPagination: PaginationState; messagePagination: Record<string, PaginationState>; toasts: Toast[] }
export interface RealtimeEvent { type: string; sessionId?: string; messageId?: string; text?: string; status?: SessionStatus; userId?: string; teamId?: string; message?: Message; session?: Session; permission?: Permission; team?: Team; member?: Member; agent?: Agent; plan?: PlanItem[] }
export interface AuditFilters { userId?: string; action?: string; targetType?: string; targetId?: string }
export interface AdminMetrics { sampledAt?: number; sessions?: { queued?: number; running?: number; failed?: number; total?: number }; runtime?: { queued?: number; running?: number; waitingPermission?: number; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; totalCostUsd?: number; averageTurnDurationMs?: number | null }; sse?: { clients?: number; eventsBuffered?: number; connected?: boolean }; database?: { sizeBytes?: number; walBytes?: number; writeLatencyMs?: number | null }; backup?: { enabled?: boolean; running?: boolean; lastCompletedAt?: number | null; lastBackupBytes?: number | null } | null }
export interface TeamTemplate {
  id: string;
  name: string;
  description?: string;
  workspaceMode: "shared" | "isolated";
  modelContextTokens: number;
  autoCompactRatio: number;
  autoCompactEnabled: boolean;
  mcpToolAllowlist: string[];
  createdAt?: number;
  updatedAt?: number;
}
export interface MaxComputeProjectView { name: string; status: string; region: string }
export interface MaxComputeConfigView { enabled: boolean; command?: string; args?: string; project: string; collectionMode: "all" | "selected"; collectionProjects: string[]; discoveredProjects: MaxComputeProjectView[]; endpoint?: string; credentialConfigured?: boolean; accessKeyIdMasked?: string | null; credentialUpdatedAt?: number | null; scheduleTime: string; timezone: "Asia/Shanghai"; lastStartedAt?: number | null; lastCompletedAt?: number | null; lastStatus: "idle" | "running" | "success" | "failed"; lastError?: string | null; lastDataDate?: string | null; nextRunAt?: number | null; updatedAt: number }
export interface LineageTable { id: string; project: string; name: string; type: string; comment: string; ownerId?: string | null; ownerName?: string | null; isPartitioned: boolean; createTime?: number | null; lastModifiedTime?: number | null; lastAccessTime?: number | null; dataLength?: number | null; partitionCount: number; lifecycle?: number | null; storageTier?: string | null; clusterType?: string | null; numberBuckets?: number | null; hasPrimaryKey: boolean; isTransactional: boolean; isDeltaTable: boolean; tableStorage?: string | null; tableFormat?: string | null; lastScheduleTime?: number | null; lastScheduleStatus?: string | null; lastTaskName?: string | null; lastInstanceId?: string | null; scheduleOwner?: string | null; scheduleNodeId?: string | null; scheduleNodeName?: string | null; scheduleOnDuty?: string | null; lastBizDate?: string | null; accessCount: number; accessBytes: number; createdAt: number; updatedAt: number }
export interface LineageColumn { tableId: string; name: string; ordinalPosition: number; dataType: string; comment: string; nullable: boolean; partitionKey: boolean; primaryKey: boolean; updatedAt: number }
export interface LineageEdge { sourceTableId: string; targetTableId: string; firstSeenAt: number; lastSeenAt: number; occurrenceCount: number; lastInstanceId?: string | null; lastTaskName?: string | null; lastOwnerName?: string | null; lastNodeId?: string | null; lastNodeName?: string | null; lastOnDuty?: string | null; depth?: number; collapsed?: number }
export interface LineageGraph { rootId: string; scope: string; direction: string; tables: LineageTable[]; edges: LineageEdge[]; truncated: boolean }
export interface LineageSyncRun { id: string; trigger: "schedule" | "manual"; requestedBy?: string | null; dataDate: string; status: "running" | "success" | "failed"; projectsProcessed: number; tablesProcessed: number; columnsProcessed: number; jobsProcessed: number; edgesProcessed: number; error?: string | null; startedAt: number; completedAt?: number | null }
export interface ColumnLineageEvidence { id: string; path: string; startLine: number; endLine: number; language: string; snippet: string; explanation: string }
export interface ColumnLineageRelation { sourceTable: string; sourceColumn: string; targetTable: string; targetColumn: string; transformation: string; confidence: "high" | "medium" | "low"; evidenceIds: string[] }
export interface ColumnLineageResult { status: "found" | "partial" | "not_found"; table: string; column: string; summary: string; relations: ColumnLineageRelation[]; evidence: ColumnLineageEvidence[]; warnings: string[] }
export interface SessionGroup { id: string; label: string; minimum: number; defaultExpanded: boolean; sessions: Session[] }
export interface MessageTurn { id: string; user?: Message; messages: Message[] }
export interface ScrollPosition { top: number; left: number; distanceFromBottom: number }
export interface FocusInfo { selector: string; start: number | null; end: number | null }
export interface UiSnapshot { view?: AppView; sessionId?: string; activeInfo?: FocusInfo | null; streamWasNearBottom?: boolean; scrolls?: Record<string, ScrollPosition> }
export interface PermissionQuestionOption { label?: string; description?: string }
export interface PermissionQuestion { header?: string; question?: string; options?: PermissionQuestionOption[] }
export interface PermissionField { key: string; label: string; value: unknown; tone?: string; html?: boolean }
export type HtmlValue = string | number | boolean | null | undefined | object;
export type LooseRecord = Record<string, unknown>;

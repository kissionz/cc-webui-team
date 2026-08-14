import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { digestSessionToken } from "../auth/session-token.js";
import type {
  Agent,
  AppDirectory,
  AuditLog,
  AuthSession,
  ClaudeConfig,
  ConversationSession,
  FileChange,
  JsonObject,
  JsonValue,
  LineageColumn,
  LineageEdge,
  LineageSyncRun,
  LineageTaskHistory,
  LineageTable,
  MaxComputeConfig,
  Message,
  Page,
  PageRequest,
  Permission,
  PermissionDecision,
  PermissionStatus,
  Team,
  TeamConfigTemplate,
  TeamMember,
  Turn,
  User,
  SystemRole,
} from "../domain/index.js";
import { decodeCursor, encodeCursor, pageLimit } from "../domain/index.js";
import { migrateSchema } from "./schema.js";

type SqlValue = string | number | bigint | Buffer | null;
type Row = Record<string, SqlValue>;

export interface RepositoryOptions {
  databasePath: string;
  legacyJsonPath?: string;
  busyTimeoutMs?: number;
  now?: () => number;
}

export interface InitializeResult {
  importedLegacyJson: boolean;
  legacyBackupPath: string | null;
  reconciliation: ReconciliationResult;
}

export interface ReconciliationResult {
  interruptedSessions: number;
  interruptedTurns: number;
  stalePermissions: number;
  expiredPermissions: number;
}

export interface SessionPageRequest extends PageRequest {
  teamIds?: string[];
  createdBy?: string;
  statuses?: ConversationSession["status"][];
  includeArchived?: boolean;
  archivedOnly?: boolean;
  visibleToUserId?: string;
}

export interface AuditPageRequest extends PageRequest {
  userId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}

export interface SearchRequest extends PageRequest {
  query: string;
  teamIds?: string[];
  sessionId?: string;
}

export interface SearchHit {
  kind: "session" | "message";
  sessionId: string;
  messageId: string | null;
  title: string;
  excerpt: string;
  rank: number;
  timestamp: number;
}

export type DecidePermissionResult =
  | { outcome: "decided"; permission: Permission }
  | { outcome: "not_found" }
  | { outcome: "already_decided"; permission: Permission }
  | { outcome: "expired"; permission: Permission };

export class PersistenceRepository {
  readonly database: Database.Database;
  private readonly now: () => number;
  private readonly options: RepositoryOptions;

  constructor(options: RepositoryOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.database = new Database(options.databasePath);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = NORMAL");
    this.database.pragma(`busy_timeout = ${Math.max(1, options.busyTimeoutMs ?? 5_000)}`);
    migrateSchema(this.database);
  }

  static async open(options: RepositoryOptions): Promise<{ repository: PersistenceRepository; result: InitializeResult }> {
    await mkdir(dirname(options.databasePath), { recursive: true });
    const repository = new PersistenceRepository(options);
    try {
      const migration = await repository.importLegacyJsonOnce();
      const reconciliation = repository.reconcileAfterRestart();
      return { repository, result: { ...migration, reconciliation } };
    } catch (error) {
      repository.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  private getOne(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.database.prepare(sql).get(...params) as Row | undefined;
  }

  private getMany(sql: string, ...params: SqlValue[]): Row[] {
    return this.database.prepare(sql).all(...params) as Row[];
  }

  getUser(id: string): User | null {
    const row = this.getOne("SELECT * FROM users WHERE id = ?", id);
    return row ? userFromRow(row) : null;
  }

  getUserByUsername(username: string): User | null {
    const row = this.getOne("SELECT * FROM users WHERE username = ? COLLATE NOCASE", username);
    return row ? userFromRow(row) : null;
  }

  listUsers(): User[] {
    return this.getMany("SELECT * FROM users ORDER BY display_name COLLATE NOCASE, id").map(userFromRow);
  }

  saveUser(user: User): void {
    this.database.prepare(`
      INSERT INTO users(id, username, password_hash, display_name, email, role, status, created_at, updated_at)
      VALUES (@id, @username, @passwordHash, @displayName, @email, @role, @status, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username, password_hash=excluded.password_hash,
        display_name=excluded.display_name, email=excluded.email, role=excluded.role, status=excluded.status,
        updated_at=excluded.updated_at
    `).run(user);
  }

  saveAuthSession(session: AuthSession): void {
    this.database.prepare(`
      INSERT INTO auth_sessions(token, user_id, expires_at, created_at, last_seen_at)
      VALUES (@token, @userId, @expiresAt, @createdAt, @lastSeenAt)
      ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id, expires_at=excluded.expires_at,
        last_seen_at=excluded.last_seen_at
    `).run(session);
  }

  getAuthSession(token: string, at = this.now()): AuthSession | null {
    const row = this.getOne("SELECT * FROM auth_sessions WHERE token = ? AND expires_at > ?", token, at);
    return row ? authSessionFromRow(row) : null;
  }

  deleteAuthSession(token: string): boolean {
    return this.database.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token).changes > 0;
  }

  revokeAuthSessionsForUser(userId: string, exceptToken?: string): number {
    const result = exceptToken
      ? this.database.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND token <> ?").run(userId, exceptToken)
      : this.database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    return result.changes;
  }

  pruneExpiredAuthSessions(at = this.now()): number {
    return this.database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(at).changes;
  }

  saveTeam(team: Team): void {
    const runtimeDefaults = validatedRuntimeDefaults(team.runtimeDefaults);
    this.database.prepare(`
      INSERT INTO teams(id, name, workspace_path, workspace_mode, runtime_defaults_json, created_by, created_at, updated_at)
      VALUES (@id, @name, @workspacePath, @workspaceMode, @runtimeDefaultsJson, @createdBy, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, workspace_path=excluded.workspace_path,
        workspace_mode=excluded.workspace_mode, runtime_defaults_json=excluded.runtime_defaults_json,
        updated_at=excluded.updated_at
    `).run({ ...team, runtimeDefaultsJson: json(runtimeDefaults) });
  }

  getTeam(id: string): Team | null {
    const row = this.getOne("SELECT * FROM teams WHERE id = ?", id);
    return row ? teamFromRow(row) : null;
  }

  listTeamsForUser(userId: string, systemAdmin = false): Team[] {
    const sql = systemAdmin
      ? "SELECT * FROM teams ORDER BY name COLLATE NOCASE, id"
      : `SELECT t.* FROM teams t JOIN team_members m ON m.team_id=t.id
         WHERE m.user_id=? ORDER BY t.name COLLATE NOCASE, t.id`;
    return this.getMany(sql, ...(systemAdmin ? [] : [userId])).map(teamFromRow);
  }

  deleteTeam(id: string): boolean {
    return this.database.prepare("DELETE FROM teams WHERE id = ?").run(id).changes > 0;
  }

  saveTeamMember(member: TeamMember): void {
    this.database.prepare(`
      INSERT INTO team_members(team_id, user_id, role, created_at, updated_at)
      VALUES (@teamId, @userId, @role, @createdAt, @updatedAt)
      ON CONFLICT(team_id, user_id) DO UPDATE SET role=excluded.role, updated_at=excluded.updated_at
    `).run(member);
  }

  getTeamRole(teamId: string, userId: string): TeamMember["role"] | null {
    const row = this.getOne("SELECT role FROM team_members WHERE team_id=? AND user_id=?", teamId, userId);
    return row ? String(row.role) as TeamMember["role"] : null;
  }

  listTeamMembers(teamId: string): TeamMember[] {
    return this.getMany("SELECT * FROM team_members WHERE team_id=? ORDER BY created_at, user_id", teamId).map(teamMemberFromRow);
  }

  removeTeamMember(teamId: string, userId: string): boolean {
    return this.database.prepare("DELETE FROM team_members WHERE team_id=? AND user_id=?").run(teamId, userId).changes > 0;
  }

  saveTeamConfigTemplate(template: TeamConfigTemplate): void {
    this.database.prepare(`
      INSERT INTO team_config_templates(id, name, description, workspace_mode, model_context_tokens,
        auto_compact_ratio, auto_compact_enabled, mcp_tool_allowlist_json, created_by, created_at, updated_at)
      VALUES (@id, @name, @description, @workspaceMode, @modelContextTokens, @autoCompactRatio,
        @autoCompactEnabled, @mcpToolAllowlistJson, @createdBy, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
        workspace_mode=excluded.workspace_mode, model_context_tokens=excluded.model_context_tokens,
        auto_compact_ratio=excluded.auto_compact_ratio, auto_compact_enabled=excluded.auto_compact_enabled,
        mcp_tool_allowlist_json=excluded.mcp_tool_allowlist_json, updated_at=excluded.updated_at
    `).run({
      ...template,
      autoCompactEnabled: boolInt(template.autoCompactEnabled),
      mcpToolAllowlistJson: json(template.mcpToolAllowlist),
    });
  }

  getTeamConfigTemplate(id: string): TeamConfigTemplate | null {
    const row = this.getOne("SELECT * FROM team_config_templates WHERE id=?", id);
    return row ? teamConfigTemplateFromRow(row) : null;
  }

  listTeamConfigTemplates(): TeamConfigTemplate[] {
    return this.getMany("SELECT * FROM team_config_templates ORDER BY updated_at DESC, id DESC").map(teamConfigTemplateFromRow);
  }

  deleteTeamConfigTemplate(id: string): boolean {
    return this.database.prepare("DELETE FROM team_config_templates WHERE id=?").run(id).changes > 0;
  }

  countMetrics(): {
    users: number;
    teams: number;
    sessions: Record<string, number>;
    pendingPermissions: number;
    messages: number;
  } {
    const scalar = (sql: string): number => Number(this.getOne(sql)?.count ?? 0);
    const sessionRows = this.getMany("SELECT status, count(*) count FROM sessions GROUP BY status");
    const sessions: Record<string, number> = {};
    for (const row of sessionRows) sessions[str(row.status!)] = num(row.count!);
    return {
      users: scalar("SELECT count(*) count FROM users WHERE status='active'"),
      teams: scalar("SELECT count(*) count FROM teams"),
      sessions,
      pendingPermissions: scalar("SELECT count(*) count FROM permissions WHERE status='pending'"),
      messages: scalar("SELECT count(*) count FROM messages"),
    };
  }

  saveAgent(agent: Agent): void {
    this.database.prepare(`
      INSERT INTO agents(id, team_id, name, type, command, enabled, status, metadata_json, created_at, updated_at)
      VALUES (@id, @teamId, @name, @type, @command, @enabled, @status, @metadataJson, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET team_id=excluded.team_id, name=excluded.name, command=excluded.command,
        enabled=excluded.enabled, status=excluded.status, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at
    `).run({ ...agent, enabled: boolInt(agent.enabled), metadataJson: json(agent.metadata) });
  }

  getAgent(id: string): Agent | null {
    const row = this.getOne("SELECT * FROM agents WHERE id=?", id);
    return row ? agentFromRow(row) : null;
  }

  listAgents(teamIds?: string[]): Agent[] {
    const filter = inFilter("team_id", teamIds, true);
    return this.getMany(`SELECT * FROM agents ${filter.sql} ORDER BY created_at, id`, ...filter.params).map(agentFromRow);
  }

  createSession(session: ConversationSession): void {
    this.insertSession(session);
  }

  saveSession(session: ConversationSession): void {
    this.database.prepare(`
      INSERT INTO sessions(id, team_id, agent_id, created_by, title, summary, summary_updated_at, visibility,
        status, cwd, claude_session_id, tool_approvals_json, archived_at, pinned_at, created_at, updated_at)
      VALUES (@id, @teamId, @agentId, @createdBy, @title, @summary, @summaryUpdatedAt, @visibility,
        @status, @cwd, @claudeSessionId, @toolApprovalsJson, @archivedAt, @pinnedAt, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, summary=excluded.summary,
        summary_updated_at=excluded.summary_updated_at, visibility=excluded.visibility, status=excluded.status,
        cwd=excluded.cwd, claude_session_id=excluded.claude_session_id,
        tool_approvals_json=excluded.tool_approvals_json, archived_at=excluded.archived_at,
        pinned_at=excluded.pinned_at, updated_at=excluded.updated_at
    `).run(sessionParams(session));
  }

  private insertSession(session: ConversationSession): void {
    this.database.prepare(`
      INSERT INTO sessions(id, team_id, agent_id, created_by, title, summary, summary_updated_at, visibility,
        status, cwd, claude_session_id, tool_approvals_json, archived_at, pinned_at, created_at, updated_at)
      VALUES (@id, @teamId, @agentId, @createdBy, @title, @summary, @summaryUpdatedAt, @visibility,
        @status, @cwd, @claudeSessionId, @toolApprovalsJson, @archivedAt, @pinnedAt, @createdAt, @updatedAt)
    `).run(sessionParams(session));
  }

  getSession(id: string): ConversationSession | null {
    const row = this.getOne("SELECT * FROM sessions WHERE id=?", id);
    return row ? sessionFromRow(row) : null;
  }

  deleteSession(id: string): boolean {
    return this.database.prepare("DELETE FROM sessions WHERE id=?").run(id).changes > 0;
  }

  listSessions(request: SessionPageRequest = {}): Page<ConversationSession> {
    const limit = pageLimit(request.limit);
    const cursor = decodeCursor(request.cursor);
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    addInClause(clauses, params, "team_id", request.teamIds);
    if (request.createdBy) { clauses.push("created_by=?"); params.push(request.createdBy); }
    addInClause(clauses, params, "status", request.statuses);
    if (request.archivedOnly) clauses.push("archived_at IS NOT NULL");
    else if (!request.includeArchived) clauses.push("archived_at IS NULL");
    if (request.visibleToUserId) {
      clauses.push("(visibility='team' OR created_by=?)");
      params.push(request.visibleToUserId);
    }
    if (cursor) {
      clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      params.push(cursor.timestamp, cursor.timestamp, cursor.id);
    }
    const rows = this.getMany(
      `SELECT * FROM sessions ${where(clauses)} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    return page(rows, limit, sessionFromRow, "updated_at");
  }

  searchSessions(request: SessionPageRequest & { query: string }): Page<ConversationSession> {
    const query = ftsQuery(request.query);
    if (!query) return { items: [], nextCursor: null };
    // FTS5's unicode tokenizer does not reliably split adjacent CJK characters.
    // Keep FTS for ranked/token search, then add a bound substring fallback so short
    // Chinese queries and intentional substrings still behave as users expect.
    const substring = request.query.trim();
    const limit = pageLimit(request.limit);
    const cursor = decodeCursor(request.cursor);
    const clauses = [
      `(rowid IN (SELECT rowid FROM session_search WHERE session_search MATCH ?)
        OR id IN (SELECT session_id FROM messages WHERE rowid IN
          (SELECT rowid FROM message_search WHERE message_search MATCH ?))
        OR instr(title, ?) > 0
        OR instr(COALESCE(summary, ''), ?) > 0
        OR id IN (SELECT session_id FROM messages WHERE instr(content, ?) > 0))`,
    ];
    const params: SqlValue[] = [query, query, substring, substring, substring];
    addInClause(clauses, params, "team_id", request.teamIds);
    if (request.createdBy) { clauses.push("created_by=?"); params.push(request.createdBy); }
    addInClause(clauses, params, "status", request.statuses);
    if (request.archivedOnly) clauses.push("archived_at IS NOT NULL");
    else if (!request.includeArchived) clauses.push("archived_at IS NULL");
    if (request.visibleToUserId) { clauses.push("(visibility='team' OR created_by=?)"); params.push(request.visibleToUserId); }
    if (cursor) {
      clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      params.push(cursor.timestamp, cursor.timestamp, cursor.id);
    }
    const rows = this.getMany(
      `SELECT * FROM sessions ${where(clauses)} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    return page(rows, limit, sessionFromRow, "updated_at");
  }

  createTurn(turn: Turn): void {
    this.database.prepare(`
      INSERT INTO turns(id, session_id, requested_by_user_id, status, prompt, retry_of_message_id,
        claude_session_id, started_at, finished_at, stop_reason, error, created_at, updated_at)
      VALUES (@id, @sessionId, @requestedByUserId, @status, @prompt, @retryOfMessageId,
        @claudeSessionId, @startedAt, @finishedAt, @stopReason, @error, @createdAt, @updatedAt)
    `).run(turn);
  }

  saveTurn(turn: Turn): void {
    this.database.prepare(`UPDATE turns SET status=@status, claude_session_id=@claudeSessionId,
      started_at=@startedAt, finished_at=@finishedAt, stop_reason=@stopReason, error=@error, updated_at=@updatedAt
      WHERE id=@id`).run(turn);
  }

  getTurn(id: string): Turn | null {
    const row = this.getOne("SELECT * FROM turns WHERE id=?", id);
    return row ? turnFromRow(row) : null;
  }

  getActiveTurn(sessionId: string): Turn | null {
    const row = this.getOne("SELECT * FROM turns WHERE session_id=? AND status IN ('queued','running','waiting_permission')", sessionId);
    return row ? turnFromRow(row) : null;
  }

  /** Ordered recovery source. Queued work survives crashes and is re-admitted at startup. */
  listQueuedTurns(): Turn[] {
    return this.getMany("SELECT * FROM turns WHERE status='queued' ORDER BY created_at, id").map(turnFromRow);
  }

  appendMessage(message: Message): void {
    this.database.prepare(`
      INSERT INTO messages(id, session_id, sender_type, sender_id, content, metadata_json, created_at, updated_at)
      VALUES (@id, @sessionId, @senderType, @senderId, @content, @metadataJson, @createdAt, @updatedAt)
    `).run({ ...message, metadataJson: json(message.metadata) });
  }

  saveMessage(message: Message): void {
    this.database.prepare("UPDATE messages SET content=@content, metadata_json=@metadataJson, updated_at=@updatedAt WHERE id=@id")
      .run({ ...message, metadataJson: json(message.metadata) });
  }

  getMessage(id: string): Message | null {
    const row = this.getOne("SELECT * FROM messages WHERE id=?", id);
    return row ? messageFromRow(row) : null;
  }

  listMessages(sessionId: string, request: PageRequest = {}): Page<Message> {
    const limit = pageLimit(request.limit);
    const cursor = decodeCursor(request.cursor);
    const params: SqlValue[] = [sessionId];
    let cursorSql = "";
    if (cursor) {
      cursorSql = "AND (created_at < ? OR (created_at = ? AND id < ?))";
      params.push(cursor.timestamp, cursor.timestamp, cursor.id);
    }
    const rows = this.getMany(
      `SELECT * FROM messages WHERE session_id=? ${cursorSql} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    return page(rows, limit, messageFromRow, "created_at");
  }

  createPermission(permission: Permission): void {
    this.database.prepare(`
      INSERT INTO permissions(id, session_id, agent_id, requested_by_user_id, type, risk, summary, payload,
        turn_id, status, expires_at, decided_by, decided_at, decision, tool_name, server_name, tool_input_json,
        tool_use_id, control_request_id, sdk_permission, permission_suggestions_json, reason, fallback_resume,
        metadata_json, created_at, updated_at)
      VALUES (@id, @sessionId, @agentId, @requestedByUserId, @type, @risk, @summary, @payload,
        @turnId, @status, @expiresAt, @decidedBy, @decidedAt, @decision, @toolName, @serverName, @toolInputJson,
        @toolUseId, @controlRequestId, @sdkPermission, @permissionSuggestionsJson, @reason, @fallbackResume,
        @metadataJson, @createdAt, @updatedAt)
    `).run(permissionParams(permission));
  }

  getPermission(id: string): Permission | null {
    const row = this.getOne("SELECT * FROM permissions WHERE id=?", id);
    return row ? permissionFromRow(row) : null;
  }

  listPermissions(sessionId: string, statuses?: PermissionStatus[]): Permission[] {
    const clauses = ["session_id=?"];
    const params: SqlValue[] = [sessionId];
    addInClause(clauses, params, "status", statuses);
    return this.getMany(`SELECT * FROM permissions ${where(clauses)} ORDER BY created_at DESC, id DESC`, ...params)
      .map(permissionFromRow);
  }

  decidePermissionAtomic(
    id: string,
    decidedBy: string,
    status: "approved" | "rejected",
    decision: PermissionDecision,
    at = this.now(),
  ): DecidePermissionResult {
    return this.transaction(() => {
      const before = this.getPermission(id);
      if (!before) return { outcome: "not_found" };
      if (before.status !== "pending") return { outcome: "already_decided", permission: before };
      if (before.expiresAt <= at) {
        this.database.prepare("UPDATE permissions SET status='expired', updated_at=? WHERE id=? AND status='pending'").run(at, id);
        return { outcome: "expired", permission: this.getPermission(id)! };
      }
      const changed = this.database.prepare(`
        UPDATE permissions SET status=?, decided_by=?, decided_at=?, decision=?, updated_at=?
        WHERE id=? AND status='pending' AND expires_at>?
      `).run(status, decidedBy, at, decision, at, id, at).changes;
      if (changed !== 1) {
        const current = this.getPermission(id)!;
        return current.status === "expired"
          ? { outcome: "expired", permission: current }
          : { outcome: "already_decided", permission: current };
      }
      return { outcome: "decided", permission: this.getPermission(id)! };
    });
  }

  expirePermissions(at = this.now()): number {
    return this.database.prepare("UPDATE permissions SET status='expired', updated_at=? WHERE status='pending' AND expires_at<=?")
      .run(at, at).changes;
  }

  expirePermission(id: string, at = this.now()): Permission | null {
    this.database.prepare("UPDATE permissions SET status='expired', updated_at=? WHERE id=? AND status='pending'")
      .run(at, id);
    return this.getPermission(id);
  }

  appendFileChange(change: FileChange): void {
    this.database.prepare(`
      INSERT INTO file_changes(id, session_id, turn_id, path, previous_path, change_type, additions, deletions,
        metadata_json, created_at)
      VALUES (@id, @sessionId, @turnId, @path, @previousPath, @changeType, @additions, @deletions,
        @metadataJson, @createdAt)
    `).run({ ...change, metadataJson: json(change.metadata) });
  }

  listFileChanges(sessionId: string): FileChange[] {
    return this.getMany("SELECT * FROM file_changes WHERE session_id=? ORDER BY created_at DESC, id DESC", sessionId)
      .map(fileChangeFromRow);
  }

  appendAuditLog(log: AuditLog): void {
    this.database.prepare(`INSERT INTO audit_logs(id, user_id, action, target_type, target_id, metadata_json, created_at)
      VALUES (@id, @userId, @action, @targetType, @targetId, @metadataJson, @createdAt)`)
      .run({ ...log, metadataJson: json(log.metadata) });
  }

  listAuditLogs(request: AuditPageRequest = {}): Page<AuditLog> {
    const limit = pageLimit(request.limit);
    const cursor = decodeCursor(request.cursor);
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    for (const [column, value] of [["user_id", request.userId], ["action", request.action], ["target_type", request.targetType], ["target_id", request.targetId]] as const) {
      if (value) { clauses.push(`${column}=?`); params.push(value); }
    }
    if (cursor) {
      clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(cursor.timestamp, cursor.timestamp, cursor.id);
    }
    const rows = this.getMany(`SELECT * FROM audit_logs ${where(clauses)} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, limit + 1);
    return page(rows, limit, auditFromRow, "created_at");
  }

  pruneAuditLogs(keep: number): number {
    const safeKeep = Math.max(0, Math.trunc(keep));
    return this.database.prepare(`DELETE FROM audit_logs WHERE rowid IN (
      SELECT rowid FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?
    )`).run(safeKeep).changes;
  }

  getClaudeConfig(): ClaudeConfig | null {
    const row = this.getOne("SELECT * FROM claude_config WHERE singleton=1");
    return row ? configFromRow(row) : null;
  }

  saveClaudeConfig(config: ClaudeConfig): void {
    this.database.prepare(`
      INSERT INTO claude_config(singleton, command, args, workspace_root, model_context_tokens,
        auto_compact_ratio, auto_compact_enabled, mcp_tool_allowlist_json, enabled, available, version,
        latency_ms, authenticated, last_check_at, health_message, updated_at)
      VALUES (1, @command, @args, @workspaceRoot, @modelContextTokens, @autoCompactRatio,
        @autoCompactEnabled, @mcpToolAllowlistJson, @enabled, @available, @version, @latencyMs,
        @authenticated, @lastCheckAt, @healthMessage, @updatedAt)
      ON CONFLICT(singleton) DO UPDATE SET command=excluded.command, args=excluded.args,
        workspace_root=excluded.workspace_root, model_context_tokens=excluded.model_context_tokens,
        auto_compact_ratio=excluded.auto_compact_ratio, auto_compact_enabled=excluded.auto_compact_enabled,
        mcp_tool_allowlist_json=excluded.mcp_tool_allowlist_json, enabled=excluded.enabled,
        available=excluded.available, version=excluded.version, latency_ms=excluded.latency_ms,
        authenticated=excluded.authenticated, last_check_at=excluded.last_check_at,
        health_message=excluded.health_message, updated_at=excluded.updated_at
    `).run({
      ...config,
      autoCompactEnabled: boolInt(config.autoCompactEnabled),
      mcpToolAllowlistJson: json(config.mcpToolAllowlist),
      enabled: boolInt(config.enabled),
      available: boolInt(config.available),
      authenticated: boolInt(config.authenticated),
    });
  }

  getMaxComputeConfig(): MaxComputeConfig | null {
    const row = this.getOne("SELECT * FROM maxcompute_config WHERE singleton=1");
    return row ? maxComputeConfigFromRow(row) : null;
  }

  saveMaxComputeConfig(config: MaxComputeConfig): void {
    this.database.prepare(`
      INSERT INTO maxcompute_config(singleton, enabled, command, args, project, schedule_time, timezone,
        last_started_at, last_completed_at, last_status, last_error, last_data_date, next_run_at, updated_at,
        endpoint, credential_ciphertext, credential_updated_at, collection_mode, collection_projects_json,
        discovered_projects_json)
      VALUES (1, @enabled, @command, @args, @project, @scheduleTime, @timezone, @lastStartedAt,
        @lastCompletedAt, @lastStatus, @lastError, @lastDataDate, @nextRunAt, @updatedAt,
        @endpoint, @credentialCiphertext, @credentialUpdatedAt, @collectionMode, @collectionProjectsJson,
        @discoveredProjectsJson)
      ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled, command=excluded.command,
        args=excluded.args, project=excluded.project, schedule_time=excluded.schedule_time,
        timezone=excluded.timezone, last_started_at=excluded.last_started_at,
        last_completed_at=excluded.last_completed_at, last_status=excluded.last_status,
        last_error=excluded.last_error, last_data_date=excluded.last_data_date,
        next_run_at=excluded.next_run_at, updated_at=excluded.updated_at,
        endpoint=excluded.endpoint, credential_ciphertext=excluded.credential_ciphertext,
        credential_updated_at=excluded.credential_updated_at, collection_mode=excluded.collection_mode,
        collection_projects_json=excluded.collection_projects_json,
        discovered_projects_json=excluded.discovered_projects_json
    `).run({
      ...config,
      enabled: boolInt(config.enabled),
      collectionProjectsJson: json(config.collectionProjects),
      discoveredProjectsJson: json(config.discoveredProjects),
    });
  }

  getDirectoryPermissions(role: SystemRole): AppDirectory[] {
    return this.getMany("SELECT directory_key FROM role_directory_permissions WHERE role=? AND visible=1 ORDER BY directory_key", role)
      .map((row) => str(row.directory_key!) as AppDirectory);
  }

  canAccessDirectory(role: SystemRole, directory: AppDirectory): boolean {
    return Boolean(this.getOne("SELECT 1 allowed FROM role_directory_permissions WHERE role=? AND directory_key=? AND visible=1", role, directory));
  }

  saveDirectoryPermissions(role: SystemRole, directories: readonly AppDirectory[], at = this.now()): void {
    const selected = new Set(directories);
    const statement = this.database.prepare(`INSERT INTO role_directory_permissions(role, directory_key, visible, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(role, directory_key) DO UPDATE SET visible=excluded.visible, updated_at=excluded.updated_at`);
    this.transaction(() => {
      for (const directory of ["teams", "lineage", "system"] as const) statement.run(role, directory, boolInt(selected.has(directory)), at);
    });
  }

  saveLineageTable(table: LineageTable): void {
    this.database.prepare(`
      INSERT INTO lineage_tables(id, project_name, table_name, table_type, table_comment, owner_id, owner_name,
        is_partitioned, create_time, last_modified_time, last_access_time, data_length, partition_count,
        lifecycle, storage_tier, cluster_type, number_buckets, has_primary_key, is_transactional, is_delta_table,
        table_storage, table_format, last_schedule_time, last_schedule_status, last_task_name, last_instance_id,
        schedule_owner, schedule_node_id, schedule_node_name, schedule_on_duty, last_biz_date, access_count,
        access_bytes, created_at, updated_at)
      VALUES (@id, @project, @name, @type, @comment, @ownerId, @ownerName, @isPartitioned, @createTime,
        @lastModifiedTime, @lastAccessTime, @dataLength, @partitionCount, @lifecycle, @storageTier,
        @clusterType, @numberBuckets, @hasPrimaryKey, @isTransactional, @isDeltaTable, @tableStorage,
        @tableFormat, @lastScheduleTime, @lastScheduleStatus, @lastTaskName, @lastInstanceId, @scheduleOwner,
        @scheduleNodeId, @scheduleNodeName, @scheduleOnDuty, @lastBizDate, @accessCount, @accessBytes,
        @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET project_name=excluded.project_name, table_name=excluded.table_name,
        table_type=excluded.table_type, table_comment=excluded.table_comment, owner_id=excluded.owner_id,
        owner_name=excluded.owner_name, is_partitioned=excluded.is_partitioned, create_time=excluded.create_time,
        last_modified_time=excluded.last_modified_time, last_access_time=excluded.last_access_time,
        data_length=excluded.data_length, partition_count=excluded.partition_count, lifecycle=excluded.lifecycle,
        storage_tier=excluded.storage_tier, cluster_type=excluded.cluster_type,
        number_buckets=excluded.number_buckets, has_primary_key=excluded.has_primary_key,
        is_transactional=excluded.is_transactional, is_delta_table=excluded.is_delta_table,
        table_storage=excluded.table_storage, table_format=excluded.table_format, updated_at=excluded.updated_at
    `).run(lineageTableParams(table));
  }

  ensureLineageTable(id: string, at = this.now()): LineageTable {
    const existing = this.getLineageTable(id);
    if (existing) return existing;
    const split = id.indexOf(".");
    const project = split > 0 ? id.slice(0, split) : "default";
    const name = split > 0 ? id.slice(split + 1) : id;
    const table: LineageTable = {
      id, project, name, type: "MANAGED_TABLE", comment: "", ownerId: null, ownerName: null,
      isPartitioned: false, createTime: null, lastModifiedTime: null, lastAccessTime: null,
      dataLength: null, partitionCount: 0, lifecycle: null, storageTier: null, clusterType: null,
      numberBuckets: null, hasPrimaryKey: false, isTransactional: false, isDeltaTable: false,
      tableStorage: null, tableFormat: null, lastScheduleTime: null, lastScheduleStatus: null,
      lastTaskName: null, lastInstanceId: null, scheduleOwner: null, scheduleNodeId: null,
      scheduleNodeName: null, scheduleOnDuty: null, lastBizDate: null, accessCount: 0,
      accessBytes: 0, createdAt: at, updatedAt: at,
    };
    this.saveLineageTable(table);
    return table;
  }

  getLineageTable(id: string): LineageTable | null {
    const row = this.getOne("SELECT * FROM lineage_tables WHERE id=?", id);
    return row ? lineageTableFromRow(row) : null;
  }

  searchLineageTables(query: string, limit = 20): LineageTable[] {
    const value = `%${query.trim().replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return this.getMany(`SELECT * FROM lineage_tables
      WHERE table_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR id LIKE ? ESCAPE '\\' COLLATE NOCASE
      ORDER BY CASE WHEN table_name = ? COLLATE NOCASE THEN 0 WHEN table_name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 1 ELSE 2 END,
        last_schedule_time DESC, table_name COLLATE NOCASE LIMIT ?`, value, value, query.trim(), `${query.trim()}%`, Math.max(1, Math.min(100, limit)))
      .map(lineageTableFromRow);
  }

  listLineageColumns(tableId: string): LineageColumn[] {
    return this.getMany("SELECT * FROM lineage_columns WHERE table_id=? ORDER BY ordinal_position, column_name", tableId)
      .map(lineageColumnFromRow);
  }

  countLineageRelations(tableId: string): { upstream: number; downstream: number } {
    const upstream = this.getOne("SELECT COUNT(*) count FROM lineage_edges WHERE target_table_id=?", tableId);
    const downstream = this.getOne("SELECT COUNT(*) count FROM lineage_edges WHERE source_table_id=?", tableId);
    return { upstream: num(upstream?.count ?? 0), downstream: num(downstream?.count ?? 0) };
  }

  replaceLineageColumns(tableId: string, columns: readonly LineageColumn[]): void {
    this.transaction(() => {
      this.database.prepare("DELETE FROM lineage_columns WHERE table_id=?").run(tableId);
      const statement = this.database.prepare(`INSERT INTO lineage_columns(table_id, column_name, ordinal_position,
        data_type, column_comment, is_nullable, is_partition_key, is_primary_key, updated_at)
        VALUES (@tableId, @name, @ordinalPosition, @dataType, @comment, @nullable, @partitionKey, @primaryKey, @updatedAt)`);
      for (const column of columns) statement.run({
        ...column,
        nullable: boolInt(column.nullable),
        partitionKey: boolInt(column.partitionKey),
        primaryKey: boolInt(column.primaryKey),
      });
    });
  }

  upsertLineageEdge(edge: LineageEdge): void {
    if (edge.sourceTableId === edge.targetTableId) return;
    this.ensureLineageTable(edge.sourceTableId, edge.firstSeenAt);
    this.ensureLineageTable(edge.targetTableId, edge.firstSeenAt);
    this.database.prepare(`
      INSERT INTO lineage_edges(source_table_id, target_table_id, first_seen_at, last_seen_at,
        occurrence_count, last_instance_id, last_task_name, last_owner_name, last_node_id,
        last_node_name, last_on_duty, updated_at)
      VALUES (@sourceTableId, @targetTableId, @firstSeenAt, @lastSeenAt, @occurrenceCount,
        @lastInstanceId, @lastTaskName, @lastOwnerName, @lastNodeId, @lastNodeName, @lastOnDuty, @updatedAt)
      ON CONFLICT(source_table_id, target_table_id) DO UPDATE SET
        last_seen_at=MAX(lineage_edges.last_seen_at, excluded.last_seen_at),
        occurrence_count=lineage_edges.occurrence_count + excluded.occurrence_count,
        last_instance_id=CASE WHEN excluded.last_seen_at >= lineage_edges.last_seen_at THEN excluded.last_instance_id ELSE lineage_edges.last_instance_id END,
        last_task_name=CASE WHEN excluded.last_seen_at >= lineage_edges.last_seen_at THEN excluded.last_task_name ELSE lineage_edges.last_task_name END,
        last_owner_name=CASE WHEN excluded.last_seen_at >= lineage_edges.last_seen_at THEN excluded.last_owner_name ELSE lineage_edges.last_owner_name END,
        last_node_id=CASE WHEN excluded.last_seen_at >= lineage_edges.last_seen_at THEN excluded.last_node_id ELSE lineage_edges.last_node_id END,
        last_node_name=CASE WHEN excluded.last_seen_at >= lineage_edges.last_seen_at THEN excluded.last_node_name ELSE lineage_edges.last_node_name END,
        last_on_duty=CASE WHEN excluded.last_seen_at >= lineage_edges.last_seen_at THEN excluded.last_on_duty ELSE lineage_edges.last_on_duty END,
        updated_at=excluded.updated_at
    `).run(edge);
  }

  upsertLineageTaskHistory(task: LineageTaskHistory): boolean {
    const current = this.getOne("SELECT source_hash, parser_version FROM lineage_task_history_raw WHERE task_catalog=? AND inst_id=?", task.taskCatalog, task.instanceId);
    if (current && str(current.source_hash!) === task.sourceHash && num(current.parser_version!) === task.parserVersion) {
      this.database.prepare("UPDATE lineage_task_history_raw SET last_imported_at=?, data_date=MAX(data_date, ?) WHERE task_catalog=? AND inst_id=?")
        .run(task.lastImportedAt, task.dataDate, task.taskCatalog, task.instanceId);
      return false;
    }
    this.database.prepare(`INSERT INTO lineage_task_history_raw(task_catalog, inst_id, task_name, task_type, status,
      owner_name, end_time, input_tables, output_tables, ext_node_id, ext_node_name, ext_node_onduty, ext_bizdate,
      data_date, source_hash, parser_version, parse_status, parse_error, first_imported_at, last_imported_at, parsed_at)
      VALUES (@taskCatalog, @instanceId, @taskName, @taskType, @status, @ownerName, @endTime, @inputTables,
        @outputTables, @nodeId, @nodeName, @onDuty, @bizDate, @dataDate, @sourceHash, @parserVersion, 'pending', NULL,
        @firstImportedAt, @lastImportedAt, NULL)
      ON CONFLICT(task_catalog, inst_id) DO UPDATE SET task_name=excluded.task_name, task_type=excluded.task_type,
        status=excluded.status, owner_name=excluded.owner_name, end_time=excluded.end_time,
        input_tables=excluded.input_tables, output_tables=excluded.output_tables, ext_node_id=excluded.ext_node_id,
        ext_node_name=excluded.ext_node_name, ext_node_onduty=excluded.ext_node_onduty,
        ext_bizdate=excluded.ext_bizdate, data_date=excluded.data_date, source_hash=excluded.source_hash,
        parser_version=excluded.parser_version,
        parse_status='pending', parse_error=NULL, last_imported_at=excluded.last_imported_at, parsed_at=NULL`).run(task);
    return true;
  }

  listPendingLineageTasks(limit = 1_000): LineageTaskHistory[] {
    return this.getMany(`SELECT * FROM lineage_task_history_raw WHERE parse_status='pending'
      ORDER BY data_date, COALESCE(end_time, 0), task_catalog, inst_id LIMIT ?`, Math.max(1, Math.min(10_000, limit)))
      .map(lineageTaskHistoryFromRow);
  }

  markLineageTaskParsed(taskCatalog: string, instanceId: string, at = this.now()): void {
    this.database.prepare("UPDATE lineage_task_history_raw SET parse_status='parsed', parse_error=NULL, parsed_at=? WHERE task_catalog=? AND inst_id=?")
      .run(at, taskCatalog, instanceId);
  }

  markLineageTaskInvalid(taskCatalog: string, instanceId: string, error: string, at = this.now()): void {
    this.database.prepare("UPDATE lineage_task_history_raw SET parse_status='invalid', parse_error=?, parsed_at=? WHERE task_catalog=? AND inst_id=?")
      .run(error.slice(0, 2_000), at, taskCatalog, instanceId);
  }

  requeueLineageTasks(): number {
    const result = this.database.prepare("UPDATE lineage_task_history_raw SET parse_status='pending', parse_error=NULL, parsed_at=NULL").run();
    this.database.prepare("DELETE FROM lineage_processed_jobs WHERE inst_id IN (SELECT inst_id FROM lineage_task_history_raw)").run();
    return Number(result.changes);
  }

  replaceLineageTaskObservations(task: LineageTaskHistory, pairs: readonly { sourceTableId: string; targetTableId: string }[], at = this.now()): number {
    return this.transaction(() => {
      const old = this.getMany("SELECT source_table_id, target_table_id FROM lineage_task_edge_observations WHERE task_catalog=? AND inst_id=?", task.taskCatalog, task.instanceId);
      const affected = new Set(old.map((row) => `${str(row.source_table_id!)}\u0000${str(row.target_table_id!)}`));
      this.database.prepare("DELETE FROM lineage_task_edge_observations WHERE task_catalog=? AND inst_id=?").run(task.taskCatalog, task.instanceId);
      const insert = this.database.prepare(`INSERT INTO lineage_task_edge_observations(task_catalog, inst_id,
        source_table_id, target_table_id, first_seen_at, last_seen_at, occurrence_count, task_name, owner_name,
        node_id, node_name, on_duty, updated_at) VALUES (@taskCatalog, @instanceId, @sourceTableId, @targetTableId,
        @firstSeenAt, @lastSeenAt, 1, @taskName, @ownerName, @nodeId, @nodeName, @onDuty, @updatedAt)`);
      const unique = new Map<string, { sourceTableId: string; targetTableId: string }>();
      for (const pair of pairs) {
        if (pair.sourceTableId === pair.targetTableId) continue;
        unique.set(`${pair.sourceTableId}\u0000${pair.targetTableId}`, pair);
      }
      const seenAt = task.endTime ?? at;
      for (const [key, pair] of unique) {
        this.ensureLineageTable(pair.sourceTableId, seenAt);
        this.ensureLineageTable(pair.targetTableId, seenAt);
        insert.run({ ...task, ...pair, firstSeenAt: seenAt, lastSeenAt: seenAt, updatedAt: at });
        affected.add(key);
      }
      for (const key of affected) {
        const [sourceTableId, targetTableId] = key.split("\u0000") as [string, string];
        this.rebuildLineageEdge(sourceTableId, targetTableId, at);
      }
      return unique.size;
    });
  }

  pruneLineageTaskHistory(beforeDataDate: string): number {
    const result = this.database.prepare("DELETE FROM lineage_task_history_raw WHERE data_date<? AND parse_status<>'pending'").run(beforeDataDate);
    this.database.prepare("DELETE FROM lineage_processed_jobs WHERE data_date<?").run(beforeDataDate);
    return Number(result.changes);
  }

  private rebuildLineageEdge(sourceTableId: string, targetTableId: string, at: number): void {
    const aggregate = this.getOne(`SELECT MIN(first_seen_at) first_seen_at, MAX(last_seen_at) last_seen_at,
      SUM(occurrence_count) occurrence_count FROM lineage_task_edge_observations
      WHERE source_table_id=? AND target_table_id=?`, sourceTableId, targetTableId);
    if (!aggregate || aggregate.occurrence_count === null) {
      this.database.prepare("DELETE FROM lineage_edges WHERE source_table_id=? AND target_table_id=?").run(sourceTableId, targetTableId);
      return;
    }
    const latest = this.getOne(`SELECT * FROM lineage_task_edge_observations WHERE source_table_id=? AND target_table_id=?
      ORDER BY last_seen_at DESC, task_catalog, inst_id LIMIT 1`, sourceTableId, targetTableId)!;
    this.database.prepare(`INSERT INTO lineage_edges(source_table_id, target_table_id, first_seen_at, last_seen_at,
      occurrence_count, last_instance_id, last_task_name, last_owner_name, last_node_id, last_node_name,
      last_on_duty, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_table_id, target_table_id) DO UPDATE SET first_seen_at=excluded.first_seen_at,
        last_seen_at=excluded.last_seen_at, occurrence_count=excluded.occurrence_count,
        last_instance_id=excluded.last_instance_id, last_task_name=excluded.last_task_name,
        last_owner_name=excluded.last_owner_name, last_node_id=excluded.last_node_id,
        last_node_name=excluded.last_node_name, last_on_duty=excluded.last_on_duty,
        updated_at=excluded.updated_at`).run(
      sourceTableId, targetTableId, num(aggregate.first_seen_at!), num(aggregate.last_seen_at!), num(aggregate.occurrence_count!),
      str(latest.inst_id!), nullableStr(latest.task_name!), nullableStr(latest.owner_name!), nullableStr(latest.node_id!),
      nullableStr(latest.node_name!), nullableStr(latest.on_duty!), at,
    );
  }

  updateLineageTableSchedule(tableId: string, input: {
    at: number; status: string; taskName: string | null; instanceId: string | null; owner: string | null;
    nodeId: string | null; nodeName: string | null; onDuty: string | null; bizDate: string | null;
  }): void {
    this.ensureLineageTable(tableId, input.at);
    this.database.prepare(`UPDATE lineage_tables SET
      last_schedule_time=CASE WHEN last_schedule_time IS NULL OR last_schedule_time <= @at THEN @at ELSE last_schedule_time END,
      last_schedule_status=CASE WHEN last_schedule_time IS NULL OR last_schedule_time <= @at THEN @status ELSE last_schedule_status END,
      last_task_name=CASE WHEN last_schedule_time IS NULL OR last_schedule_time <= @at THEN @taskName ELSE last_task_name END,
      last_instance_id=CASE WHEN last_schedule_time IS NULL OR last_schedule_time <= @at THEN @instanceId ELSE last_instance_id END,
      schedule_owner=CASE WHEN last_schedule_time IS NULL OR last_schedule_time <= @at THEN @owner ELSE schedule_owner END,
      schedule_node_id=CASE WHEN last_schedule_time IS NULL OR last_schedule_time <= @at THEN @nodeId ELSE schedule_node_id END,
      schedule_node_name=CASE WHEN last_schedule_time IS NULL OR last_schedule_time <= @at THEN @nodeName ELSE schedule_node_name END,
      schedule_on_duty=CASE WHEN last_schedule_time IS NULL OR last_schedule_time <= @at THEN @onDuty ELSE schedule_on_duty END,
      last_biz_date=CASE WHEN last_schedule_time IS NULL OR last_schedule_time <= @at THEN @bizDate ELSE last_biz_date END,
      updated_at=@at WHERE id=@tableId`).run({ tableId, ...input });
  }

  updateLineageTablePartitionStats(tableId: string, input: {
    partitionCount: number; dataLength: number | null; lastModifiedTime: number | null;
    lastAccessTime: number | null; at: number;
  }): void {
    this.ensureLineageTable(tableId, input.at);
    this.database.prepare(`UPDATE lineage_tables SET partition_count=@partitionCount,
      data_length=COALESCE(@dataLength, data_length),
      last_modified_time=COALESCE(@lastModifiedTime, last_modified_time),
      last_access_time=COALESCE(@lastAccessTime, last_access_time), updated_at=@at
      WHERE id=@tableId`).run({ tableId, ...input });
  }

  isLineageJobProcessed(instanceId: string): boolean {
    return Boolean(this.getOne("SELECT inst_id FROM lineage_processed_jobs WHERE inst_id=?", instanceId));
  }

  markLineageJobProcessed(instanceId: string, dataDate: string, at = this.now()): void {
    this.database.prepare("INSERT OR IGNORE INTO lineage_processed_jobs(inst_id, data_date, processed_at) VALUES (?, ?, ?)")
      .run(instanceId, dataDate, at);
  }

  lineageStorageStats(dataDate: string): { processedJobs: number; stagedJobs: number; parsedJobs: number; invalidJobs: number; observations: number; totalEdges: number } {
    const processed = this.getOne("SELECT COUNT(*) count FROM lineage_processed_jobs WHERE data_date=?", dataDate);
    const staged = this.getOne(`SELECT COUNT(*) count,
      SUM(CASE WHEN parse_status='parsed' THEN 1 ELSE 0 END) parsed,
      SUM(CASE WHEN parse_status='invalid' THEN 1 ELSE 0 END) invalid
      FROM lineage_task_history_raw WHERE data_date=?`, dataDate);
    const observations = this.getOne("SELECT COUNT(*) count FROM lineage_task_edge_observations WHERE task_catalog<>'__legacy__'");
    const edges = this.getOne("SELECT COUNT(*) count FROM lineage_edges");
    return {
      processedJobs: num(processed?.count ?? 0), stagedJobs: num(staged?.count ?? 0), parsedJobs: num(staged?.parsed ?? 0),
      invalidJobs: num(staged?.invalid ?? 0), observations: num(observations?.count ?? 0), totalEdges: num(edges?.count ?? 0),
    };
  }

  resetLineageProcessedJobs(dataDate: string): number {
    return Number(this.database.prepare("DELETE FROM lineage_processed_jobs WHERE data_date=?").run(dataDate).changes);
  }

  resetLineageData(): { tables: number; edges: number; processedJobs: number } {
    const tables = num(this.getOne("SELECT COUNT(*) count FROM lineage_tables")?.count ?? 0);
    const edges = num(this.getOne("SELECT COUNT(*) count FROM lineage_edges")?.count ?? 0);
    const processedJobs = num(this.getOne("SELECT COUNT(*) count FROM lineage_processed_jobs")?.count ?? 0);
    this.database.prepare("DELETE FROM lineage_tables").run();
    this.database.prepare("DELETE FROM lineage_task_history_raw").run();
    this.database.prepare("DELETE FROM lineage_processed_jobs").run();
    return { tables, edges, processedJobs };
  }

  upsertLineageAccess(tableId: string, ds: string, accessCount: number, accessBytes: number, at = this.now()): void {
    this.ensureLineageTable(tableId, at);
    this.database.prepare(`INSERT INTO lineage_access_daily(table_id, ds, access_count, access_bytes, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(table_id, ds) DO UPDATE SET access_count=excluded.access_count,
      access_bytes=excluded.access_bytes, updated_at=excluded.updated_at`).run(tableId, ds, accessCount, accessBytes, at);
    this.database.prepare(`UPDATE lineage_tables SET
      access_count=(SELECT COALESCE(SUM(access_count),0) FROM lineage_access_daily WHERE table_id=?),
      access_bytes=(SELECT COALESCE(SUM(access_bytes),0) FROM lineage_access_daily WHERE table_id=?),
      updated_at=? WHERE id=?`).run(tableId, tableId, at, tableId);
  }

  listLineageEdges(rootId: string, direction: "up" | "down" | "both", depth: number, limit: number): Array<LineageEdge & { depth: number }> {
    const all: Array<LineageEdge & { depth: number }> = [];
    const directions = direction === "both" ? ["up", "down"] as const : [direction] as const;
    for (const item of directions) {
      const join = item === "down" ? "e.source_table_id=w.node" : "e.target_table_id=w.node";
      const next = item === "down" ? "e.target_table_id" : "e.source_table_id";
      const anchor = item === "down" ? "e.source_table_id=?" : "e.target_table_id=?";
      const rows = this.getMany(`WITH RECURSIVE w(source_table_id, target_table_id, node, depth, path) AS (
        SELECT e.source_table_id, e.target_table_id, ${next}, 1, '|' || e.source_table_id || '|' || e.target_table_id || '|'
        FROM lineage_edges e WHERE ${anchor}
        UNION ALL
        SELECT e.source_table_id, e.target_table_id, ${next}, w.depth + 1, w.path || ${next} || '|'
        FROM lineage_edges e JOIN w ON ${join}
        WHERE w.depth < ? AND instr(w.path, '|' || ${next} || '|') = 0
      ) SELECT e.*, MIN(w.depth) graph_depth FROM w JOIN lineage_edges e
        ON e.source_table_id=w.source_table_id AND e.target_table_id=w.target_table_id
        GROUP BY e.source_table_id, e.target_table_id ORDER BY graph_depth, e.last_seen_at DESC LIMIT ?`, rootId, depth, limit);
      all.push(...rows.map((row) => ({ ...lineageEdgeFromRow(row), depth: num(row.graph_depth!) })));
    }
    return [...new Map(all.map((edge) => [`${edge.sourceTableId}>${edge.targetTableId}`, edge])).values()]
      .sort((a, b) => a.depth - b.depth || b.lastSeenAt - a.lastSeenAt).slice(0, limit);
  }

  findLineagePath(sourceId: string, targetId: string, maximumDepth = 12): LineageEdge[] {
    const row = this.getOne(`WITH RECURSIVE p(node, route, depth) AS (
      SELECT ?, ?, 0
      UNION ALL
      SELECT e.target_table_id, p.route || '>' || e.target_table_id, p.depth + 1
      FROM p JOIN lineage_edges e ON e.source_table_id=p.node
      WHERE p.depth < ? AND instr('>' || p.route || '>', '>' || e.target_table_id || '>') = 0
    ) SELECT route FROM p WHERE node=? ORDER BY depth LIMIT 1`, sourceId, sourceId, maximumDepth, targetId);
    if (!row) return [];
    const ids = str(row.route!).split(">");
    const edges: LineageEdge[] = [];
    for (let index = 0; index < ids.length - 1; index += 1) {
      const edge = this.getOne("SELECT * FROM lineage_edges WHERE source_table_id=? AND target_table_id=?", ids[index]!, ids[index + 1]!);
      if (edge) edges.push(lineageEdgeFromRow(edge));
    }
    return edges;
  }

  saveLineageSyncRun(run: LineageSyncRun): void {
    this.database.prepare(`INSERT INTO lineage_sync_runs(id, trigger_type, requested_by, data_date, status,
      projects_processed, tables_processed, columns_processed, jobs_processed, edges_processed, error, started_at, completed_at)
      VALUES (@id, @trigger, @requestedBy, @dataDate, @status, @projectsProcessed, @tablesProcessed, @columnsProcessed,
        @jobsProcessed, @edgesProcessed, @error, @startedAt, @completedAt)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, projects_processed=excluded.projects_processed, tables_processed=excluded.tables_processed,
        columns_processed=excluded.columns_processed, jobs_processed=excluded.jobs_processed,
        edges_processed=excluded.edges_processed, error=excluded.error, completed_at=excluded.completed_at`).run(run);
  }

  listLineageSyncRuns(limit = 10): LineageSyncRun[] {
    return this.getMany("SELECT * FROM lineage_sync_runs ORDER BY started_at DESC LIMIT ?", Math.max(1, Math.min(100, limit)))
      .map(lineageSyncRunFromRow);
  }

  search(request: SearchRequest): Page<SearchHit> {
    const query = ftsQuery(request.query);
    if (!query) return { items: [], nextCursor: null };
    const limit = pageLimit(request.limit, 30);
    const cursor = decodeCursor(request.cursor);
    const teamSession = inFilter("s.team_id", request.teamIds);
    const teamMessage = inFilter("s.team_id", request.teamIds);
    const sessionClause = request.sessionId ? "AND s.id=?" : "";
    const messageClause = request.sessionId ? "AND m.session_id=?" : "";
    const cursorClause = cursor ? "AND (hit_time < ? OR (hit_time = ? AND hit_id < ?))" : "";
    const params: SqlValue[] = [query, ...teamSession.params];
    if (request.sessionId) params.push(request.sessionId);
    params.push(query, ...teamMessage.params);
    if (request.sessionId) params.push(request.sessionId);
    if (cursor) params.push(cursor.timestamp, cursor.timestamp, cursor.id);
    params.push(limit + 1);
    const rows = this.getMany(`
      WITH hits AS (
        SELECT 'session' kind, s.id session_id, NULL message_id, s.title title,
          snippet(session_search, 0, '<mark>', '</mark>', '…', 18) excerpt,
          bm25(session_search, 8.0, 3.0) rank, s.updated_at hit_time, 's:' || s.id hit_id
        FROM session_search JOIN sessions s ON s.rowid=session_search.rowid
        WHERE session_search MATCH ? ${teamSession.sql ? `AND ${teamSession.sql.replace(/^WHERE /, "")}` : ""} ${sessionClause}
        UNION ALL
        SELECT 'message' kind, m.session_id, m.id message_id, s.title title,
          snippet(message_search, 0, '<mark>', '</mark>', '…', 24) excerpt,
          bm25(message_search) rank, m.created_at hit_time, 'm:' || m.id hit_id
        FROM message_search JOIN messages m ON m.rowid=message_search.rowid JOIN sessions s ON s.id=m.session_id
        WHERE message_search MATCH ? ${teamMessage.sql ? `AND ${teamMessage.sql.replace(/^WHERE /, "")}` : ""} ${messageClause}
      )
      SELECT * FROM hits WHERE 1=1 ${cursorClause} ORDER BY hit_time DESC, hit_id DESC LIMIT ?
    `, ...params);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.map(searchHitFromRow);
    const last = selected.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor({ timestamp: num(last.hit_time!), id: str(last.hit_id!) }) : null };
  }

  reconcileAfterRestart(at = this.now()): ReconciliationResult {
    return this.transaction(() => {
      const expiredPermissions = this.expirePermissions(at);
      const stalePermissions = this.database.prepare(`
        UPDATE permissions SET status='stale', updated_at=? WHERE status='pending'
      `).run(at).changes;
      const interruptedTurns = this.database.prepare(`
        UPDATE turns SET status='interrupted', finished_at=?, stop_reason='server_restart', updated_at=?
        WHERE status IN ('running','waiting_permission')
      `).run(at, at).changes;
      const interruptedSessions = this.database.prepare(`
        UPDATE sessions SET status='interrupted', updated_at=?
        WHERE status IN ('running','compacting','waiting_permission')
      `).run(at).changes;
      this.database.prepare("UPDATE agents SET status='idle', updated_at=? WHERE status IN ('queued','running','waiting')").run(at);
      return { interruptedSessions, interruptedTurns, stalePermissions, expiredPermissions };
    });
  }

  private async importLegacyJsonOnce(): Promise<Pick<InitializeResult, "importedLegacyJson" | "legacyBackupPath">> {
    const legacyPath = this.options.legacyJsonPath;
    if (!legacyPath || this.getMeta("legacy_json_imported_at")) {
      return { importedLegacyJson: false, legacyBackupPath: null };
    }
    let raw: string;
    try {
      raw = await readFile(legacyPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return { importedLegacyJson: false, legacyBackupPath: null };
      throw error;
    }
    if (this.getOne("SELECT id FROM users LIMIT 1")) {
      throw new Error("Refusing to import legacy JSON into a non-empty SQLite database.");
    }
    const legacy = parseLegacyDatabase(raw);
    const importedAt = this.now();
    this.transaction(() => {
      for (const user of legacy.users) this.saveUser(user);
      for (const auth of legacy.authSessions) this.saveAuthSession(auth);
      for (const team of legacy.teams) this.saveTeam(team);
      for (const member of legacy.members) this.saveTeamMember(member);
      for (const agent of legacy.agents) this.saveAgent(agent);
      for (const session of legacy.sessions) this.createSession(session);
      for (const message of legacy.messages) this.appendMessage(message);
      for (const permission of legacy.permissions) this.createPermission(permission);
      for (const change of legacy.fileChanges) this.appendFileChange(change);
      for (const log of legacy.auditLogs) this.appendAuditLog(log);
      if (legacy.claudeConfig) this.saveClaudeConfig(legacy.claudeConfig);
      this.setMeta("legacy_json_imported_at", String(importedAt));
      this.setMeta("legacy_json_source", legacyPath);
    });
    const backupPath = `${legacyPath}.migrated-${importedAt}.bak`;
    await rename(legacyPath, backupPath);
    this.setMeta("legacy_json_backup", backupPath);
    return { importedLegacyJson: true, legacyBackupPath: backupPath };
  }

  getMeta(key: string): string | null {
    const row = this.getOne("SELECT value FROM app_meta WHERE key=?", key);
    return row ? str(row.value!) : null;
  }

  setMeta(key: string, value: string): void {
    this.database.prepare(`INSERT INTO app_meta(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(key, value, this.now());
  }
}

function boolInt(value: boolean): 0 | 1 { return value ? 1 : 0; }
function bool(value: SqlValue): boolean { return Number(value) === 1; }
function str(value: SqlValue): string { return value === null ? "" : String(value); }
function nullableStr(value: SqlValue): string | null { return value === null ? null : String(value); }
function num(value: SqlValue): number { return Number(value); }
function nullableNum(value: SqlValue): number | null { return value === null ? null : Number(value); }
function json(value: unknown): string { return JSON.stringify(value); }
function jsonObject(value: SqlValue): JsonObject { return parseJson(value, {}); }
function parseJson<T extends JsonValue>(value: SqlValue, fallback: T): T {
  try { return JSON.parse(str(value)) as T; } catch { return fallback; }
}
function where(clauses: string[]): string { return clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""; }
function isNotFound(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

function addInClause(clauses: string[], params: SqlValue[], column: string, values?: readonly string[]): void {
  if (!values) return;
  if (values.length === 0) { clauses.push("0"); return; }
  clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
  params.push(...values);
}

function inFilter(column: string, values?: readonly string[], includeNull = false): { sql: string; params: SqlValue[] } {
  if (!values) return { sql: "", params: [] };
  if (values.length === 0) return { sql: "WHERE 0", params: [] };
  return { sql: `WHERE (${column} IN (${values.map(() => "?").join(",")})${includeNull ? ` OR ${column} IS NULL` : ""})`, params: [...values] };
}

function ftsQuery(value: string): string {
  return value
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function page<T>(rows: Row[], limit: number, map: (row: Row) => T, timestampColumn: string): Page<T> {
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(map),
    nextCursor: hasMore && last ? encodeCursor({ timestamp: num(last[timestampColumn]!), id: str(last.id!) }) : null,
  };
}

function userFromRow(r: Row): User { return { id:str(r.id!), username:str(r.username!), passwordHash:str(r.password_hash!), displayName:str(r.display_name!), email:str(r.email!), role:str(r.role!) as User["role"], status:str(r.status!) as User["status"], createdAt:num(r.created_at!), updatedAt:num(r.updated_at!) }; }
function authSessionFromRow(r: Row): AuthSession { return { token:str(r.token!), userId:str(r.user_id!), expiresAt:num(r.expires_at!), createdAt:num(r.created_at!), lastSeenAt:num(r.last_seen_at!) }; }
function teamFromRow(r: Row): Team { return { id:str(r.id!), name:str(r.name!), workspacePath:str(r.workspace_path!), workspaceMode:str(r.workspace_mode!) as Team["workspaceMode"], runtimeDefaults:validatedRuntimeDefaults(jsonObject(r.runtime_defaults_json!)), createdBy:str(r.created_by!), createdAt:num(r.created_at!), updatedAt:num(r.updated_at!) }; }
function teamMemberFromRow(r: Row): TeamMember { return { teamId:str(r.team_id!), userId:str(r.user_id!), role:str(r.role!) as TeamMember["role"], createdAt:num(r.created_at!), updatedAt:num(r.updated_at!) }; }
function teamConfigTemplateFromRow(r: Row): TeamConfigTemplate { return { id:str(r.id!), name:str(r.name!), description:str(r.description!), workspaceMode:str(r.workspace_mode!) as TeamConfigTemplate["workspaceMode"], modelContextTokens:num(r.model_context_tokens!), autoCompactRatio:num(r.auto_compact_ratio!), autoCompactEnabled:bool(r.auto_compact_enabled!), mcpToolAllowlist:parseJson(r.mcp_tool_allowlist_json!, []), createdBy:str(r.created_by!), createdAt:num(r.created_at!), updatedAt:num(r.updated_at!) }; }
function agentFromRow(r: Row): Agent { return { id:str(r.id!), teamId:nullableStr(r.team_id!), name:str(r.name!), type:"claude_code", command:str(r.command!), enabled:bool(r.enabled!), status:str(r.status!) as Agent["status"], metadata:jsonObject(r.metadata_json!), createdAt:num(r.created_at!), updatedAt:num(r.updated_at!) }; }
function sessionFromRow(r: Row): ConversationSession { return { id:str(r.id!), teamId:str(r.team_id!), agentId:str(r.agent_id!), createdBy:str(r.created_by!), title:str(r.title!), summary:nullableStr(r.summary!), summaryUpdatedAt:nullableNum(r.summary_updated_at!), visibility:str(r.visibility!) as ConversationSession["visibility"], status:str(r.status!) as ConversationSession["status"], cwd:str(r.cwd!), claudeSessionId:nullableStr(r.claude_session_id!), toolApprovals:parseJson(r.tool_approvals_json!, { onceTools:[], alwaysTools:[], alwaysServers:[] }), archivedAt:nullableNum(r.archived_at!), pinnedAt:nullableNum(r.pinned_at!), createdAt:num(r.created_at!), updatedAt:num(r.updated_at!) }; }
function turnFromRow(r: Row): Turn { return { id:str(r.id!), sessionId:str(r.session_id!), requestedByUserId:nullableStr(r.requested_by_user_id!), status:str(r.status!) as Turn["status"], prompt:str(r.prompt!), retryOfMessageId:nullableStr(r.retry_of_message_id!), claudeSessionId:nullableStr(r.claude_session_id!), startedAt:nullableNum(r.started_at!), finishedAt:nullableNum(r.finished_at!), stopReason:nullableStr(r.stop_reason!), error:nullableStr(r.error!), createdAt:num(r.created_at!), updatedAt:num(r.updated_at!) }; }
function messageFromRow(r: Row): Message { return { id:str(r.id!), sessionId:str(r.session_id!), senderType:str(r.sender_type!) as Message["senderType"], senderId:nullableStr(r.sender_id!), content:str(r.content!), metadata:jsonObject(r.metadata_json!), createdAt:num(r.created_at!), updatedAt:nullableNum(r.updated_at!) }; }
function permissionFromRow(r: Row): Permission { return { id:str(r.id!), sessionId:str(r.session_id!), agentId:str(r.agent_id!), requestedByUserId:str(r.requested_by_user_id!), type:str(r.type!) as Permission["type"], risk:str(r.risk!) as Permission["risk"], summary:str(r.summary!), payload:str(r.payload!), turnId:nullableStr(r.turn_id!), status:str(r.status!) as Permission["status"], expiresAt:num(r.expires_at!), decidedBy:nullableStr(r.decided_by!), decidedAt:nullableNum(r.decided_at!), decision:nullableStr(r.decision!) as Permission["decision"], toolName:nullableStr(r.tool_name!), serverName:nullableStr(r.server_name!), toolInput:jsonObject(r.tool_input_json!), toolUseId:nullableStr(r.tool_use_id!), controlRequestId:nullableStr(r.control_request_id!), sdkPermission:bool(r.sdk_permission!), permissionSuggestions:parseJson(r.permission_suggestions_json!, []), reason:nullableStr(r.reason!), fallbackResume:bool(r.fallback_resume!), metadata:jsonObject(r.metadata_json!), createdAt:num(r.created_at!), updatedAt:num(r.updated_at!) }; }
function fileChangeFromRow(r: Row): FileChange { return { id:str(r.id!), sessionId:str(r.session_id!), turnId:nullableStr(r.turn_id!), path:str(r.path!), previousPath:nullableStr(r.previous_path!), changeType:str(r.change_type!) as FileChange["changeType"], additions:nullableNum(r.additions!), deletions:nullableNum(r.deletions!), metadata:jsonObject(r.metadata_json!), createdAt:num(r.created_at!) }; }
function auditFromRow(r: Row): AuditLog { return { id:str(r.id!), userId:nullableStr(r.user_id!), action:str(r.action!), targetType:str(r.target_type!), targetId:str(r.target_id!), metadata:jsonObject(r.metadata_json!), createdAt:num(r.created_at!) }; }
function configFromRow(r: Row): ClaudeConfig { return { command:str(r.command!), args:str(r.args!), workspaceRoot:str(r.workspace_root!), modelContextTokens:num(r.model_context_tokens!), autoCompactRatio:num(r.auto_compact_ratio!), autoCompactEnabled:bool(r.auto_compact_enabled!), mcpToolAllowlist:parseJson(r.mcp_tool_allowlist_json!, []), enabled:bool(r.enabled!), available:bool(r.available!), version:str(r.version!), latencyMs:num(r.latency_ms!), authenticated:bool(r.authenticated!), lastCheckAt:nullableNum(r.last_check_at!), healthMessage:nullableStr(r.health_message!), updatedAt:num(r.updated_at!) }; }
function maxComputeConfigFromRow(r: Row): MaxComputeConfig { return { enabled:bool(r.enabled!), command:str(r.command!), args:str(r.args!), project:str(r.project!), collectionMode:str(r.collection_mode!) as MaxComputeConfig["collectionMode"], collectionProjects:parseJson(r.collection_projects_json!, []), discoveredProjects:parseJson(r.discovered_projects_json!, []), endpoint:str(r.endpoint!), credentialCiphertext:nullableStr(r.credential_ciphertext!), credentialUpdatedAt:nullableNum(r.credential_updated_at!), scheduleTime:str(r.schedule_time!), timezone:"Asia/Shanghai", lastStartedAt:nullableNum(r.last_started_at!), lastCompletedAt:nullableNum(r.last_completed_at!), lastStatus:str(r.last_status!) as MaxComputeConfig["lastStatus"], lastError:nullableStr(r.last_error!), lastDataDate:nullableStr(r.last_data_date!), nextRunAt:nullableNum(r.next_run_at!), updatedAt:num(r.updated_at!) }; }
function lineageTableFromRow(r: Row): LineageTable { return { id:str(r.id!), project:str(r.project_name!), name:str(r.table_name!), type:str(r.table_type!), comment:str(r.table_comment!), ownerId:nullableStr(r.owner_id!), ownerName:nullableStr(r.owner_name!), isPartitioned:bool(r.is_partitioned!), createTime:nullableNum(r.create_time!), lastModifiedTime:nullableNum(r.last_modified_time!), lastAccessTime:nullableNum(r.last_access_time!), dataLength:nullableNum(r.data_length!), partitionCount:num(r.partition_count!), lifecycle:nullableNum(r.lifecycle!), storageTier:nullableStr(r.storage_tier!), clusterType:nullableStr(r.cluster_type!), numberBuckets:nullableNum(r.number_buckets!), hasPrimaryKey:bool(r.has_primary_key!), isTransactional:bool(r.is_transactional!), isDeltaTable:bool(r.is_delta_table!), tableStorage:nullableStr(r.table_storage!), tableFormat:nullableStr(r.table_format!), lastScheduleTime:nullableNum(r.last_schedule_time!), lastScheduleStatus:nullableStr(r.last_schedule_status!), lastTaskName:nullableStr(r.last_task_name!), lastInstanceId:nullableStr(r.last_instance_id!), scheduleOwner:nullableStr(r.schedule_owner!), scheduleNodeId:nullableStr(r.schedule_node_id!), scheduleNodeName:nullableStr(r.schedule_node_name!), scheduleOnDuty:nullableStr(r.schedule_on_duty!), lastBizDate:nullableStr(r.last_biz_date!), accessCount:num(r.access_count!), accessBytes:num(r.access_bytes!), createdAt:num(r.created_at!), updatedAt:num(r.updated_at!) }; }
function lineageColumnFromRow(r: Row): LineageColumn { return { tableId:str(r.table_id!), name:str(r.column_name!), ordinalPosition:num(r.ordinal_position!), dataType:str(r.data_type!), comment:str(r.column_comment!), nullable:bool(r.is_nullable!), partitionKey:bool(r.is_partition_key!), primaryKey:bool(r.is_primary_key!), updatedAt:num(r.updated_at!) }; }
function lineageEdgeFromRow(r: Row): LineageEdge { return { sourceTableId:str(r.source_table_id!), targetTableId:str(r.target_table_id!), firstSeenAt:num(r.first_seen_at!), lastSeenAt:num(r.last_seen_at!), occurrenceCount:num(r.occurrence_count!), lastInstanceId:nullableStr(r.last_instance_id!), lastTaskName:nullableStr(r.last_task_name!), lastOwnerName:nullableStr(r.last_owner_name!), lastNodeId:nullableStr(r.last_node_id!), lastNodeName:nullableStr(r.last_node_name!), lastOnDuty:nullableStr(r.last_on_duty!), updatedAt:num(r.updated_at!) }; }
function lineageSyncRunFromRow(r: Row): LineageSyncRun { return { id:str(r.id!), trigger:str(r.trigger_type!) as LineageSyncRun["trigger"], requestedBy:nullableStr(r.requested_by!), dataDate:str(r.data_date!), status:str(r.status!) as LineageSyncRun["status"], projectsProcessed:num(r.projects_processed!), tablesProcessed:num(r.tables_processed!), columnsProcessed:num(r.columns_processed!), jobsProcessed:num(r.jobs_processed!), edgesProcessed:num(r.edges_processed!), error:nullableStr(r.error!), startedAt:num(r.started_at!), completedAt:nullableNum(r.completed_at!) }; }
function lineageTaskHistoryFromRow(r: Row): LineageTaskHistory { return { taskCatalog:str(r.task_catalog!), instanceId:str(r.inst_id!), taskName:str(r.task_name!), taskType:str(r.task_type!), status:str(r.status!), ownerName:str(r.owner_name!), endTime:nullableNum(r.end_time!), inputTables:str(r.input_tables!), outputTables:str(r.output_tables!), nodeId:str(r.ext_node_id!), nodeName:str(r.ext_node_name!), onDuty:str(r.ext_node_onduty!), bizDate:str(r.ext_bizdate!), dataDate:str(r.data_date!), sourceHash:str(r.source_hash!), parserVersion:num(r.parser_version!), parseStatus:str(r.parse_status!) as LineageTaskHistory["parseStatus"], parseError:nullableStr(r.parse_error!), firstImportedAt:num(r.first_imported_at!), lastImportedAt:num(r.last_imported_at!), parsedAt:nullableNum(r.parsed_at!) }; }
function searchHitFromRow(r: Row): SearchHit { return { kind:str(r.kind!) as SearchHit["kind"], sessionId:str(r.session_id!), messageId:nullableStr(r.message_id!), title:str(r.title!), excerpt:str(r.excerpt!), rank:num(r.rank!), timestamp:num(r.hit_time!) }; }

function lineageTableParams(table: LineageTable): Record<string, unknown> { return { ...table, isPartitioned:boolInt(table.isPartitioned), hasPrimaryKey:boolInt(table.hasPrimaryKey), isTransactional:boolInt(table.isTransactional), isDeltaTable:boolInt(table.isDeltaTable) }; }

function sessionParams(s: ConversationSession): Record<string, unknown> { return { ...s, toolApprovalsJson: json(s.toolApprovals) }; }
function permissionParams(p: Permission): Record<string, unknown> { return { ...p, toolInputJson:json(p.toolInput), sdkPermission:boolInt(p.sdkPermission), permissionSuggestionsJson:json(p.permissionSuggestions), fallbackResume:boolInt(p.fallbackResume), metadataJson:json(p.metadata) }; }

interface LegacyDatabase {
  sessionsByToken?: Record<string, { userId?: unknown; expiresAt?: unknown }>;
  users?: unknown[]; teams?: unknown[]; members?: unknown[]; agents?: unknown[]; sessions?: unknown[];
  messages?: unknown[]; permissions?: unknown[]; fileChanges?: unknown[]; auditLogs?: unknown[];
  claudeConfig?: Record<string, unknown>;
}

function parseLegacyDatabase(raw: string): { users:User[]; authSessions:AuthSession[]; teams:Team[]; members:TeamMember[]; agents:Agent[]; sessions:ConversationSession[]; messages:Message[]; permissions:Permission[]; fileChanges:FileChange[]; auditLogs:AuditLog[]; claudeConfig:ClaudeConfig|null } {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("Legacy database root must be an object.");
  const db = parsed as LegacyDatabase;
  const at = Date.now();
  const records = (items: unknown[] | undefined): Record<string, unknown>[] => (items ?? []).filter(isRecord);
  const users = records(db.users).map((x):User => ({ id:text(x.id), username:text(x.username), passwordHash:text(x.passwordHash), displayName:text(x.displayName, text(x.username)), email:text(x.email), role:oneOf(x.role,["admin","member"] as const,"member"), status:oneOf(x.status,["active","disabled"] as const,"active"), createdAt:numberValue(x.createdAt,at), updatedAt:numberValue(x.updatedAt,at) }));
  const userIds = new Set(users.map((x)=>x.id));
  const authSessions = Object.entries(db.sessionsByToken ?? {}).flatMap(([token,x]) => isRecord(x) && userIds.has(text(x.userId)) ? [{ token:digestSessionToken(token), userId:text(x.userId), expiresAt:numberValue(x.expiresAt,at), createdAt:at, lastSeenAt:at }] : []);
  const teams = records(db.teams).map((x):Team => ({ id:text(x.id), name:text(x.name), workspacePath:text(x.workspacePath), workspaceMode:oneOf(x.workspaceMode,["shared","isolated"] as const,"shared"), runtimeDefaults:{}, createdBy:text(x.createdBy), createdAt:numberValue(x.createdAt,at), updatedAt:numberValue(x.updatedAt,at) }));
  const members = records(db.members).map((x):TeamMember => ({ teamId:text(x.teamId), userId:text(x.userId), role:oneOf(x.role,["owner","admin","member","viewer"] as const,"member"), createdAt:numberValue(x.createdAt,at), updatedAt:numberValue(x.updatedAt,at) }));
  const agents = records(db.agents).map((x):Agent => ({ id:text(x.id), teamId:nullableText(x.teamId), name:text(x.name), type:"claude_code", command:text(x.command,"claude"), enabled:booleanValue(x.enabled,true), status:oneOf(x.status,["idle","queued","running","waiting","offline","error"] as const,"idle"), metadata:objectValue(x.metadata), createdAt:numberValue(x.createdAt,at), updatedAt:numberValue(x.updatedAt,at) }));
  const sessions = records(db.sessions).map((x):ConversationSession => ({ id:text(x.id), teamId:text(x.teamId), agentId:text(x.agentId), createdBy:text(x.createdBy), title:text(x.title,"新会话"), summary:nullableText(x.summary), summaryUpdatedAt:nullableNumber(x.summaryUpdatedAt), visibility:oneOf(x.visibility,["private","team"] as const,"private"), status:oneOf(x.status,["idle","queued","running","compacting","waiting_permission","completed","failed","stopped","interrupted"] as const,"idle"), cwd:text(x.cwd), claudeSessionId:nullableText(x.claudeSessionId), toolApprovals:toolApprovalsValue(x.toolApprovals), archivedAt:nullableNumber(x.archivedAt), pinnedAt:nullableNumber(x.pinnedAt), createdAt:numberValue(x.createdAt,at), updatedAt:numberValue(x.updatedAt,at) }));
  const messages = records(db.messages).map((x):Message => ({ id:text(x.id), sessionId:text(x.sessionId), senderType:oneOf(x.senderType,["user","agent","system","tool"] as const,"system"), senderId:nullableText(x.senderId), content:text(x.content), metadata:objectValue(x.metadata), createdAt:numberValue(x.createdAt,at), updatedAt:nullableNumber(x.updatedAt) }));
  const permissions = records(db.permissions).map((x):Permission => ({ id:text(x.id), sessionId:text(x.sessionId), agentId:text(x.agentId), requestedByUserId:text(x.requestedByUserId), type:oneOf(x.type,["platform_gate","mcp_tool"] as const,"platform_gate"), risk:oneOf(x.risk,["low","medium","high","critical"] as const,"medium"), summary:text(x.summary), payload:text(x.payload), turnId:null, status:oneOf(x.status,["pending","approved","rejected","expired","stale"] as const,"pending"), expiresAt:numberValue(x.expiresAt,at), decidedBy:nullableText(x.decidedBy), decidedAt:nullableNumber(x.decidedAt), decision:legacyPermissionDecision(x.decision), toolName:nullableText(x.toolName), serverName:nullableText(x.serverName), toolInput:objectValue(x.toolInput), toolUseId:nullableText(x.toolUseId), controlRequestId:nullableText(x.controlRequestId), sdkPermission:booleanValue(x.sdkPermission,false), permissionSuggestions:arrayValue(x.permissionSuggestions), reason:nullableText(x.reason), fallbackResume:booleanValue(x.fallbackResume,false), metadata:objectValue(x.metadata), createdAt:numberValue(x.createdAt,at), updatedAt:numberValue(x.updatedAt,numberValue(x.createdAt,at)) }));
  const fileChanges = records(db.fileChanges).map((x):FileChange => ({ id:text(x.id), sessionId:text(x.sessionId), turnId:null, path:text(x.path), previousPath:nullableText(x.previousPath), changeType:oneOf(x.changeType,["created","modified","deleted","renamed"] as const,"modified"), additions:nullableNumber(x.additions), deletions:nullableNumber(x.deletions), metadata:objectValue(x.metadata), createdAt:numberValue(x.createdAt,at) }));
  const auditLogs = records(db.auditLogs).map((x):AuditLog => ({ id:text(x.id), userId:nullableText(x.userId), action:text(x.action), targetType:text(x.targetType), targetId:text(x.targetId), metadata:objectValue(x.metadata), createdAt:numberValue(x.createdAt,at) }));
  const c = db.claudeConfig;
  const claudeConfig = c ? { command:text(c.command,"claude"), args:text(c.args), workspaceRoot:text(c.workspaceRoot), modelContextTokens:numberValue(c.modelContextTokens,1_000_000), autoCompactRatio:numberValue(c.autoCompactRatio,0.62), autoCompactEnabled:booleanValue(c.autoCompactEnabled,true), mcpToolAllowlist:stringArray(c.mcpToolAllowlist), enabled:booleanValue(c.enabled,true), available:booleanValue(c.available,false), version:text(c.version,"unknown"), latencyMs:numberValue(c.latencyMs,0), authenticated:booleanValue(c.authenticated,false), lastCheckAt:nullableNumber(c.lastCheckAt), healthMessage:nullableText(c.message), updatedAt:at } satisfies ClaudeConfig : null;
  return { users,authSessions,teams,members,agents,sessions,messages,permissions,fileChanges,auditLogs,claudeConfig };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, fallback=""): string { return typeof value === "string" ? value : fallback; }
function nullableText(value: unknown): string|null { return typeof value === "string" && value.length ? value : null; }
function numberValue(value: unknown, fallback:number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function nullableNumber(value: unknown): number|null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function booleanValue(value: unknown, fallback:boolean): boolean { return typeof value === "boolean" ? value : fallback; }
function oneOf<const T extends readonly string[]>(value: unknown, allowed:T, fallback:T[number]):T[number] { return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T[number] : fallback; }
function objectValue(value: unknown):JsonObject { return isRecord(value) ? value as JsonObject : {}; }
function arrayValue(value: unknown):JsonValue[] { return Array.isArray(value) ? value as JsonValue[] : []; }
function stringArray(value: unknown):string[] { return Array.isArray(value) ? value.filter((x):x is string=>typeof x === "string") : []; }
function toolApprovalsValue(value: unknown):ConversationSession["toolApprovals"] { const x=isRecord(value)?value:{}; return { onceTools:stringArray(x.onceTools),alwaysTools:stringArray(x.alwaysTools),alwaysServers:stringArray(x.alwaysServers) }; }
function validatedRuntimeDefaults(value: unknown):Team["runtimeDefaults"] {
  if (!isRecord(value)) return {};
  const defaults:Team["runtimeDefaults"] = {};
  if (typeof value.modelContextTokens === "number" && Number.isSafeInteger(value.modelContextTokens) && value.modelContextTokens >= 1_000 && value.modelContextTokens <= 10_000_000) defaults.modelContextTokens = value.modelContextTokens;
  if (typeof value.autoCompactRatio === "number" && Number.isFinite(value.autoCompactRatio) && value.autoCompactRatio >= 0.1 && value.autoCompactRatio <= 0.9) defaults.autoCompactRatio = value.autoCompactRatio;
  if (typeof value.autoCompactEnabled === "boolean") defaults.autoCompactEnabled = value.autoCompactEnabled;
  if (Array.isArray(value.mcpToolAllowlist)) defaults.mcpToolAllowlist = value.mcpToolAllowlist.filter((item):item is string => typeof item === "string" && item.length <= 512).slice(0, 500);
  return defaults;
}
function legacyPermissionDecision(value: unknown): PermissionDecision | null {
  if (value === "approved") return "allow_once";
  return typeof value === "string" && ["allow_once", "allow_always_tool", "allow_always_server", "rejected"].includes(value)
    ? value as PermissionDecision
    : null;
}

import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { digestSessionToken } from "../auth/session-token.js";
import type {
  Agent,
  AuditLog,
  AuthSession,
  ClaudeConfig,
  ConversationSession,
  FileChange,
  JsonObject,
  JsonValue,
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
function searchHitFromRow(r: Row): SearchHit { return { kind:str(r.kind!) as SearchHit["kind"], sessionId:str(r.session_id!), messageId:nullableStr(r.message_id!), title:str(r.title!), excerpt:str(r.excerpt!), rank:num(r.rank!), timestamp:num(r.hit_time!) }; }

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

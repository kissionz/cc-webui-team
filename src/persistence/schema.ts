import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_normalized_schema",
    sql: `
      CREATE TABLE app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE auth_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_mode TEXT NOT NULL CHECK (workspace_mode IN ('shared', 'isolated')),
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE team_members (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, user_id)
      ) STRICT;

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type = 'claude_code'),
        command TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('idle', 'queued', 'running', 'waiting', 'offline', 'error')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (json_valid(metadata_json))
      ) STRICT;

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        created_by TEXT NOT NULL REFERENCES users(id),
        title TEXT NOT NULL,
        summary TEXT,
        summary_updated_at INTEGER,
        visibility TEXT NOT NULL CHECK (visibility IN ('private', 'team')),
        status TEXT NOT NULL CHECK (status IN ('idle', 'queued', 'running', 'compacting', 'waiting_permission', 'completed', 'failed', 'stopped', 'interrupted')),
        cwd TEXT NOT NULL,
        claude_session_id TEXT,
        tool_approvals_json TEXT NOT NULL DEFAULT '{"onceTools":[],"alwaysTools":[],"alwaysServers":[]}',
        archived_at INTEGER,
        pinned_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (json_valid(tool_approvals_json))
      ) STRICT;

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        requested_by_user_id TEXT REFERENCES users(id),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_permission', 'completed', 'failed', 'stopped', 'interrupted')),
        prompt TEXT NOT NULL,
        retry_of_message_id TEXT,
        claude_session_id TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        stop_reason TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent', 'system', 'tool')),
        sender_id TEXT,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        CHECK (json_valid(metadata_json))
      ) STRICT;

      CREATE TABLE permissions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        requested_by_user_id TEXT NOT NULL REFERENCES users(id),
        type TEXT NOT NULL CHECK (type IN ('platform_gate', 'mcp_tool')),
        risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
        summary TEXT NOT NULL,
        payload TEXT NOT NULL,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'stale')),
        expires_at INTEGER NOT NULL,
        decided_by TEXT REFERENCES users(id),
        decided_at INTEGER,
        decision TEXT CHECK (decision IN ('allow_once', 'allow_always_tool', 'allow_always_server', 'rejected')),
        tool_name TEXT,
        server_name TEXT,
        tool_input_json TEXT NOT NULL DEFAULT '{}',
        tool_use_id TEXT,
        control_request_id TEXT,
        sdk_permission INTEGER NOT NULL DEFAULT 0 CHECK (sdk_permission IN (0, 1)),
        permission_suggestions_json TEXT NOT NULL DEFAULT '[]',
        reason TEXT,
        fallback_resume INTEGER NOT NULL DEFAULT 0 CHECK (fallback_resume IN (0, 1)),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (json_valid(tool_input_json)),
        CHECK (json_valid(permission_suggestions_json)),
        CHECK (json_valid(metadata_json))
      ) STRICT;

      CREATE TABLE file_changes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        path TEXT NOT NULL,
        previous_path TEXT,
        change_type TEXT NOT NULL CHECK (change_type IN ('created', 'modified', 'deleted', 'renamed')),
        additions INTEGER,
        deletions INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        CHECK (json_valid(metadata_json))
      ) STRICT;

      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        CHECK (json_valid(metadata_json))
      ) STRICT;

      CREATE TABLE claude_config (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        model_context_tokens INTEGER NOT NULL CHECK (model_context_tokens >= 1000),
        auto_compact_ratio REAL NOT NULL CHECK (auto_compact_ratio >= 0.1 AND auto_compact_ratio <= 0.9),
        auto_compact_enabled INTEGER NOT NULL CHECK (auto_compact_enabled IN (0, 1)),
        mcp_tool_allowlist_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        available INTEGER NOT NULL CHECK (available IN (0, 1)),
        version TEXT NOT NULL,
        latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
        authenticated INTEGER NOT NULL CHECK (authenticated IN (0, 1)),
        last_check_at INTEGER,
        health_message TEXT,
        updated_at INTEGER NOT NULL,
        CHECK (json_valid(mcp_tool_allowlist_json))
      ) STRICT;

      CREATE INDEX auth_sessions_user_expires_idx ON auth_sessions(user_id, expires_at);
      CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
      CREATE INDEX team_members_user_idx ON team_members(user_id, team_id);
      CREATE INDEX agents_team_idx ON agents(team_id, type);
      CREATE INDEX sessions_team_updated_idx ON sessions(team_id, updated_at DESC, id DESC);
      CREATE INDEX sessions_owner_updated_idx ON sessions(created_by, updated_at DESC, id DESC);
      CREATE INDEX sessions_status_updated_idx ON sessions(status, updated_at DESC);
      CREATE INDEX sessions_archived_idx ON sessions(archived_at, updated_at DESC);
      CREATE INDEX turns_session_created_idx ON turns(session_id, created_at DESC, id DESC);
      CREATE UNIQUE INDEX turns_one_active_per_session_idx
        ON turns(session_id)
        WHERE status IN ('queued', 'running', 'waiting_permission');
      CREATE INDEX messages_session_created_idx ON messages(session_id, created_at DESC, id DESC);
      CREATE INDEX permissions_session_created_idx ON permissions(session_id, created_at DESC, id DESC);
      CREATE INDEX permissions_pending_expiry_idx ON permissions(expires_at, session_id) WHERE status = 'pending';
      CREATE UNIQUE INDEX permissions_control_request_idx
        ON permissions(session_id, control_request_id)
        WHERE control_request_id IS NOT NULL;
      CREATE INDEX file_changes_session_created_idx ON file_changes(session_id, created_at DESC, id DESC);
      CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC, id DESC);
      CREATE INDEX audit_logs_user_created_idx ON audit_logs(user_id, created_at DESC, id DESC);
      CREATE INDEX audit_logs_target_idx ON audit_logs(target_type, target_id, created_at DESC);

      CREATE VIRTUAL TABLE session_search USING fts5(
        title,
        summary,
        content = 'sessions',
        content_rowid = 'rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER sessions_search_insert AFTER INSERT ON sessions BEGIN
        INSERT INTO session_search(rowid, title, summary) VALUES (new.rowid, new.title, coalesce(new.summary, ''));
      END;
      CREATE TRIGGER sessions_search_delete AFTER DELETE ON sessions BEGIN
        INSERT INTO session_search(session_search, rowid, title, summary)
        VALUES ('delete', old.rowid, old.title, coalesce(old.summary, ''));
      END;
      CREATE TRIGGER sessions_search_update AFTER UPDATE OF title, summary ON sessions BEGIN
        INSERT INTO session_search(session_search, rowid, title, summary)
        VALUES ('delete', old.rowid, old.title, coalesce(old.summary, ''));
        INSERT INTO session_search(rowid, title, summary) VALUES (new.rowid, new.title, coalesce(new.summary, ''));
      END;

      CREATE VIRTUAL TABLE message_search USING fts5(
        content,
        content = 'messages',
        content_rowid = 'rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER messages_search_insert AFTER INSERT ON messages BEGIN
        INSERT INTO message_search(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN
        INSERT INTO message_search(message_search, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER messages_search_update AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO message_search(message_search, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO message_search(rowid, content) VALUES (new.rowid, new.content);
      END;
    `,
  },
  {
    version: 2,
    name: "team_config_templates",
    sql: `
      CREATE TABLE team_config_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        workspace_mode TEXT NOT NULL CHECK (workspace_mode IN ('shared', 'isolated')),
        model_context_tokens INTEGER NOT NULL CHECK (model_context_tokens >= 1000),
        auto_compact_ratio REAL NOT NULL CHECK (auto_compact_ratio >= 0.1 AND auto_compact_ratio <= 0.9),
        auto_compact_enabled INTEGER NOT NULL CHECK (auto_compact_enabled IN (0, 1)),
        mcp_tool_allowlist_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (json_valid(mcp_tool_allowlist_json))
      ) STRICT;
      CREATE INDEX team_config_templates_updated_idx ON team_config_templates(updated_at DESC, id DESC);
    `,
  },
  {
    version: 3,
    name: "team_runtime_defaults",
    sql: `
      ALTER TABLE teams ADD COLUMN runtime_defaults_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(runtime_defaults_json));
    `,
  },
];

export function migrateSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const applied = new Set(
    (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, Date.now());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

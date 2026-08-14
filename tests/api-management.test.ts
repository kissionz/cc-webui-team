import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digestSessionToken } from "../src/auth/session-token.js";
import type { AppConfig } from "../src/config.js";
import type { Agent, ClaudeConfig, ConversationSession, MaxComputeConfig, Team, TeamMember, User } from "../src/domain/index.js";
import { SseHub } from "../src/events/sse.js";
import { ApiServer } from "../src/http/api-server.js";
import { PersistenceRepository } from "../src/persistence/index.js";
import type { ClaudeRuntimeManager } from "../src/runtime/claude-runtime.js";
import { redactRecord } from "../src/observability/logger.js";
import { SqliteRuntimeStore } from "../src/services/runtime-store.js";
import { LineageScheduler } from "../src/lineage/scheduler.js";
import { ColumnLineageAnalyzer } from "../src/lineage/column-analyzer.js";
import { SecretBox } from "../src/security/secret-box.js";

const roots: string[] = [];
const now = 1_900_000_000_000;

interface ResponseResult { status: number; headers: Record<string, string | string[]>; body: string }

describe("management API", () => {
  let repository: PersistenceRepository;
  let api: ApiServer;
  let events: SseHub;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cc-api-management-"));
    roots.push(root);
    const workspace = join(root, "workspaces");
    await mkdir(workspace);
    const opened = await PersistenceRepository.open({ databasePath: join(root, "app.sqlite"), now: () => now });
    repository = opened.repository;
    seed(repository, workspace);
    const runtime = {
      metricsSnapshot: () => ({ activeSessions: 0, schedulerQueued: 0, schedulerRunning: 0 }),
      submit: async () => { throw new Error("not exercised"); },
      sendGuidance: () => false,
      interrupt: async () => false,
      stop: () => false,
      decidePermission: async () => ({ ok: false as const, reason: "not_found" as const }),
    };
    const config: AppConfig = {
      rootDir: root, publicDir: join(root, "public"), host: "127.0.0.1", port: 8068, dataDir: root,
      databaseFile: join(root, "app.sqlite"), legacyJsonFile: join(root, "db.json"), workspaceRoot: workspace,
      claudeCommand: "claude", claudeArgs: [], adminPassword: "password", seedDemoUsers: false,
      sessionTtlMs: 60_000, maxBodySize: 1024 * 1024, cookieSecure: false,
      allowedOrigins: ["http://localhost:8068"], concurrency: { global: 2, perTeam: 1, perUser: 1 },
      modelContextTokens: 1_000_000, autoCompactRatio: 0.62, autoCompactEnabled: true, mcpToolAllowlist: [],
      credentialEncryptionKey: "", credentialKeyFile: join(root, "credential.key"),
      maxCompute: { enabled: false, command: "auto", args: "", project: "", scheduleTime: "06:15" },
      backup: { enabled: false, directory: join(root, "backups"), intervalMs: 60_000, retention: 2 },
    };
    events = new SseHub();
    const secretBox = SecretBox.fromKey(Buffer.alloc(32, 7));
    api = new ApiServer({
      repository, config, runtime: runtime as unknown as ClaudeRuntimeManager, events, now: () => now,
      logger: { info() {}, warn() {}, error() {} },
      lineageScheduler: new LineageScheduler({ repository, secretBox, now: () => now }),
      columnLineageAnalyzer: new ColumnLineageAnalyzer(), secretBox,
    });
  });

  afterEach(async () => {
    repository?.close();
    for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
  });

  it("filters and exports audit logs only for administrators", async () => {
    repository.appendAuditLog({ id: "audit_1", userId: "admin", action: "session.created", targetType: "session", targetId: "s1", metadata: {}, createdAt: now });
    repository.appendAuditLog({ id: "audit_2", userId: "admin", action: "=HYPERLINK(\"https://example.test\")", targetType: "session", targetId: "s2", metadata: {}, createdAt: now - 1 });
    const page = await call(api, "GET", "/api/audit-logs?action=session.created&limit=1", "admin-token");
    expect(page.status).toBe(200);
    expect(JSON.parse(page.body)).toMatchObject({ auditLogs: [{ id: "audit_1" }] });
    const denied = await call(api, "GET", "/api/audit-logs", "member-token");
    expect(denied.status).toBe(403);
    const exported = await call(api, "GET", "/api/audit-logs/export?format=csv", "admin-token");
    expect(exported.status).toBe(200);
    expect(exported.headers["Content-Disposition"]).toContain("audit-logs-");
    expect(exported.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(exported.body.startsWith("\uFEFF")).toBe(true);
    expect(exported.body).toContain("session.created");
    expect(exported.body).toContain(`"'=HYPERLINK(""https://example.test"")"`);
  });

  it("rejects oversized audit exports instead of returning a silently truncated file", async () => {
    repository.transaction(() => {
      for (let index = 0; index < 10_001; index += 1) {
        repository.appendAuditLog({
          id: `bulk_${String(index).padStart(5, "0")}`,
          userId: "admin",
          action: "session.updated",
          targetType: "session",
          targetId: `session_${index}`,
          metadata: {},
          createdAt: now - index,
        });
      }
    });

    const result = await call(api, "GET", "/api/audit-logs/export?format=json", "admin-token");
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toMatchObject({ code: "EXPORT_TOO_LARGE" });
  });

  it("exports visible sessions and rejects private exports from another member", async () => {
    const visible = await call(api, "GET", "/api/sessions/s-team/export?format=markdown", "member-token");
    expect(visible.status).toBe(200);
    expect(visible.headers["Content-Type"]).toContain("text/markdown");
    expect(visible.headers["Content-Disposition"]).toContain("attachment;");
    expect(visible.headers["Content-Disposition"]).toContain(".md");
    expect(visible.body).toContain("# Team session");
    const denied = await call(api, "GET", "/api/sessions/s-private/export?format=json", "member-token");
    expect(denied.status).toBe(403);
  });

  it("batch archives terminal sessions and reports active sessions as skipped", async () => {
    const publish = vi.spyOn(events, "publish");
    const result = await call(api, "POST", "/api/admin/sessions/archive-batch", "admin-token", { sessionIds: ["s-team", "s-running", "missing"], archived: true });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ updatedCount: 1, skipped: [{ id: "s-running", code: "SESSION_ACTIVE" }, { id: "missing", code: "SESSION_NOT_FOUND" }] });
    expect(repository.getSession("s-team")?.archivedAt).toBe(now);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.updated", sessionId: "s-team" }),
      expect.arrayContaining(["admin", "member", "owner"]),
    );
  });

  it("paginates archived sessions without active sessions consuming the page", async () => {
    const archived = repository.getSession("s-team");
    expect(archived).not.toBeNull();
    repository.saveSession({ ...archived!, archivedAt: now, updatedAt: now });
    repository.createSession({ ...archived!, id: "z-active", title: "Newer active", archivedAt: null, updatedAt: now });

    const result = await call(api, "GET", "/api/sessions?teamId=team&archived=archived&limit=1", "admin-token");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ sessions: [{ id: "s-team" }], nextCursor: null });

    const oversizedQuery = await call(api, "GET", `/api/sessions?teamId=team&q=${"x".repeat(501)}`, "admin-token");
    expect(oversizedQuery.status).toBe(400);
    expect(JSON.parse(oversizedQuery.body)).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("saves and applies a template without replacing executable or workspace paths", async () => {
    const created = await call(api, "POST", "/api/admin/team-templates", "admin-token", {
      name: "Large context", description: "shared runtime defaults", workspaceMode: "isolated",
      modelContextTokens: 2_000_000, autoCompactRatio: 0.5, autoCompactEnabled: false,
      mcpToolAllowlist: ["mcp__safe__read"],
    });
    expect(created.status).toBe(201);
    const templateId = JSON.parse(created.body).template.id as string;
    const updated = await call(api, "POST", "/api/admin/team-templates", "admin-token", {
      id: templateId, name: "Large context v2", description: "updated defaults", workspaceMode: "isolated",
      modelContextTokens: 2_000_000, autoCompactRatio: 0.5, autoCompactEnabled: false,
      mcpToolAllowlist: ["mcp__safe__read"],
    });
    expect(updated.status).toBe(200);
    const listed = await call(api, "GET", "/api/admin/team-templates", "admin-token");
    expect(JSON.parse(listed.body)).toMatchObject({ templates: [{ id: templateId, name: "Large context v2" }] });
    const applied = await call(api, "POST", `/api/admin/team-templates/${encodeURIComponent(templateId)}/apply`, "admin-token", { teamId: "team" });
    expect(applied.status).toBe(200);
    expect(JSON.parse(applied.body).appliedClaudeConfig.scope).toBe("team");
    expect(repository.getTeam("team")?.workspaceMode).toBe("isolated");
    expect(repository.getTeam("team")?.workspacePath).toContain("workspaces");
    expect(repository.getClaudeConfig()).toMatchObject({ command: "secret-command-path", args: "--safe", modelContextTokens: 1_000_000, autoCompactEnabled: true });
    const store = new SqliteRuntimeStore(repository, () => now);
    expect(await store.getConfig("team")).toMatchObject({ command: "secret-command-path", modelContextTokens: 2_000_000, autoCompactEnabled: false });
    expect(await store.getConfig("team_other")).toMatchObject({ modelContextTokens: 1_000_000, autoCompactEnabled: true });
    const deleted = await call(api, "DELETE", `/api/admin/team-templates/${encodeURIComponent(templateId)}`, "admin-token", {});
    expect(deleted.status).toBe(200);
    expect(repository.getTeamConfigTemplate(templateId)).toBeNull();
  });

  it("returns stable management metrics and structured error request ids", async () => {
    const metrics = await call(api, "GET", "/api/admin/metrics", "admin-token");
    expect(metrics.status).toBe(200);
    expect(JSON.parse(metrics.body)).toMatchObject({ sampledAt: now, sessions: { running: 1 }, database: { writeLatencyMs: null }, backup: null });
    const invalid = await call(api, "POST", "/api/admin/sessions/archive-batch", "admin-token", { sessionIds: [], archived: true });
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body).requestId).toMatch(/^request_/);
    expect(invalid.headers["X-Request-Id"]).toBe(JSON.parse(invalid.body).requestId);
    expect(redactRecord({ password: "secret", nested: { apiKey: "key", safe: "ok" } })).toEqual({ password: "[REDACTED]", nested: { apiKey: "[REDACTED]", safe: "ok" } });
  });

  it("rejects expired server-side sessions", async () => {
    repository.saveAuthSession({ token: digestSessionToken("expired-token"), userId: "admin", expiresAt: now, createdAt: now - 60_000, lastSeenAt: now - 60_000 });

    const result = await call(api, "GET", "/api/bootstrap", "expired-token");
    expect(result.status).toBe(401);
  });

  it("requires an exact Origin on cookie-authenticated mutations", async () => {
    const missing = await call(api, "POST", "/api/auth/logout", "admin-token", {}, { origin: null });
    expect(missing.status).toBe(403);
    expect(JSON.parse(missing.body)).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });

    const crossOrigin = await call(api, "POST", "/api/auth/logout", "admin-token", {}, { origin: "http://evil.example", host: "evil.example" });
    expect(crossOrigin.status).toBe(403);
    expect(JSON.parse(crossOrigin.body)).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
  });

  it("enforces configurable role directory visibility in bootstrap and lineage APIs", async () => {
    const initial = await call(api, "GET", "/api/bootstrap", "member-token");
    expect(JSON.parse(initial.body).allowedDirectories).toEqual(["teams"]);
    const denied = await call(api, "GET", "/api/lineage/status", "member-token");
    expect(denied.status).toBe(403);

    const updated = await call(api, "PATCH", "/api/admin/directory-permissions/member", "admin-token", { directories: ["teams", "lineage", "system"] });
    expect(updated.status).toBe(200);
    expect(JSON.parse(updated.body).directories).toEqual(["teams", "lineage"]);
    const allowed = await call(api, "GET", "/api/lineage/status", "member-token");
    expect(allowed.status).toBe(200);
    const refreshed = await call(api, "GET", "/api/bootstrap", "member-token");
    expect(JSON.parse(refreshed.body).allowedDirectories).toEqual(["lineage", "teams"]);
  });

  it("changes another user's role, revokes sessions, and protects the current administrator", async () => {
    const changed = await call(api, "PATCH", "/api/users/owner/role", "admin-token", { role: "admin" });
    expect(changed.status).toBe(200);
    expect(repository.getUser("owner")?.role).toBe("admin");
    const self = await call(api, "PATCH", "/api/users/admin/role", "admin-token", { role: "member" });
    expect(self.status).toBe(409);
    expect(JSON.parse(self.body)).toMatchObject({ code: "CANNOT_CHANGE_OWN_ROLE" });
  });

  it("stores MaxCompute credentials encrypted and never returns the secret", async () => {
    const saved = await call(api, "PATCH", "/api/lineage/config", "admin-token", {
      project: "analytics", endpoint: "https://service.cn-shanghai.maxcompute.aliyun.com/api",
      accessKeyId: "LTAI-test-id", accessKeySecret: "highly-secret", scheduleTime: "05:45",
    });
    expect(saved.status).toBe(200);
    expect(saved.body).not.toContain("highly-secret");
    expect(saved.body).not.toContain("LTAI-test-id");
    expect(JSON.parse(saved.body).config).toMatchObject({ credentialConfigured: true, scheduleTime: "05:45" });
    const stored = repository.getMaxComputeConfig();
    expect(stored?.credentialCiphertext).toMatch(/^v1\./);
    expect(stored?.credentialCiphertext).not.toContain("highly-secret");

    const scoped = await call(api, "PATCH", "/api/lineage/config", "admin-token", {
      collectionMode: "selected", collectionProjects: ["analytics", "finance"],
    });
    expect(scoped.status).toBe(200);
    expect(JSON.parse(scoped.body).config).toMatchObject({ collectionMode: "selected", collectionProjects: ["analytics", "finance"] });
    expect(repository.getMaxComputeConfig()).toMatchObject({ collectionMode: "selected", collectionProjects: ["analytics", "finance"] });

    const missingClient = await call(api, "PATCH", "/api/lineage/config", "admin-token", { command: "definitely-missing-python-test" });
    expect(missingClient.status).toBe(200);
    const tested = await call(api, "POST", "/api/lineage/connection-test", "admin-token", {});
    expect(tested.status).toBe(400);
    expect(JSON.parse(tested.body)).toMatchObject({ code: "PYTHON_NOT_FOUND" });
  });
});

async function call(
  api: ApiServer,
  method: string,
  url: string,
  token: string,
  body?: unknown,
  options: { origin?: string | null; host?: string } = {},
): Promise<ResponseResult> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const request = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  const mutationHeaders = method === "GET" ? {} : {
    ...(options.origin === null ? {} : { origin: options.origin ?? "http://localhost:8068" }),
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
  };
  Object.assign(request, {
    method,
    url,
    headers: { host: options.host ?? "localhost:8068", cookie: `cc_session=${token}`, ...mutationHeaders },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const headers: Record<string, string | string[]> = {};
  let responseBody = "";
  const response = {
    statusCode: 200, headersSent: false, writableEnded: false, destroyed: false,
    setHeader(name: string, value: string | string[]) { headers[name] = value; },
    writeHead(status: number, values: Record<string, string | string[]> = {}) { this.statusCode = status; this.headersSent = true; Object.assign(headers, values); return this; },
    write(chunk: string | Buffer) { responseBody += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk; return true; },
    end(chunk?: string | Buffer) { if (chunk) responseBody += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk; this.writableEnded = true; return this; },
  } as unknown as ServerResponse;
  await api.handle(request, response);
  return { status: response.statusCode, headers, body: responseBody };
}

function seed(repository: PersistenceRepository, workspace: string): void {
  const admin: User = { id: "admin", username: "admin", passwordHash: "unused", displayName: "Admin", email: "admin@example.test", role: "admin", status: "active", createdAt: now, updatedAt: now };
  const member: User = { ...admin, id: "member", username: "member", displayName: "Member", role: "member" };
  const owner: User = { ...member, id: "owner", username: "owner", displayName: "Owner" };
  for (const user of [admin, member, owner]) repository.saveUser(user);
  const team: Team = { id: "team", name: "Team", workspacePath: workspace, workspaceMode: "shared", runtimeDefaults: {}, createdBy: admin.id, createdAt: now, updatedAt: now };
  repository.saveTeam(team);
  repository.saveTeam({ ...team, id: "team_other", name: "Other team" });
  for (const item of [{ userId: "admin", role: "owner" }, { userId: "member", role: "member" }, { userId: "owner", role: "member" }] as const) {
    const membership: TeamMember = { teamId: team.id, userId: item.userId, role: item.role, createdAt: now, updatedAt: now };
    repository.saveTeamMember(membership);
  }
  const agent: Agent = { id: "agent", teamId: team.id, name: "Claude", type: "claude_code", command: "claude", enabled: true, status: "idle", metadata: {}, createdAt: now, updatedAt: now };
  repository.saveAgent(agent);
  const base: ConversationSession = { id: "s-team", teamId: team.id, agentId: agent.id, createdBy: admin.id, title: "Team session", summary: null, summaryUpdatedAt: null, visibility: "team", status: "idle", cwd: workspace, claudeSessionId: null, toolApprovals: { onceTools: [], alwaysTools: [], alwaysServers: [] }, archivedAt: null, pinnedAt: null, createdAt: now, updatedAt: now };
  repository.createSession(base);
  repository.createSession({ ...base, id: "s-private", title: "Private", visibility: "private", createdBy: owner.id });
  repository.createSession({ ...base, id: "s-running", title: "Running", status: "running" });
  repository.appendMessage({ id: "message", sessionId: base.id, senderType: "user", senderId: admin.id, content: "hello", metadata: {}, createdAt: now, updatedAt: null });
  const config: ClaudeConfig = { command: "secret-command-path", args: "--safe", workspaceRoot: workspace, modelContextTokens: 1_000_000, autoCompactRatio: 0.62, autoCompactEnabled: true, mcpToolAllowlist: [], enabled: true, available: true, version: "1", latencyMs: 1, authenticated: true, lastCheckAt: now, healthMessage: null, updatedAt: now };
  repository.saveClaudeConfig(config);
  const maxCompute: MaxComputeConfig = {
    enabled: false, command: "auto", args: "", project: "", endpoint: "", credentialCiphertext: null,
    collectionMode: "all", collectionProjects: [], discoveredProjects: [],
    credentialUpdatedAt: null, scheduleTime: "06:15", timezone: "Asia/Shanghai", lastStartedAt: null,
    lastCompletedAt: null, lastStatus: "idle", lastError: null, lastDataDate: null, nextRunAt: null, updatedAt: now,
  };
  repository.saveMaxComputeConfig(maxCompute);
  repository.saveAuthSession({ token: digestSessionToken("admin-token"), userId: admin.id, expiresAt: now + 60_000, createdAt: now, lastSeenAt: now });
  repository.saveAuthSession({ token: digestSessionToken("member-token"), userId: member.id, expiresAt: now + 60_000, createdAt: now, lastSeenAt: now });
}

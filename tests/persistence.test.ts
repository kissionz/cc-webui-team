import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Agent,
  ConversationSession,
  Message,
  Permission,
  Team,
  TeamMember,
  Turn,
  User,
} from "../src/domain/index.js";
import { PersistenceRepository } from "../src/persistence/index.js";
import { digestSessionToken } from "../src/auth/session-token.js";

const roots: string[] = [];
const clock = 1_800_000_000_000;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function repository(now = clock): Promise<{ repository: PersistenceRepository; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "cc-persistence-"));
  roots.push(root);
  const opened = await PersistenceRepository.open({ databasePath: join(root, "app.sqlite"), now: () => now });
  seedRelations(opened.repository);
  return { repository: opened.repository, root };
}

function seedRelations(repo: PersistenceRepository): void {
  repo.saveUser(user());
  repo.saveTeam(team());
  repo.saveTeamMember(member());
  repo.saveAgent(agent());
}

function user(overrides: Partial<User> = {}): User {
  return { id: "u1", username: "alice", passwordHash: "salt:hash", displayName: "Alice", email: "a@example.test", role: "admin", status: "active", createdAt: clock, updatedAt: clock, ...overrides };
}

function team(overrides: Partial<Team> = {}): Team {
  return { id: "t1", name: "Platform", workspacePath: "/workspaces/platform", workspaceMode: "shared", createdBy: "u1", createdAt: clock, updatedAt: clock, ...overrides };
}

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return { teamId: "t1", userId: "u1", role: "owner", createdAt: clock, updatedAt: clock, ...overrides };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return { id: "a1", teamId: "t1", name: "Claude", type: "claude_code", command: "claude", enabled: true, status: "idle", metadata: {}, createdAt: clock, updatedAt: clock, ...overrides };
}

function session(id: string, updatedAt: number, overrides: Partial<ConversationSession> = {}): ConversationSession {
  return { id, teamId: "t1", agentId: "a1", createdBy: "u1", title: `Session ${id}`, summary: null, summaryUpdatedAt: null, visibility: "private", status: "idle", cwd: "/workspaces/platform", claudeSessionId: null, toolApprovals: { onceTools: [], alwaysTools: [], alwaysServers: [] }, archivedAt: null, pinnedAt: null, createdAt: updatedAt, updatedAt, ...overrides };
}

function message(id: string, sessionId: string, createdAt: number, content = id): Message {
  return { id, sessionId, senderType: "user", senderId: "u1", content, metadata: {}, createdAt, updatedAt: null };
}

function turn(id: string, sessionId: string, status: Turn["status"]): Turn {
  return { id, sessionId, requestedByUserId: "u1", status, prompt: "do work", retryOfMessageId: null, claudeSessionId: null, startedAt: clock, finishedAt: null, stopReason: null, error: null, createdAt: clock, updatedAt: clock };
}

function permission(id: string, sessionId: string, expiresAt: number): Permission {
  return { id, sessionId, agentId: "a1", requestedByUserId: "u1", type: "mcp_tool", risk: "medium", summary: "Use shell", payload: "task", turnId: null, status: "pending", expiresAt, decidedBy: null, decidedAt: null, decision: null, toolName: "Bash", serverName: null, toolInput: {}, toolUseId: null, controlRequestId: null, sdkPermission: true, permissionSuggestions: [], reason: "required", fallbackResume: false, metadata: {}, createdAt: clock, updatedAt: clock };
}

describe("PersistenceRepository", () => {
  it("uses WAL, enforces one active turn, and persists typed records", async () => {
    const { repository: repo } = await repository();
    expect(repo.database.pragma("journal_mode", { simple: true })).toBe("wal");
    repo.createSession(session("s1", clock));
    repo.createTurn(turn("turn1", "s1", "running"));
    expect(() => repo.createTurn(turn("turn2", "s1", "queued"))).toThrow();
    expect(repo.getSession("s1")?.toolApprovals).toEqual({ onceTools: [], alwaysTools: [], alwaysServers: [] });
    expect(repo.getActiveTurn("s1")?.id).toBe("turn1");
    repo.close();
  });

  it("paginates sessions, messages, and audits with stable cursors", async () => {
    const { repository: repo } = await repository();
    for (let index = 1; index <= 4; index += 1) {
      repo.createSession(session(`s${index}`, clock + index));
      repo.appendMessage(message(`m${index}`, `s${index}`, clock + index));
      repo.appendAuditLog({ id: `log${index}`, userId: "u1", action: "session.created", targetType: "session", targetId: `s${index}`, metadata: {}, createdAt: clock + index });
    }
    const first = repo.listSessions({ teamIds: ["t1"], limit: 2 });
    const second = repo.listSessions({ teamIds: ["t1"], limit: 2, cursor: first.nextCursor });
    expect(first.items.map((item) => item.id)).toEqual(["s4", "s3"]);
    expect(second.items.map((item) => item.id)).toEqual(["s2", "s1"]);
    const auditFirst = repo.listAuditLogs({ limit: 2 });
    expect(repo.listAuditLogs({ limit: 2, cursor: auditFirst.nextCursor }).items).toHaveLength(2);
    repo.appendMessage(message("m5", "s1", clock + 5));
    const messages = repo.listMessages("s1", { limit: 1 });
    expect(messages.items[0]?.id).toBe("m5");
    expect(repo.listMessages("s1", { limit: 1, cursor: messages.nextCursor }).items[0]?.id).toBe("m1");
    repo.close();
  });

  it("searches both conversation metadata and message content with FTS5", async () => {
    const { repository: repo } = await repository();
    repo.createSession(session("s1", clock, { title: "Database migration plan", summary: "Move durable state" }));
    repo.appendMessage(message("m1", "s1", clock + 1, "Add a concurrency-safe scheduler"));
    repo.createSession(session("s2", clock + 2, { title: "部署后的第一条会话" }));
    repo.appendMessage(message("m2", "s2", clock + 2, "检查中文搜索体验"));
    expect(repo.search({ query: "migration", teamIds: ["t1"] }).items[0]).toMatchObject({ kind: "session", sessionId: "s1" });
    expect(repo.search({ query: "scheduler", teamIds: ["t1"] }).items[0]).toMatchObject({ kind: "message", messageId: "m1" });
    expect(repo.searchSessions({ query: "部署", teamIds: ["t1"] }).items[0]?.id).toBe("s2");
    expect(repo.searchSessions({ query: "中文搜索", teamIds: ["t1"] }).items[0]?.id).toBe("s2");
    expect(() => repo.search({ query: 'C++ "quoted"', teamIds: ["t1"] })).not.toThrow();
    repo.close();
  });

  it("decides pending permissions atomically and expires stale attempts", async () => {
    const { repository: repo } = await repository();
    repo.createSession(session("s1", clock));
    repo.createPermission(permission("p1", "s1", clock + 100));
    expect(repo.decidePermissionAtomic("p1", "u1", "approved", "allow_once", clock)).toMatchObject({ outcome: "decided", permission: { status: "approved" } });
    expect(repo.decidePermissionAtomic("p1", "u1", "rejected", "rejected", clock + 1)).toMatchObject({ outcome: "already_decided", permission: { status: "approved" } });
    repo.createPermission(permission("p2", "s1", clock - 1));
    expect(repo.decidePermissionAtomic("p2", "u1", "approved", "allow_once", clock)).toMatchObject({ outcome: "expired", permission: { status: "expired" } });
    repo.close();
  });

  it("reconciles volatile runtime state after restart", async () => {
    const { repository: repo } = await repository();
    repo.saveAgent(agent({ status: "running" }));
    repo.createSession(session("s1", clock, { status: "running" }));
    repo.createTurn(turn("turn1", "s1", "running"));
    repo.createPermission(permission("p1", "s1", clock + 100));
    const result = repo.reconcileAfterRestart(clock);
    expect(result).toEqual({ interruptedSessions: 1, interruptedTurns: 1, stalePermissions: 1, expiredPermissions: 0 });
    expect(repo.getSession("s1")?.status).toBe("interrupted");
    expect(repo.getTurn("turn1")).toMatchObject({ status: "interrupted", stopReason: "server_restart" });
    expect(repo.getPermission("p1")?.status).toBe("stale");
    expect(repo.getAgent("a1")?.status).toBe("idle");
    repo.close();
  });

  it("imports legacy JSON exactly once, records metadata, and renames the source to a backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-legacy-"));
    roots.push(root);
    const legacyPath = join(root, "db.json");
    const legacy = {
      sessionsByToken: { token1: { userId: "u1", expiresAt: clock + 5000 } },
      users: [user()], teams: [team()], members: [member()], agents: [agent()],
      sessions: [session("s1", clock)], messages: [message("m1", "s1", clock, "legacy content")],
      permissions: [{
        id: "legacy-permission", sessionId: "s1", agentId: "a1", requestedByUserId: "u1",
        type: "platform_gate", risk: "high", summary: "Legacy approval", payload: "deploy",
        status: "approved", expiresAt: clock + 5_000, decidedBy: "u1", decidedAt: clock,
        decision: "approved", createdAt: clock, updatedAt: clock,
      }], fileChanges: [], auditLogs: [],
      claudeConfig: { command: "claude", args: "", workspaceRoot: "/workspaces", modelContextTokens: 1000000, autoCompactRatio: 0.62, autoCompactEnabled: true, mcpToolAllowlist: [], enabled: true, available: false, version: "unknown", latencyMs: 0, authenticated: false, lastCheckAt: null },
    };
    await writeFile(legacyPath, JSON.stringify(legacy));
    const databasePath = join(root, "app.sqlite");
    const opened = await PersistenceRepository.open({ databasePath, legacyJsonPath: legacyPath, now: () => clock });
    expect(opened.result.importedLegacyJson).toBe(true);
    expect(opened.repository.getMessage("m1")?.content).toBe("legacy content");
    expect(opened.repository.getAuthSession(digestSessionToken("token1"), clock)?.userId).toBe("u1");
    expect(opened.repository.getAuthSession("token1", clock)).toBeNull();
    expect(opened.repository.getPermission("legacy-permission")?.decision).toBe("allow_once");
    expect(await readFile(opened.result.legacyBackupPath!, "utf8")).toContain("legacy content");
    expect(opened.repository.getMeta("legacy_json_imported_at")).toBe(String(clock));
    opened.repository.close();
    const reopened = await PersistenceRepository.open({ databasePath, legacyJsonPath: legacyPath, now: () => clock });
    expect(reopened.result.importedLegacyJson).toBe(false);
    reopened.repository.close();
  });
});

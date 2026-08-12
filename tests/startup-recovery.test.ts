import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Agent, ClaudeConfig, ConversationSession, Team, Turn, User } from "../src/domain/index.js";
import type { StructuredLogger } from "../src/observability/logger.js";
import { PersistenceRepository } from "../src/persistence/index.js";
import { ClaudeRuntimeManager } from "../src/runtime/claude-runtime.js";
import { recoverQueuedRuntimeTurns } from "../src/services/runtime-recovery.js";
import { SqliteRuntimeStore } from "../src/services/runtime-store.js";

const roots: string[] = [];
const clock = 1_900_000_000_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("startup queued-turn recovery", () => {
  it("preserves and executes queued work in FIFO order, interrupts running work, and terminates invalid queued work", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-startup-recovery-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const databasePath = join(root, "app.sqlite");
    await mkdir(workspace);

    const initial = await PersistenceRepository.open({ databasePath, now: () => clock });
    seed(initial.repository, workspace);
    initial.repository.close();

    const reopened = await PersistenceRepository.open({ databasePath, now: () => clock + 100 });
    const repository = reopened.repository;
    expect(reopened.result.reconciliation).toMatchObject({ interruptedTurns: 1, interruptedSessions: 1 });
    expect(repository.getTurn("turn-running")?.status).toBe("interrupted");
    expect(repository.getSession("session-first")?.status).toBe("queued");
    expect(repository.getTurn("turn-first")?.status).toBe("queued");
    expect(repository.listQueuedTurns().map((turn) => turn.id)).toEqual(["turn-first", "turn-second", "turn-invalid"]);

    const started: string[] = [];
    const runtime = new ClaudeRuntimeManager({
      store: new SqliteRuntimeStore(repository, () => Date.now()),
      events: { publish: () => undefined },
      limits: { global: 1, perTeam: 1, perUser: 1 },
      queryFactory: ({ prompt }) => (async function* () {
        const first = await prompt[Symbol.asyncIterator]().next();
        started.push(String(first.value?.message.content ?? ""));
        yield { type: "result", result: "done", is_error: false };
      })(),
    });
    const warnings: Record<string, unknown>[] = [];
    const logger: StructuredLogger = {
      info() {},
      warn(_event, fields = {}) { warnings.push(fields); },
      error() {},
    };
    const report = recoverQueuedRuntimeTurns(repository, runtime, logger, () => clock + 200);
    expect(report).toEqual({ recovered: 2, failed: 1 });

    await waitFor(() => repository.getTurn("turn-first")?.status === "completed" && repository.getTurn("turn-second")?.status === "completed");
    expect(started).toHaveLength(2);
    expect(started[0]).toContain("first prompt");
    expect(started[1]).toContain("second prompt");
    expect(repository.getTurn("turn-invalid")).toMatchObject({ status: "failed", stopReason: "startup_recovery_invalid" });
    expect(repository.getSession("session-invalid")?.status).toBe("interrupted");
    expect(repository.listAuditLogs({ action: "turn.recovery_failed" }).items[0]?.targetId).toBe("turn-invalid");
    expect(warnings[0]).toMatchObject({ turnId: "turn-invalid" });
    repository.close();
  });
});

function seed(repository: PersistenceRepository, workspace: string): void {
  const user: User = { id: "user", username: "user", passwordHash: "unused", displayName: "User", email: "", role: "admin", status: "active", createdAt: clock, updatedAt: clock };
  const team: Team = { id: "team", name: "Team", workspacePath: workspace, workspaceMode: "shared", runtimeDefaults: {}, createdBy: user.id, createdAt: clock, updatedAt: clock };
  const agent: Agent = { id: "agent", teamId: team.id, name: "Claude", type: "claude_code", command: "claude", enabled: true, status: "running", metadata: {}, createdAt: clock, updatedAt: clock };
  repository.saveUser(user);
  repository.saveTeam(team);
  repository.saveTeamMember({ teamId: team.id, userId: user.id, role: "owner", createdAt: clock, updatedAt: clock });
  repository.saveAgent(agent);
  repository.saveClaudeConfig(config(workspace));

  const sessions: ConversationSession[] = [
    session("session-first", "queued", team, agent, user, clock + 10),
    session("session-second", "queued", team, agent, user, clock + 20),
    session("session-invalid", "queued", team, agent, user, clock + 30),
    session("session-running", "running", team, agent, user, clock + 5),
  ];
  for (const value of sessions) repository.createSession(value);
  repository.createTurn(turn("turn-first", "session-first", "queued", "first prompt", "user", clock + 10));
  repository.createTurn(turn("turn-second", "session-second", "queued", "second prompt", "user", clock + 20));
  repository.createTurn(turn("turn-invalid", "session-invalid", "queued", "orphan prompt", null, clock + 30));
  repository.createTurn(turn("turn-running", "session-running", "running", "was running", "user", clock + 5));
}

function session(id: string, status: ConversationSession["status"], team: Team, agent: Agent, user: User, at: number): ConversationSession {
  return { id, teamId: team.id, agentId: agent.id, createdBy: user.id, title: id, summary: null, summaryUpdatedAt: null, visibility: "private", status, cwd: team.workspacePath, claudeSessionId: null, toolApprovals: { onceTools: [], alwaysTools: [], alwaysServers: [] }, archivedAt: null, pinnedAt: null, createdAt: at, updatedAt: at };
}

function turn(id: string, sessionId: string, status: Turn["status"], prompt: string, requestedByUserId: string | null, at: number): Turn {
  return { id, sessionId, requestedByUserId, status, prompt, retryOfMessageId: null, claudeSessionId: null, startedAt: status === "running" ? at : null, finishedAt: null, stopReason: null, error: null, createdAt: at, updatedAt: at };
}

function config(workspaceRoot: string): ClaudeConfig {
  return { command: "claude", args: "", workspaceRoot, modelContextTokens: 100_000, autoCompactRatio: 0.6, autoCompactEnabled: true, mcpToolAllowlist: [], enabled: true, available: true, version: "test", latencyMs: 1, authenticated: true, lastCheckAt: clock, healthMessage: null, updatedAt: clock };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for recovered turns.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

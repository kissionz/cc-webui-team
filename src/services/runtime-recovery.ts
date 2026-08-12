import { createId, type JsonObject, type Turn } from "../domain/index.js";
import type { StructuredLogger } from "../observability/logger.js";
import type { PersistenceRepository } from "../persistence/index.js";
import type { RuntimeTurnPayload } from "../runtime/claude-runtime.js";
import type { PersistedTurn } from "../runtime/scheduler.js";

export interface QueuedRuntimeRecoveryTarget {
  recover(turns: ReadonlyArray<PersistedTurn<RuntimeTurnPayload>>): void;
}

export interface QueuedRuntimeRecoveryReport {
  recovered: number;
  failed: number;
}

/**
 * Reconstructs persisted queue entries without recreating their database rows.
 * Invalid/orphaned entries are terminated explicitly so startup never loops on
 * unrecoverable work or silently drops a user's request.
 */
export function recoverQueuedRuntimeTurns(
  repository: PersistenceRepository,
  runtime: QueuedRuntimeRecoveryTarget,
  logger: StructuredLogger,
  now: () => number = Date.now,
): QueuedRuntimeRecoveryReport {
  const recoverable: Array<PersistedTurn<RuntimeTurnPayload>> = [];
  let failed = 0;

  for (const turn of repository.listQueuedTurns()) {
    const session = repository.getSession(turn.sessionId);
    const team = session ? repository.getTeam(session.teamId) : null;
    const user = turn.requestedByUserId ? repository.getUser(turn.requestedByUserId) : null;
    const agent = session ? repository.getAgent(session.agentId) : null;
    const reason = !session
      ? "Queued turn session is missing."
      : !team
        ? "Queued turn team is missing."
        : !user || user.status !== "active"
          ? "Queued turn requester is missing or disabled."
          : !agent || !agent.enabled
            ? "Queued turn agent is missing or disabled."
            : null;

    if (reason || !session || !team || !user) {
      failQueuedTurn(repository, turn, reason ?? "Queued turn dependencies are invalid.", now(), logger);
      failed += 1;
      continue;
    }

    if (session.status !== "queued") {
      repository.saveSession({ ...session, status: "queued", updatedAt: now() });
    }
    recoverable.push({
      id: turn.id,
      sessionId: session.id,
      teamId: team.id,
      userId: user.id,
      payload: { sessionId: session.id, teamId: team.id, userId: user.id, prompt: turn.prompt },
      status: "queued",
      createdAt: turn.createdAt,
      queuedAt: turn.createdAt,
    });
  }

  if (recoverable.length) runtime.recover(recoverable);
  return { recovered: recoverable.length, failed };
}

function failQueuedTurn(
  repository: PersistenceRepository,
  turn: Turn,
  reason: string,
  finishedAt: number,
  logger: StructuredLogger,
): void {
  const session = repository.getSession(turn.sessionId);
  const knownUser = turn.requestedByUserId ? repository.getUser(turn.requestedByUserId) : null;
  repository.transaction(() => {
    repository.saveTurn({
      ...turn,
      status: "failed",
      finishedAt,
      stopReason: "startup_recovery_invalid",
      error: reason,
      updatedAt: finishedAt,
    });
    if (session) {
      repository.saveSession({ ...session, status: "interrupted", updatedAt: finishedAt });
      const agent = repository.getAgent(session.agentId);
      if (agent) repository.saveAgent({ ...agent, status: "idle", updatedAt: finishedAt });
    }
    const metadata: JsonObject = { sessionId: turn.sessionId, reason };
    repository.appendAuditLog({
      id: createId("audit"),
      userId: knownUser?.id ?? null,
      action: "turn.recovery_failed",
      targetType: "turn",
      targetId: turn.id,
      metadata,
      createdAt: finishedAt,
    });
  });
  logger.warn("runtime.queued_turn_recovery_failed", { turnId: turn.id, sessionId: turn.sessionId, reason });
}

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  InterruptRunningRecoveryPolicy,
  RuntimeScheduler,
  SessionAlreadyActiveError,
  type TurnExecutionContext,
} from "../src/runtime/scheduler.js";

type Deferred = {
  resolve: () => void;
  promise: Promise<void>;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("only one active turn is accepted for a session", () => {
  const scheduler = new RuntimeScheduler({
    limits: { global: 1, perTeam: 1, perUser: 1 },
    runner: async () => undefined,
  });
  scheduler.enqueue({ sessionId: "s1", teamId: "t1", userId: "u1", payload: null });
  assert.throws(
    () =>
      scheduler.enqueue({
        sessionId: "s1",
        teamId: "t1",
        userId: "u1",
        payload: null,
      }),
    SessionAlreadyActiveError,
  );
});

test("enforces global, team and user limits while preserving eligible FIFO order", async () => {
  const gates = new Map<string, Deferred>();
  const started: string[] = [];
  const scheduler = new RuntimeScheduler<string, void>({
    limits: { global: 3, perTeam: 1, perUser: 1 },
    runner: async ({ turn }) => {
      started.push(turn.id);
      const gate = deferred();
      gates.set(turn.id, gate);
      await gate.promise;
    },
  });

  scheduler.enqueue({ id: "a", sessionId: "s-a", teamId: "t1", userId: "u1", payload: "a" });
  scheduler.enqueue({ id: "b", sessionId: "s-b", teamId: "t1", userId: "u2", payload: "b" });
  scheduler.enqueue({ id: "c", sessionId: "s-c", teamId: "t2", userId: "u1", payload: "c" });
  scheduler.enqueue({ id: "d", sessionId: "s-d", teamId: "t2", userId: "u2", payload: "d" });
  scheduler.enqueue({ id: "e", sessionId: "s-e", teamId: "t3", userId: "u3", payload: "e" });
  await nextTask();

  assert.deepEqual(started, ["a", "d", "e"]);
  gates.get("a")?.resolve();
  await nextTask();
  // b is still team-blocked by d; c is user-blocked by d.
  assert.deepEqual(started, ["a", "d", "e"]);

  gates.get("d")?.resolve();
  await nextTask();
  // Both newly eligible entries start in FIFO order when two slots open.
  assert.deepEqual(started, ["a", "d", "e", "b", "c"]);
  gates.get("b")?.resolve();
  await nextTask();
  assert.deepEqual(started, ["a", "d", "e", "b", "c"]);
  gates.get("c")?.resolve();
  gates.get("e")?.resolve();
  await nextTask();
  assert.deepEqual(started, ["a", "d", "e", "b", "c"]);
  await nextTask();
});

test("cancels queued and running turns and dispatches the next turn", async () => {
  const firstGate = deferred();
  const started: string[] = [];
  const scheduler = new RuntimeScheduler<string, void>({
    limits: { global: 1, perTeam: 1, perUser: 1 },
    runner: async ({ turn, signal }: TurnExecutionContext<string>) => {
      started.push(turn.id);
      if (turn.id === "first") {
        await Promise.race([
          firstGate.promise,
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
        ]);
      }
    },
  });

  scheduler.enqueue({ id: "first", sessionId: "s1", teamId: "t1", userId: "u1", payload: "" });
  scheduler.enqueue({ id: "second", sessionId: "s2", teamId: "t1", userId: "u1", payload: "" });
  scheduler.enqueue({ id: "third", sessionId: "s3", teamId: "t1", userId: "u1", payload: "" });
  await nextTask();
  assert.equal(scheduler.cancel("second"), true);
  assert.equal(scheduler.get("second")?.status, "cancelled");
  assert.equal(scheduler.cancel("first"), true);
  await nextTask();
  assert.equal(scheduler.get("first")?.status, "cancelled");
  assert.deepEqual(started, ["first", "third"]);
});

test("startup recovery requeues queued turns and interrupts running turns", async () => {
  const started: string[] = [];
  const scheduler = new RuntimeScheduler<string, void>({
    limits: { global: 1, perTeam: 1, perUser: 1 },
    runner: async ({ turn }) => {
      started.push(turn.id);
    },
  });
  const report = scheduler.recover(
    [
      { id: "old-running", sessionId: "s1", teamId: "t1", userId: "u1", payload: "", status: "running", createdAt: 1, queuedAt: 1, startedAt: 2 },
      { id: "old-queued", sessionId: "s2", teamId: "t1", userId: "u1", payload: "", status: "queued", createdAt: 2, queuedAt: 2 },
    ],
    new InterruptRunningRecoveryPolicy(),
  );
  assert.equal(report.terminal[0]?.status, "interrupted");
  assert.equal(report.requeued[0]?.status, "queued");
  await nextTask();
  assert.deepEqual(started, ["old-queued"]);
});

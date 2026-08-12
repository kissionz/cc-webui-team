import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";

import { SseHub } from "../src/events/sse.js";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly writes: string[] = [];
  private outcomes: boolean[] = [];

  queueOutcomes(...values: boolean[]): void { this.outcomes.push(...values); }
  writeHead(): this { return this; }
  write(value: string): boolean {
    this.writes.push(value);
    return this.outcomes.shift() ?? true;
  }
  end(): this {
    if (!this.writableEnded) {
      this.writableEnded = true;
      this.emit("close");
    }
    return this;
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }
}

function request(lastEventId?: number): IncomingMessage {
  const value = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
  value.headers = lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) };
  return value as unknown as IncomingMessage;
}

afterEach(() => vi.useRealTimers());

describe("SseHub", () => {
  test("queues after backpressure and flushes frames in order on drain", () => {
    const hub = new SseHub({ heartbeatMs: 60_000 });
    const response = new FakeResponse();
    response.queueOutcomes(true, true, false);
    hub.connect(request(), response as unknown as ServerResponse, "user-1");
    hub.publish({ type: "one" }, ["user-1"]);
    hub.publish({ type: "two" }, ["user-1"]);
    expect(hub.metricsSnapshot()).toMatchObject({ backpressureEvents: 1, queuedFrames: 1 });
    response.queueOutcomes(true);
    response.emit("drain");
    expect(hub.metricsSnapshot()).toMatchObject({ queuedFrames: 0, queuedBytes: 0 });
    expect(response.writes.at(-1)).toContain('"type":"two"');
    hub.close();
  });

  test("disconnects a slow client when its bounded queue overflows", () => {
    const hub = new SseHub({ heartbeatMs: 60_000, maximumQueuedFrames: 1, maximumQueuedBytes: 1_024 });
    const response = new FakeResponse();
    response.queueOutcomes(true, true, false);
    hub.connect(request(), response as unknown as ServerResponse, "user-1");
    hub.publish({ type: "one" }, ["user-1"]);
    hub.publish({ type: "two" }, ["user-1"]);
    hub.publish({ type: "three" }, ["user-1"]);
    expect(response.destroyed).toBe(true);
    expect(hub.metricsSnapshot()).toMatchObject({ activeConnections: 0, overflowDisconnects: 1, queuedFrames: 0 });
  });

  test("expires authentication and removes all listeners and timers", () => {
    vi.useFakeTimers();
    const hub = new SseHub({ heartbeatMs: 1_000, now: () => Date.now() });
    const response = new FakeResponse();
    const incoming = request();
    hub.connect(incoming, response as unknown as ServerResponse, "user-1", Date.now() + 50);
    expect(hub.metricsSnapshot().activeConnections).toBe(1);
    vi.advanceTimersByTime(51);
    expect(response.writableEnded).toBe(true);
    expect(hub.metricsSnapshot()).toMatchObject({ activeConnections: 0, expiredDisconnects: 1, closedConnections: 1 });
    expect(response.listenerCount("drain")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(incoming.listenerCount("close")).toBe(0);
  });

  test("replays only audience-visible events after Last-Event-ID", () => {
    const hub = new SseHub({ heartbeatMs: 60_000 });
    hub.publish({ type: "private-a" }, ["user-a"]);
    hub.publish({ type: "private-b" }, ["user-b"]);
    const response = new FakeResponse();
    hub.connect(request(0), response as unknown as ServerResponse, "user-b");
    // Last-Event-ID zero intentionally does not replay.
    expect(response.writes.join("")).not.toContain("private-b");
    response.end();

    const replay = new FakeResponse();
    hub.connect(request(1), replay as unknown as ServerResponse, "user-b");
    expect(replay.writes.join("")).toContain("private-b");
    expect(replay.writes.join("")).not.toContain("private-a");
    hub.close();
  });
});

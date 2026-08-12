import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";

import { OrderedStreamBuffer } from "../src/runtime/stream-buffer.js";

describe("OrderedStreamBuffer", () => {
  test("coalesces deltas on the timer and preserves their order", async () => {
    const writes: string[] = [];
    const buffer = new OrderedStreamBuffer<{ sequence: number }, string>({
      flushIntervalMs: 20,
      maximumBytes: 1_024,
      flush: async (_id, text) => {
        writes.push(text);
        return text;
      },
    });
    buffer.append("message-1", "a", { sequence: 1 });
    buffer.append("message-1", "b", { sequence: 2 });
    buffer.append("message-1", "c", { sequence: 3 });
    await delay(35);
    await buffer.flushAll();
    expect(writes).toEqual(["abc"]);
    expect(buffer.snapshot()).toMatchObject({ bufferedBytes: 0, appendedBytes: 3, persistedBytes: 3, flushes: 1 });
  });

  test("flushes at the byte threshold and serializes concurrent writes", async () => {
    const writes: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const buffer = new OrderedStreamBuffer<Record<string, never>, string>({
      flushIntervalMs: 1_000,
      maximumBytes: 3,
      flush: async (_id, text) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await delay(5);
        writes.push(text);
        active -= 1;
        return text;
      },
    });
    buffer.append("message-1", "abc", {});
    buffer.append("message-1", "def", {});
    await buffer.flushAll();
    expect(writes.join("")).toBe("abcdef");
    expect(maximumActive).toBe(1);
  });

  test("restores a failed batch ahead of newer text for an explicit retry", async () => {
    const writes: string[] = [];
    let fail = true;
    const buffer = new OrderedStreamBuffer<Record<string, never>, string>({
      flushIntervalMs: 1_000,
      flush: async (_id, text) => {
        if (fail) {
          fail = false;
          throw new Error("database busy");
        }
        writes.push(text);
        return text;
      },
    });
    buffer.append("message-1", "first", {});
    await expect(buffer.flushAll()).rejects.toThrow("database busy");
    buffer.append("message-1", "second", {});
    await buffer.flushAll();
    expect(writes).toEqual(["firstsecond"]);
    expect(buffer.snapshot().flushFailures).toBe(1);
  });

  test("terminal flush waits for and retries a failed threshold flush", async () => {
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let attempts = 0;
    const buffer = new OrderedStreamBuffer<Record<string, never>, string>({
      maximumBytes: 1,
      flush: async (_id, text) => {
        attempts += 1;
        if (attempts === 1) {
          await firstStarted;
          throw new Error("transient sqlite busy");
        }
        writes.push(text);
        return text;
      },
    });
    buffer.append("message-1", "durable", {});
    const barrier = buffer.flushAll();
    releaseFirst();
    await barrier;
    expect(writes).toEqual(["durable"]);
    expect(buffer.snapshot()).toMatchObject({ bufferedBytes: 0, flushFailures: 1, flushes: 1 });
  });

  test("does not replay durable text when only the publish callback fails", async () => {
    const writes: string[] = [];
    const buffer = new OrderedStreamBuffer<Record<string, never>, string>({
      flushIntervalMs: 1_000,
      flush: async (_id, text) => {
        writes.push(text);
        return text;
      },
      onFlushed: async () => { throw new Error("SSE unavailable"); },
    });
    buffer.append("message-1", "once", {});
    await expect(buffer.flushAll()).rejects.toThrow("SSE unavailable");
    await buffer.flushAll();
    expect(writes).toEqual(["once"]);
    expect(buffer.snapshot()).toMatchObject({ bufferedBytes: 0, persistedBytes: 4, flushes: 1, flushFailures: 0 });
  });
});

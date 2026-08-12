export interface StreamBufferOptions<TMetadata, TResult> {
  flush: (messageId: string, text: string, metadata: TMetadata) => Promise<TResult>;
  onFlushed?: (result: TResult, text: string) => void | Promise<void>;
  flushIntervalMs?: number;
  maximumBytes?: number;
  now?: () => number;
}

export interface StreamBufferSnapshot {
  bufferedBytes: number;
  appendedBytes: number;
  persistedBytes: number;
  flushes: number;
  flushFailures: number;
  lastFlushAt: number | null;
}

interface Pending<TMetadata> {
  text: string;
  bytes: number;
  metadata: TMetadata;
}

/**
 * Coalesces high-frequency message deltas while preserving per-message order.
 * Flushes are serialized, and explicit flushAll() is a durability barrier used
 * before terminal turn state is persisted.
 */
export class OrderedStreamBuffer<TMetadata, TResult> {
  private readonly pending = new Map<string, Pending<TMetadata>>();
  private readonly flushIntervalMs: number;
  private readonly maximumBytes: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private appendedBytes = 0;
  private persistedBytes = 0;
  private flushes = 0;
  private flushFailures = 0;
  private lastFlushAt: number | null = null;

  constructor(private readonly options: StreamBufferOptions<TMetadata, TResult>) {
    this.flushIntervalMs = options.flushIntervalMs ?? 75;
    this.maximumBytes = options.maximumBytes ?? 8 * 1024;
    this.now = options.now ?? Date.now;
  }

  append(messageId: string, text: string, metadata: TMetadata): void {
    if (!text) return;
    const bytes = Buffer.byteLength(text);
    const current = this.pending.get(messageId);
    this.pending.set(messageId, {
      text: `${current?.text ?? ""}${text}`,
      bytes: (current?.bytes ?? 0) + bytes,
      metadata,
    });
    this.appendedBytes += bytes;
    if ((current?.bytes ?? 0) + bytes >= this.maximumBytes) {
      void this.flushMessage(messageId).catch(() => undefined);
    } else {
      this.schedule();
    }
  }

  async flushMessage(messageId: string): Promise<void> {
    const batch = this.pending.get(messageId);
    if (!batch) {
      await this.tail;
      return;
    }
    this.pending.delete(messageId);
    if (this.pending.size === 0) this.clearTimer();
    const operation = this.tail.then(async () => {
      let result: TResult;
      try {
        result = await this.options.flush(messageId, batch.text, batch.metadata);
      } catch (error) {
        this.flushFailures += 1;
        const newer = this.pending.get(messageId);
        this.pending.set(messageId, {
          text: `${batch.text}${newer?.text ?? ""}`,
          bytes: batch.bytes + (newer?.bytes ?? 0),
          metadata: newer?.metadata ?? batch.metadata,
        });
        throw error;
      }
      // Persistence and notification are separate commit phases. Once storage
      // succeeds, a failed SSE notification must never restore/replay the batch
      // because that would duplicate durable text.
      this.persistedBytes += batch.bytes;
      this.flushes += 1;
      this.lastFlushAt = this.now();
      await this.options.onFlushed?.(result, batch.text);
    });
    this.tail = operation.catch(() => undefined);
    await operation;
  }

  async flushAll(): Promise<void> {
    this.clearTimer();
    // A threshold-triggered flush may already own the pending batch. Wait for
    // it first: on failure it restores the batch, which this barrier must then
    // retry (or surface) rather than incorrectly observing an empty queue.
    await this.tail;
    while (this.pending.size > 0) {
      const messageIds = [...this.pending.keys()];
      for (const messageId of messageIds) await this.flushMessage(messageId);
    }
    await this.tail;
  }

  snapshot(): StreamBufferSnapshot {
    let bufferedBytes = 0;
    for (const batch of this.pending.values()) bufferedBytes += batch.bytes;
    return {
      bufferedBytes,
      appendedBytes: this.appendedBytes,
      persistedBytes: this.persistedBytes,
      flushes: this.flushes,
      flushFailures: this.flushFailures,
      lastFlushAt: this.lastFlushAt,
    };
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushAll().catch(() => this.schedule());
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

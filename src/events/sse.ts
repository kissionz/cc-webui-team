import type { IncomingMessage, ServerResponse } from "node:http";

export interface RealtimeEvent {
  type: string;
  sessionId?: string;
  teamId?: string;
  [key: string]: unknown;
}

interface StoredEvent {
  id: number;
  audience: ReadonlySet<string>;
  event: RealtimeEvent;
}

interface Client {
  userId: string;
  request: IncomingMessage;
  response: ServerResponse;
  heartbeat: NodeJS.Timeout;
  expiry: NodeJS.Timeout | null;
  queue: string[];
  queuedBytes: number;
  blocked: boolean;
  onDrain: () => void;
  onRequestClose: () => void;
  onResponseClose: () => void;
}

export interface SseHubOptions {
  heartbeatMs?: number;
  replayLimit?: number;
  maximumQueuedBytes?: number;
  maximumQueuedFrames?: number;
  now?: () => number;
}

export interface SseMetricsSnapshot {
  activeConnections: number;
  acceptedConnections: number;
  closedConnections: number;
  publishedEvents: number;
  deliveredFrames: number;
  queuedFrames: number;
  queuedBytes: number;
  backpressureEvents: number;
  overflowDisconnects: number;
  expiredDisconnects: number;
  historyLength: number;
  lastPublishAt: number | null;
}

/** In-memory SSE fan-out with bounded per-connection backpressure queues. */
export class SseHub {
  private readonly clients = new Set<Client>();
  private readonly history: StoredEvent[] = [];
  private readonly heartbeatMs: number;
  private readonly replayLimit: number;
  private readonly maximumQueuedBytes: number;
  private readonly maximumQueuedFrames: number;
  private readonly now: () => number;
  private nextEventId = 1;
  private acceptedConnections = 0;
  private closedConnections = 0;
  private publishedEvents = 0;
  private deliveredFrames = 0;
  private backpressureEvents = 0;
  private overflowDisconnects = 0;
  private expiredDisconnects = 0;
  private lastPublishAt: number | null = null;

  constructor(options: SseHubOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.replayLimit = options.replayLimit ?? 1_000;
    this.maximumQueuedBytes = options.maximumQueuedBytes ?? 512 * 1024;
    this.maximumQueuedFrames = options.maximumQueuedFrames ?? 256;
    this.now = options.now ?? Date.now;
  }

  connect(request: IncomingMessage, response: ServerResponse, userId: string, expiresAt?: number): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let client!: Client;
    const heartbeat = setInterval(() => {
      if (response.destroyed || response.writableEnded) {
        this.disconnect(response);
        return;
      }
      this.write(client, `: heartbeat ${this.now()}\n\n`);
    }, this.heartbeatMs);
    heartbeat.unref();
    const remaining = expiresAt === undefined ? Number.POSITIVE_INFINITY : expiresAt - this.now();
    const expiry = Number.isFinite(remaining)
      ? setTimeout(() => {
          this.expiredDisconnects += 1;
          response.end();
          this.disconnect(response);
        }, Math.max(1, remaining))
      : null;
    expiry?.unref();
    client = {
      userId,
      request,
      response,
      heartbeat,
      expiry,
      queue: [],
      queuedBytes: 0,
      blocked: false,
      onDrain: () => this.drain(client),
      onRequestClose: () => this.removeClient(client),
      onResponseClose: () => this.removeClient(client),
    };
    this.clients.add(client);
    this.acceptedConnections += 1;
    response.on("drain", client.onDrain);
    request.once("close", client.onRequestClose);
    response.once("close", client.onResponseClose);

    this.write(client, "retry: 2000\n\n");
    const lastEventId = Number(request.headers["last-event-id"] ?? 0);
    if (Number.isSafeInteger(lastEventId) && lastEventId > 0) {
      for (const stored of this.history) {
        if (stored.id > lastEventId && stored.audience.has(userId)) {
          this.write(client, this.serialize(stored.id, stored.event));
        }
      }
    }
    this.write(client, `event: connected\ndata: {"type":"connected"}\n\n`);
  }

  publish(event: RealtimeEvent, audienceUserIds: Iterable<string>): number {
    const id = this.nextEventId++;
    const audience = new Set(audienceUserIds);
    this.history.push({ id, audience, event });
    if (this.history.length > this.replayLimit) {
      this.history.splice(0, this.history.length - this.replayLimit);
    }
    this.publishedEvents += 1;
    this.lastPublishAt = this.now();
    const payload = this.serialize(id, event);
    for (const client of [...this.clients]) {
      if (audience.has(client.userId) && !client.response.destroyed) this.write(client, payload);
    }
    return id;
  }

  metricsSnapshot(): SseMetricsSnapshot {
    let queuedFrames = 0;
    let queuedBytes = 0;
    for (const client of this.clients) {
      queuedFrames += client.queue.length;
      queuedBytes += client.queuedBytes;
    }
    return {
      activeConnections: this.clients.size,
      acceptedConnections: this.acceptedConnections,
      closedConnections: this.closedConnections,
      publishedEvents: this.publishedEvents,
      deliveredFrames: this.deliveredFrames,
      queuedFrames,
      queuedBytes,
      backpressureEvents: this.backpressureEvents,
      overflowDisconnects: this.overflowDisconnects,
      expiredDisconnects: this.expiredDisconnects,
      historyLength: this.history.length,
      lastPublishAt: this.lastPublishAt,
    };
  }

  close(): void {
    for (const client of [...this.clients]) {
      client.response.end();
      this.removeClient(client);
    }
  }

  private write(client: Client, frame: string): void {
    if (!this.clients.has(client) || client.response.destroyed || client.response.writableEnded) {
      this.removeClient(client);
      return;
    }
    if (client.blocked || client.queue.length > 0) {
      const bytes = Buffer.byteLength(frame);
      if (client.queue.length + 1 > this.maximumQueuedFrames || client.queuedBytes + bytes > this.maximumQueuedBytes) {
        this.overflowDisconnects += 1;
        client.response.destroy();
        this.removeClient(client);
        return;
      }
      client.queue.push(frame);
      client.queuedBytes += bytes;
      return;
    }
    this.deliveredFrames += 1;
    try {
      if (!client.response.write(frame)) {
        client.blocked = true;
        this.backpressureEvents += 1;
      }
    } catch {
      this.removeClient(client);
    }
  }

  private drain(client: Client): void {
    if (!this.clients.has(client)) return;
    client.blocked = false;
    while (!client.blocked && client.queue.length > 0) {
      const frame = client.queue.shift();
      if (!frame) continue;
      client.queuedBytes -= Buffer.byteLength(frame);
      this.deliveredFrames += 1;
      try {
        if (!client.response.write(frame)) {
          client.blocked = true;
          this.backpressureEvents += 1;
        }
      } catch {
        this.removeClient(client);
        return;
      }
    }
  }

  private disconnect(response: ServerResponse): void {
    for (const client of this.clients) {
      if (client.response === response) {
        this.removeClient(client);
        return;
      }
    }
  }

  private removeClient(client: Client): void {
    if (!this.clients.delete(client)) return;
    clearInterval(client.heartbeat);
    if (client.expiry) clearTimeout(client.expiry);
    client.response.off("drain", client.onDrain);
    client.request.off("close", client.onRequestClose);
    client.response.off("close", client.onResponseClose);
    client.queue.length = 0;
    client.queuedBytes = 0;
    this.closedConnections += 1;
  }

  private serialize(id: number, event: RealtimeEvent): string {
    return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
  }
}

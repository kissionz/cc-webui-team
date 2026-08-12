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
  response: ServerResponse;
  heartbeat: NodeJS.Timeout;
  expiry: NodeJS.Timeout;
}

export interface SseHubOptions {
  heartbeatMs?: number;
  replayLimit?: number;
}

export class SseHub {
  private readonly clients = new Set<Client>();
  private readonly history: StoredEvent[] = [];
  private readonly heartbeatMs: number;
  private readonly replayLimit: number;
  private nextEventId = 1;

  constructor(options: SseHubOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.replayLimit = options.replayLimit ?? 1_000;
  }

  connect(request: IncomingMessage, response: ServerResponse, userId: string, expiresAt: number): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write("retry: 2000\n\n");

    const lastEventId = Number(request.headers["last-event-id"] ?? 0);
    if (Number.isSafeInteger(lastEventId) && lastEventId > 0) {
      for (const stored of this.history) {
        if (stored.id > lastEventId && stored.audience.has(userId)) {
          response.write(this.serialize(stored.id, stored.event));
        }
      }
    }

    const heartbeat = setInterval(() => {
      if (response.destroyed || response.writableEnded) {
        this.disconnect(response);
        return;
      }
      response.write(`: heartbeat ${Date.now()}\n\n`);
    }, this.heartbeatMs);
    heartbeat.unref();
    const expiry = setTimeout(() => response.end(), Math.max(1, expiresAt - Date.now()));
    expiry.unref();

    const client = { userId, response, heartbeat, expiry };
    this.clients.add(client);
    request.once("close", () => this.disconnect(response));
    response.once("close", () => this.disconnect(response));
    response.write(`event: connected\ndata: {"type":"connected"}\n\n`);
  }

  publish(event: RealtimeEvent, audienceUserIds: Iterable<string>): number {
    const id = this.nextEventId++;
    const audience = new Set(audienceUserIds);
    const stored = { id, audience, event };
    this.history.push(stored);
    if (this.history.length > this.replayLimit) {
      this.history.splice(0, this.history.length - this.replayLimit);
    }
    const payload = this.serialize(id, event);
    for (const client of this.clients) {
      if (audience.has(client.userId) && !client.response.destroyed) {
        client.response.write(payload);
      }
    }
    return id;
  }

  close(): void {
    for (const client of this.clients) {
      clearInterval(client.heartbeat);
      clearTimeout(client.expiry);
      client.response.end();
    }
    this.clients.clear();
  }

  private disconnect(response: ServerResponse): void {
    for (const client of this.clients) {
      if (client.response !== response) continue;
      clearInterval(client.heartbeat);
      clearTimeout(client.expiry);
      this.clients.delete(client);
      break;
    }
  }

  private serialize(id: number, event: RealtimeEvent): string {
    return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
  }
}

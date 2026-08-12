import type { RealtimeEvent } from "./types.js";

export interface RealtimeConnectionOptions {
  path?: string;
  onEvent(event: RealtimeEvent): void;
  onResync(): void;
  isActive(): boolean;
}

/** Keeps the last event id across manually recreated EventSource instances. */
export class RealtimeConnection {
  private source: EventSource | null = null;
  private retryMs = 1_500;
  private retryTimer: number | null = null;
  private lastEventId = "";

  constructor(private readonly options: RealtimeConnectionOptions) {}

  connect(): void {
    if (this.source || !this.options.isActive()) return;
    const query = this.lastEventId ? `?lastEventId=${encodeURIComponent(this.lastEventId)}` : "";
    this.source = new EventSource(`${this.options.path || "/api/events"}${query}`);
    this.source.onopen = () => { this.retryMs = 1_500; };
    this.source.onmessage = (event) => {
      this.lastEventId = event.lastEventId || this.lastEventId;
      try { this.options.onEvent(JSON.parse(event.data) as RealtimeEvent); } catch { this.options.onResync(); }
    };
    this.source.onerror = () => this.reconnect();
  }

  close(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.source?.close();
    this.source = null;
  }

  private reconnect(): void {
    this.source?.close();
    this.source = null;
    if (this.retryTimer !== null || !this.options.isActive()) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(Math.round(this.retryMs * 1.5), 30_000);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.options.isActive()) return;
      this.options.onResync();
      this.connect();
    }, delay);
  }
}

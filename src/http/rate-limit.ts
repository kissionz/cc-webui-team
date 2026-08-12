export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly now: () => number;

  constructor(private readonly options: RateLimitOptions) {
    this.now = options.now ?? Date.now;
  }

  consume(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const current = this.now();
    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= current) {
      if (!existing && this.windows.size >= (this.options.maxKeys ?? 10_000)) {
        this.prune();
        const oldest = this.windows.keys().next().value as string | undefined;
        if (oldest && this.windows.size >= (this.options.maxKeys ?? 10_000)) this.windows.delete(oldest);
      }
      this.windows.set(key, { count: 1, resetAt: current + this.options.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (existing.count >= this.options.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - current) / 1000)),
      };
    }
    existing.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  prune(): void {
    const current = this.now();
    for (const [key, window] of this.windows) {
      if (window.resetAt <= current) this.windows.delete(key);
    }
  }
}

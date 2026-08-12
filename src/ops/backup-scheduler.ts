import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDatabaseBackup, type BackupResult } from "./database-backup.js";

export interface BackupSchedulerOptions {
  databaseFile: string;
  backupDir: string;
  intervalMs: number;
  retention: number;
  now?: () => number;
  onCompleted?: (result: BackupResult) => void;
  onError?: (error: unknown) => void;
}

export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<BackupResult> | null = null;
  private stopped = true;
  private lastCompleted: BackupResult | null = null;
  private lastErrorAt: number | null = null;

  constructor(private readonly options: BackupSchedulerOptions) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(await this.delayUntilDue());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async close(): Promise<void> {
    this.stop();
    await this.running?.catch(() => undefined);
  }

  async runNow(): Promise<BackupResult> {
    if (this.running) return this.running;
    this.running = createDatabaseBackup({
      databaseFile: this.options.databaseFile,
      backupDir: this.options.backupDir,
      retention: this.options.retention,
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    try {
      const result = await this.running;
      this.lastCompleted = result;
      this.options.onCompleted?.(result);
      return result;
    } catch (error) {
      this.lastErrorAt = (this.options.now ?? Date.now)();
      this.options.onError?.(error);
      throw error;
    } finally {
      this.running = null;
    }
  }

  metricsSnapshot(): Record<string, unknown> {
    return {
      enabled: !this.stopped,
      running: this.running !== null,
      lastCompletedAt: this.lastCompleted?.createdAt ?? null,
      lastBackupBytes: this.lastCompleted?.sizeBytes ?? null,
      lastErrorAt: this.lastErrorAt,
      retention: this.options.retention,
      intervalMs: this.options.intervalMs,
    };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runNow().catch(() => undefined).finally(() => this.schedule(this.options.intervalMs));
    }, Math.max(10, delayMs));
    this.timer.unref();
  }

  private async delayUntilDue(): Promise<number> {
    const backupDir = resolve(this.options.backupDir);
    try {
      const names = (await readdir(backupDir)).filter((name) => /^app-\d{8}T\d{9}Z\.sqlite$/.test(name));
      if (!names.length) return 10;
      const times = await Promise.all(names.map(async (name) => (await stat(join(backupDir, name))).mtimeMs));
      const age = (this.options.now ?? Date.now)() - Math.max(...times);
      return Math.max(10, this.options.intervalMs - age);
    } catch {
      return 10;
    }
  }
}

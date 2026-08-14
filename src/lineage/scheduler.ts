import { createId } from "../domain/index.js";
import type { LineageSyncRun, MaxComputeConfig } from "../domain/index.js";
import type { PersistenceRepository } from "../persistence/index.js";
import type { SecretBox } from "../security/secret-box.js";
import type { MaxComputeCredentials } from "./maxcompute-client.js";
import { PyOdpsClient } from "./pyodps-client.js";
import { LineageSyncService, type LineageSyncResult } from "./sync-service.js";

export interface LineageSchedulerOptions {
  repository: PersistenceRepository;
  secretBox?: SecretBox;
  now?: () => number;
  onCompleted?: (run: LineageSyncRun) => void;
  onError?: (run: LineageSyncRun) => void;
  sync?: (config: MaxComputeConfig, dataDate: string) => Promise<LineageSyncResult>;
}

export class LineageScheduler {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<LineageSyncRun> | null = null;
  private stopped = true;
  private readonly now: () => number;

  constructor(private readonly options: LineageSchedulerOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.reschedule();
  }

  close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.active?.then(() => undefined, () => undefined) ?? Promise.resolve();
  }

  reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const config = this.options.repository.getMaxComputeConfig();
    if (!config) return;
    const nextRunAt = !this.stopped && config.enabled ? nextShanghaiRun(this.now(), config.scheduleTime) : null;
    if (config.nextRunAt !== nextRunAt) this.options.repository.saveMaxComputeConfig({ ...config, nextRunAt, updatedAt: this.now() });
    if (nextRunAt === null) return;
    this.timer = setTimeout(() => {
      void this.run("schedule", null).catch(() => undefined).finally(() => this.reschedule());
    }, Math.max(100, nextRunAt - this.now()));
    this.timer.unref();
  }

  run(trigger: "schedule" | "manual", requestedBy: string | null): Promise<LineageSyncRun> {
    if (this.active) return this.active;
    const config = this.options.repository.getMaxComputeConfig();
    if (!config) return Promise.reject(new Error("MaxCompute 配置不存在。"));
    if (!config.project) return Promise.reject(new Error("请先配置 MaxCompute 项目名称。"));
    if (!this.options.sync && (!config.endpoint || !config.credentialCiphertext || !this.options.secretBox)) {
      return Promise.reject(new Error("请先保存 MaxCompute 数据源并验证连接。"));
    }
    const dataDate = previousShanghaiDate(this.now());
    const startedAt = this.now();
    const run: LineageSyncRun = {
      id: createId("lineage_sync"), trigger, requestedBy, dataDate, status: "running",
      projectsProcessed: 0, tablesProcessed: 0, columnsProcessed: 0, jobsProcessed: 0, edgesProcessed: 0,
      error: null, startedAt, completedAt: null,
    };
    this.options.repository.saveLineageSyncRun(run);
    this.options.repository.saveMaxComputeConfig({
      ...config,
      lastStartedAt: startedAt,
      lastStatus: "running",
      lastError: null,
      updatedAt: startedAt,
    });
    this.active = this.execute(run, config).finally(() => { this.active = null; });
    return this.active;
  }

  isRunning(): boolean { return this.active !== null; }

  metricsSnapshot(): Record<string, unknown> {
    const config = this.options.repository.getMaxComputeConfig();
    return { running: this.isRunning(), enabled: config?.enabled ?? false, nextRunAt: config?.nextRunAt ?? null, lastStatus: config?.lastStatus ?? "idle", lastCompletedAt: config?.lastCompletedAt ?? null };
  }

  private async execute(run: LineageSyncRun, config: MaxComputeConfig): Promise<LineageSyncRun> {
    try {
      const result = await (this.options.sync ? this.options.sync(config, run.dataDate) : this.defaultSync(config, run.dataDate));
      const completed: LineageSyncRun = { ...run, ...result, status: "success", completedAt: this.now() };
      this.options.repository.transaction(() => {
        this.options.repository.saveLineageSyncRun(completed);
        const latest = this.options.repository.getMaxComputeConfig() ?? config;
        this.options.repository.saveMaxComputeConfig({ ...latest, lastCompletedAt: completed.completedAt, lastStatus: "success", lastError: null, lastDataDate: run.dataDate, updatedAt: completed.completedAt! });
      });
      this.options.onCompleted?.(completed);
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed: LineageSyncRun = { ...run, status: "failed", error: message.slice(0, 4_000), completedAt: this.now() };
      this.options.repository.transaction(() => {
        this.options.repository.saveLineageSyncRun(failed);
        const latest = this.options.repository.getMaxComputeConfig() ?? config;
        this.options.repository.saveMaxComputeConfig({ ...latest, lastCompletedAt: failed.completedAt, lastStatus: "failed", lastError: failed.error, updatedAt: failed.completedAt! });
      });
      this.options.onError?.(failed);
      throw error;
    }
  }

  private defaultSync(config: MaxComputeConfig, dataDate: string): Promise<LineageSyncResult> {
    if (!config.credentialCiphertext || !this.options.secretBox) return Promise.reject(new Error("请先配置 MaxCompute AccessKey 并验证连接。"));
    if (!config.endpoint) return Promise.reject(new Error("请先配置 MaxCompute Endpoint。"));
    const credential = this.options.secretBox.decrypt<MaxComputeCredentials>(config.credentialCiphertext);
    const client = new PyOdpsClient({
      command: config.command,
      args: config.args,
      project: config.project,
      endpoint: config.endpoint,
      credentials: credential,
    });
    return new LineageSyncService({
      repository: this.options.repository,
      client,
      project: config.project,
      projects: config.collectionMode === "all" ? null : config.collectionProjects,
      now: this.now,
    }).sync(dataDate);
  }
}

export function nextShanghaiRun(now: number, scheduleTime: string): number {
  const [hour, minute] = scheduleTime.split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error("调度时间格式不正确。");
  const shifted = new Date(now + 8 * 60 * 60 * 1_000);
  let next = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour! - 8, minute!, 0, 0);
  if (next <= now) next += 24 * 60 * 60 * 1_000;
  return next;
}

export function previousShanghaiDate(now: number): string {
  const date = new Date(now + 8 * 60 * 60 * 1_000 - 24 * 60 * 60 * 1_000);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

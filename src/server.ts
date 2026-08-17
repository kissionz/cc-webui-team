import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";

import { loadConfig } from "./config.js";
import { SseHub } from "./events/sse.js";
import { ApiServer } from "./http/api-server.js";
import { JsonLogger } from "./observability/logger.js";
import { BackupScheduler } from "./ops/backup-scheduler.js";
import { PersistenceRepository } from "./persistence/index.js";
import { ClaudeRuntimeManager, type RuntimeEvent } from "./runtime/claude-runtime.js";
import { ensureInitialData } from "./services/bootstrap.js";
import { recoverQueuedRuntimeTurns } from "./services/runtime-recovery.js";
import { SqliteRuntimeStore } from "./services/runtime-store.js";
import { ColumnLineageAnalyzer } from "./lineage/column-analyzer.js";
import { LineageScheduler } from "./lineage/scheduler.js";
import { SecretBox } from "./security/secret-box.js";

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (nodeMajor < 24) {
  throw new Error(`Node.js 24 or newer is required; found ${process.version}.`);
}

const config = loadConfig();
const startupStartedAt = Date.now();
const logger = new JsonLogger();
logger.info("server.starting", { platform: process.platform, nodeVersion: process.version });
await Promise.all([
  mkdir(config.dataDir, { recursive: true }),
  mkdir(config.workspaceRoot, { recursive: true }),
]);

const { repository, result: initialization } = await PersistenceRepository.open({
  databasePath: config.databaseFile,
  legacyJsonPath: config.legacyJsonFile,
});
const secretBox = await SecretBox.open({ environmentKey: config.credentialEncryptionKey, keyFile: config.credentialKeyFile });
await ensureInitialData(repository, config);
if (!repository.getMaxComputeConfig()) {
  repository.saveMaxComputeConfig({
    enabled: config.maxCompute.enabled,
    command: config.maxCompute.command,
    args: config.maxCompute.args,
    project: config.maxCompute.project,
    collectionMode: "all",
    collectionProjects: [],
    discoveredProjects: [],
    endpoint: "",
    credentialCiphertext: null,
    credentialUpdatedAt: null,
    scheduleTime: config.maxCompute.scheduleTime,
    timezone: "Asia/Shanghai",
    lastStartedAt: null,
    lastCompletedAt: null,
    lastStatus: "idle",
    lastError: null,
    lastDataDate: null,
    nextRunAt: null,
    updatedAt: Date.now(),
  });
}

const events = new SseHub();
let apiServer: ApiServer | undefined;
const runtime = new ClaudeRuntimeManager({
  store: new SqliteRuntimeStore(repository),
  limits: config.concurrency,
  allowUnsandboxedFallback: process.platform === "win32" && config.allowUnsandboxedWindows,
  events: {
    publish(event: RuntimeEvent): void {
      apiServer?.publishRuntimeEvent(event);
    },
  },
});
if (process.platform === "win32") {
  if (config.allowUnsandboxedWindows) {
    logger.warn("runtime.windows_unsandboxed_fallback_enabled", {
      message: "Harness tasks may access files outside the configured workspace. Use only on a trusted Windows host.",
    });
  } else {
    logger.warn("runtime.windows_sandbox_unavailable", {
      message: "Native Windows does not support the Harness sandbox. Use WSL2 or set CLAUDE_ALLOW_UNSANDBOXED_WINDOWS=true to opt in to unsandboxed execution.",
    });
  }
}
const backups = new BackupScheduler({
  databaseFile: config.databaseFile,
  backupDir: config.backup.directory,
  intervalMs: config.backup.intervalMs,
  retention: config.backup.retention,
  onCompleted: (result) => logger.info("database.backup.completed", { path: result.path, sizeBytes: result.sizeBytes, createdAt: result.createdAt }),
  onError: (error) => logger.error("database.backup.failed", { error: error instanceof Error ? { name: error.name, message: error.message } : String(error) }),
});
const columnLineageAnalyzer = new ColumnLineageAnalyzer();
const lineageScheduler = new LineageScheduler({
  repository,
  secretBox,
  onCompleted: (run) => logger.info("lineage.sync.completed", { runId: run.id, dataDate: run.dataDate, projects: run.projectsProcessed, tables: run.tablesProcessed, columns: run.columnsProcessed, tasksStaged: run.tasksStaged, jobs: run.jobsProcessed, edges: run.edgesProcessed }),
  onError: (run) => logger.error("lineage.sync.failed", { runId: run.id, dataDate: run.dataDate, error: run.error }),
});
apiServer = new ApiServer({ repository, config, runtime, events, logger, backup: backups, lineageScheduler, columnLineageAnalyzer, secretBox });
const recovery = recoverQueuedRuntimeTurns(repository, runtime, logger);
if (recovery.recovered || recovery.failed) {
  logger.info("runtime.queued_turns_recovered", { ...recovery });
}

const server = createServer((request, response) => {
  void apiServer?.handle(request, response);
});

server.on("clientError", (_error, socket) => {
  if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, () => {
    server.off("error", reject);
    resolve();
  });
});
logger.info("server.started", {
  host: config.host,
  port: config.port,
  backupEnabled: config.backup.enabled,
  startupMs: Date.now() - startupStartedAt,
});
lineageScheduler.start();
if (config.backup.enabled) {
  void backups.start().catch((error) => logger.error("database.backup.scheduler_start_failed", {
    error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
  }));
}
if (initialization.importedLegacyJson) {
  logger.info("database.legacy_json_migrated", { backupPath: initialization.legacyBackupPath });
}
const reconciled = initialization.reconciliation;
if (reconciled.interruptedSessions || reconciled.interruptedTurns || reconciled.stalePermissions) {
  logger.warn("runtime.state_reconciled", { reconciliation: reconciled });
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server.shutdown.started", { signal });
  void (async () => {
    const activeTurns = [...runtime.scheduler.listQueued(), ...runtime.scheduler.listRunning()];
    for (const sessionId of new Set(activeTurns.map((turn) => turn.sessionId))) {
      runtime.stop(sessionId, `Server shutdown (${signal}).`);
    }
    events.close();
    await Promise.all([backups.close(), lineageScheduler.close()]);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    const deadline = Date.now() + 5_000;
    while ((runtime.scheduler.listQueued().length || runtime.scheduler.listRunning().length) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    repository.close();
    process.exitCode = runtime.scheduler.listRunning().length ? 1 : 0;
  })().catch((error: unknown) => {
    logger.error("server.shutdown.failed", { error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) });
    process.exitCode = 1;
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

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

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (nodeMajor < 24) {
  throw new Error(`Node.js 24 or newer is required; found ${process.version}.`);
}

const config = loadConfig();
await Promise.all([
  mkdir(config.dataDir, { recursive: true }),
  mkdir(config.workspaceRoot, { recursive: true }),
]);

const { repository, result: initialization } = await PersistenceRepository.open({
  databasePath: config.databaseFile,
  legacyJsonPath: config.legacyJsonFile,
});
await ensureInitialData(repository, config);

const logger = new JsonLogger();
const events = new SseHub();
let apiServer: ApiServer | undefined;
const runtime = new ClaudeRuntimeManager({
  store: new SqliteRuntimeStore(repository),
  limits: config.concurrency,
  events: {
    publish(event: RuntimeEvent): void {
      apiServer?.publishRuntimeEvent(event);
    },
  },
});
const backups = new BackupScheduler({
  databaseFile: config.databaseFile,
  backupDir: config.backup.directory,
  intervalMs: config.backup.intervalMs,
  retention: config.backup.retention,
  onCompleted: (result) => logger.info("database.backup.completed", { path: result.path, sizeBytes: result.sizeBytes, createdAt: result.createdAt }),
  onError: (error) => logger.error("database.backup.failed", { error: error instanceof Error ? { name: error.name, message: error.message } : String(error) }),
});
apiServer = new ApiServer({ repository, config, runtime, events, logger, backup: backups });
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
if (config.backup.enabled) await backups.start();

logger.info("server.started", { host: config.host, port: config.port, backupEnabled: config.backup.enabled });
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
    await backups.close();
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

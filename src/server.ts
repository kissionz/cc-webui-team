import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";

import { loadConfig } from "./config.js";
import { SseHub } from "./events/sse.js";
import { ApiServer } from "./http/api-server.js";
import { PersistenceRepository } from "./persistence/index.js";
import { ClaudeRuntimeManager, type RuntimeEvent } from "./runtime/claude-runtime.js";
import { ensureInitialData } from "./services/bootstrap.js";
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
apiServer = new ApiServer({ repository, config, runtime, events });

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

console.log(`Claude Code Team Platform listening at http://${config.host}:${config.port}`);
if (initialization.importedLegacyJson) {
  console.log(`Legacy JSON was migrated to SQLite; backup: ${initialization.legacyBackupPath}`);
}
const reconciled = initialization.reconciliation;
if (reconciled.interruptedSessions || reconciled.interruptedTurns || reconciled.stalePermissions) {
  console.log("Recovered persisted runtime state", reconciled);
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  void (async () => {
    const activeTurns = [...runtime.scheduler.listQueued(), ...runtime.scheduler.listRunning()];
    for (const sessionId of new Set(activeTurns.map((turn) => turn.sessionId))) {
      runtime.stop(sessionId, `Server shutdown (${signal}).`);
    }
    events.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    const deadline = Date.now() + 5_000;
    while ((runtime.scheduler.listQueued().length || runtime.scheduler.listRunning().length) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    repository.close();
    process.exitCode = runtime.scheduler.listRunning().length ? 1 : 0;
  })().catch((error: unknown) => {
    console.error("Shutdown failed", error);
    process.exitCode = 1;
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

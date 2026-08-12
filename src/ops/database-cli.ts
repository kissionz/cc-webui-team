import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { createDatabaseBackup, restoreDatabaseBackup, verifyDatabase } from "./database-backup.js";

const [command, ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);
const config = loadConfig();
const databaseFile = resolve(args.database ?? config.databaseFile);
const backupDir = resolve(args.directory ?? config.backup.directory);

if (command === "backup") {
  const result = await createDatabaseBackup({
    databaseFile,
    backupDir,
    retention: integer(args.retention, config.backup.retention),
  });
  process.stdout.write(`${JSON.stringify({ event: "database.backup.completed", ...result })}\n`);
} else if (command === "restore") {
  if (!args.source) usage("restore requires --source=/absolute/path/to/backup.sqlite");
  const result = await restoreDatabaseBackup({
    sourceFile: resolve(args.source),
    databaseFile,
    backupDir,
    force: args.force === "true",
    confirmOffline: args["confirm-offline"] === "true",
  });
  process.stdout.write(`${JSON.stringify({ event: "database.restore.completed", ...result })}\n`);
} else if (command === "verify") {
  await verifyDatabase(resolve(args.source ?? databaseFile));
  process.stdout.write(`${JSON.stringify({ event: "database.verify.completed", path: resolve(args.source ?? databaseFile) })}\n`);
} else {
  usage("expected backup, restore, or verify");
}

function parseArgs(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    if (!value.startsWith("--")) usage(`unsupported argument: ${value}`);
    const separator = value.indexOf("=");
    if (separator === -1) result[value.slice(2)] = "true";
    else result[value.slice(2, separator)] = value.slice(separator + 1);
  }
  return result;
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 365) usage("retention must be an integer between 1 and 365");
  return parsed;
}

function usage(reason: string): never {
  throw new Error(`${reason}. Usage: database-cli <backup|restore|verify> [--database=path] [--directory=path] [--source=path] [--retention=14] [--force] [--confirm-offline]`);
}

import Database from "better-sqlite3";
import { access, chmod, copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface BackupResult {
  path: string;
  sizeBytes: number;
  createdAt: number;
}

export interface BackupOptions {
  databaseFile: string;
  backupDir: string;
  retention: number;
  now?: () => number;
  prefix?: string;
}

export interface RestoreOptions {
  sourceFile: string;
  databaseFile: string;
  backupDir: string;
  force: boolean;
  confirmOffline: boolean;
  now?: () => number;
}

export async function createDatabaseBackup(options: BackupOptions): Promise<BackupResult> {
  const createdAt = (options.now ?? Date.now)();
  const databaseFile = resolve(options.databaseFile);
  const backupDir = resolve(options.backupDir);
  await mkdir(backupDir, { recursive: true });
  await verifyDatabase(databaseFile);

  const prefix = safePrefix(options.prefix ?? "app");
  const target = join(backupDir, `${prefix}-${timestamp(createdAt)}.sqlite`);
  const temporary = `${target}.tmp-${process.pid}`;
  await rm(temporary, { force: true });

  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    await database.backup(temporary);
  } finally {
    database.close();
  }

  try {
    await verifyDatabase(temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  await pruneDatabaseBackups(backupDir, Math.max(1, Math.trunc(options.retention)), prefix);
  return { path: target, sizeBytes: (await stat(target)).size, createdAt };
}

export async function restoreDatabaseBackup(options: RestoreOptions): Promise<{ restoredFrom: string; previousBackup: string | null }> {
  if (!options.confirmOffline) {
    throw new Error("Restore requires --confirm-offline after the server has been stopped.");
  }
  const sourceFile = resolve(options.sourceFile);
  const databaseFile = resolve(options.databaseFile);
  if (sourceFile === databaseFile) throw new Error("Backup source and live database must be different files.");
  await verifyDatabase(sourceFile);
  await assertNoLiveSidecars(databaseFile);

  const exists = await pathExists(databaseFile);
  if (exists && !options.force) throw new Error("Live database exists; pass --force to replace it after stopping the server.");
  await mkdir(dirname(databaseFile), { recursive: true });

  const previousBackup = exists
    ? (await createDatabaseBackup({
        databaseFile,
        backupDir: options.backupDir,
        retention: 30,
        prefix: "pre-restore",
        ...(options.now ? { now: options.now } : {}),
      })).path
    : null;

  const temporary = `${databaseFile}.restore-${process.pid}`;
  const rollback = `${databaseFile}.rollback-${process.pid}`;
  await rm(temporary, { force: true });
  await rm(rollback, { force: true });
  await copyFile(sourceFile, temporary);
  await verifyDatabase(temporary);
  await chmod(temporary, 0o600);

  try {
    if (exists) await rename(databaseFile, rollback);
    await rename(temporary, databaseFile);
    await verifyDatabase(databaseFile);
    await rm(rollback, { force: true });
  } catch (error) {
    await rm(temporary, { force: true });
    if (await pathExists(rollback)) {
      await rm(databaseFile, { force: true });
      await rename(rollback, databaseFile);
    }
    throw error;
  }

  return { restoredFrom: sourceFile, previousBackup };
}

export async function verifyDatabase(databaseFile: string): Promise<void> {
  const database = new Database(resolve(databaseFile), { readonly: true, fileMustExist: true });
  try {
    const rows = database.pragma("quick_check") as Array<Record<string, unknown>>;
    const values = rows.flatMap((row) => Object.values(row));
    if (values.length !== 1 || values[0] !== "ok") {
      throw new Error(`SQLite integrity check failed for ${basename(databaseFile)}.`);
    }
  } finally {
    database.close();
  }
}

export async function pruneDatabaseBackups(backupDir: string, retention: number, prefix = "app"): Promise<string[]> {
  const directory = resolve(backupDir);
  if (!await pathExists(directory)) return [];
  const escaped = safePrefix(prefix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}-\\d{8}T\\d{6}\\d{3}Z\\.sqlite$`);
  const names = (await readdir(directory)).filter((name) => pattern.test(name)).sort().reverse();
  const removed = names.slice(Math.max(1, Math.trunc(retention)));
  await Promise.all(removed.map((name) => rm(join(directory, name), { force: true })));
  return removed.map((name) => join(directory, name));
}

async function assertNoLiveSidecars(databaseFile: string): Promise<void> {
  const present: string[] = [];
  for (const suffix of ["-wal", "-shm"]) {
    const candidate = `${databaseFile}${suffix}`;
    if (await pathExists(candidate)) present.push(basename(candidate));
  }
  if (present.length) {
    throw new Error(`Database may still be open (${present.join(", ")}); stop the server cleanly before restore.`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function safePrefix(value: string): string {
  const prefix = value.trim();
  if (!/^[a-z0-9_-]+$/i.test(prefix)) throw new Error("Backup prefix contains unsupported characters.");
  return prefix;
}

function timestamp(value: number): string {
  return new Date(value).toISOString().replaceAll(":", "").replaceAll("-", "").replace(".", "");
}

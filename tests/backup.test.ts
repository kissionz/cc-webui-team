import Database from "better-sqlite3";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabaseBackup, restoreDatabaseBackup, verifyDatabase } from "../src/ops/database-backup.js";
import { BackupScheduler } from "../src/ops/backup-scheduler.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; databaseFile: string; backupDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "cc-backup-"));
  roots.push(root);
  const databaseFile = join(root, "app.sqlite");
  const backupDir = join(root, "backups");
  const database = new Database(databaseFile);
  database.exec("CREATE TABLE values_table(value TEXT NOT NULL); INSERT INTO values_table VALUES ('original');");
  database.close();
  return { root, databaseFile, backupDir };
}

function value(databaseFile: string): string {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return String((database.prepare("SELECT value FROM values_table").get() as { value: string }).value);
  } finally {
    database.close();
  }
}

describe("database backup operations", () => {
  it("creates verified online backups and applies retention", async () => {
    const { databaseFile, backupDir } = await fixture();
    for (let index = 0; index < 3; index += 1) {
      await createDatabaseBackup({ databaseFile, backupDir, retention: 2, now: () => 1_800_000_000_000 + index });
    }
    const names = (await readdir(backupDir)).filter((name) => name.endsWith(".sqlite"));
    expect(names).toHaveLength(2);
    await expect(verifyDatabase(join(backupDir, names[0]!))).resolves.toBeUndefined();
  });

  it("restores atomically and preserves a pre-restore backup", async () => {
    const { databaseFile, backupDir } = await fixture();
    const backup = await createDatabaseBackup({ databaseFile, backupDir, retention: 10, now: () => 1_800_000_000_000 });
    const database = new Database(databaseFile);
    database.prepare("UPDATE values_table SET value='changed'").run();
    database.close();

    await expect(restoreDatabaseBackup({
      sourceFile: backup.path,
      databaseFile,
      backupDir,
      force: false,
      confirmOffline: true,
    })).rejects.toThrow("--force");

    const restored = await restoreDatabaseBackup({
      sourceFile: backup.path,
      databaseFile,
      backupDir,
      force: true,
      confirmOffline: true,
      now: () => 1_800_000_001_000,
    });
    expect(value(databaseFile)).toBe("original");
    expect(restored.previousBackup).toContain("pre-restore");
  });

  it("rejects corrupt backups and restore without an offline acknowledgement", async () => {
    const { root, databaseFile, backupDir } = await fixture();
    const corrupt = join(root, "corrupt.sqlite");
    await writeFile(corrupt, "not a database");
    await expect(verifyDatabase(corrupt)).rejects.toThrow();
    await expect(restoreDatabaseBackup({
      sourceFile: databaseFile,
      databaseFile: join(root, "restored.sqlite"),
      backupDir,
      force: true,
      confirmOffline: false,
    })).rejects.toThrow("--confirm-offline");
  });

  it("coalesces concurrent scheduled backup requests", async () => {
    const { databaseFile, backupDir } = await fixture();
    const completed: string[] = [];
    const scheduler = new BackupScheduler({
      databaseFile,
      backupDir,
      intervalMs: 60_000,
      retention: 2,
      now: () => 1_800_000_000_000,
      onCompleted: (result) => completed.push(result.path),
    });
    const [first, second] = await Promise.all([scheduler.runNow(), scheduler.runNow()]);
    expect(first.path).toBe(second.path);
    expect(completed).toEqual([first.path]);
  });
});

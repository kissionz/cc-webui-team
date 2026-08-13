import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function loadDotEnv(filePath: string): void {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      const raw = trimmed.slice(separator + 1).trim();
      const value = raw.replace(/^(["'])(.*)\1$/, "$2");
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function boundedNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = boundedNumber(name, fallback, minimum, maximum);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function csv(name: string): string[] {
  return String(process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface AppConfig {
  rootDir: string;
  publicDir: string;
  host: string;
  port: number;
  dataDir: string;
  databaseFile: string;
  legacyJsonFile: string;
  workspaceRoot: string;
  claudeCommand: string;
  claudeArgs: string[];
  allowUnsandboxedWindows: boolean;
  adminPassword: string;
  seedDemoUsers: boolean;
  sessionTtlMs: number;
  maxBodySize: number;
  cookieSecure: boolean;
  allowedOrigins: string[];
  concurrency: {
    global: number;
    perTeam: number;
    perUser: number;
  };
  modelContextTokens: number;
  autoCompactRatio: number;
  autoCompactEnabled: boolean;
  mcpToolAllowlist: string[];
  maxCompute: {
    enabled: boolean;
    command: string;
    args: string;
    project: string;
    scheduleTime: string;
  };
  backup: {
    enabled: boolean;
    directory: string;
    intervalMs: number;
    retention: number;
  };
}

export function loadConfig(rootDir = process.cwd()): AppConfig {
  loadDotEnv(join(rootDir, ".env"));
  const dataDir = resolve(process.env.DATA_DIR || join(rootDir, "data"));
  const workspaceRoot = resolve(process.env.WORKSPACE_ROOT || "/workspaces");
  const port = positiveInteger("PORT", 8068);
  const explicitOrigins = csv("ALLOWED_ORIGINS");
  const localOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  return {
    rootDir,
    publicDir: resolve(process.env.PUBLIC_DIR || join(rootDir, "dist", "public")),
    host: process.env.HOST || "127.0.0.1",
    port,
    dataDir,
    databaseFile: resolve(process.env.DB_FILE || join(dataDir, "app.sqlite")),
    legacyJsonFile: resolve(process.env.LEGACY_JSON_FILE || join(dataDir, "db.json")),
    workspaceRoot,
    claudeCommand: process.env.CLAUDE_COMMAND ?? "claude",
    claudeArgs: String(process.env.CLAUDE_ARGS || "").split(/\s+/).filter(Boolean),
    allowUnsandboxedWindows: process.env.CLAUDE_ALLOW_UNSANDBOXED_WINDOWS === "true",
    adminPassword: process.env.ADMIN_PASSWORD || "admin123",
    seedDemoUsers: process.env.SEED_DEMO_USERS === "true",
    sessionTtlMs: positiveInteger("SESSION_TTL_MS", 12 * 60 * 60 * 1000),
    maxBodySize: positiveInteger("MAX_BODY_SIZE", 2 * 1024 * 1024),
    cookieSecure: process.env.HTTPS === "true" || process.env.COOKIE_SECURE === "true",
    allowedOrigins: explicitOrigins.length ? explicitOrigins : localOrigins,
    concurrency: {
      global: positiveInteger("MAX_CONCURRENT_TURNS", 4),
      perTeam: positiveInteger("MAX_CONCURRENT_TURNS_PER_TEAM", 2),
      perUser: positiveInteger("MAX_CONCURRENT_TURNS_PER_USER", 1),
    },
    modelContextTokens: positiveInteger("MODEL_CONTEXT_TOKENS", 1_000_000),
    autoCompactRatio: boundedNumber("AUTO_COMPACT_RATIO", 0.62, 0.1, 0.9),
    autoCompactEnabled: process.env.AUTO_COMPACT_ENABLED !== "false",
    mcpToolAllowlist: csv("MCP_TOOL_ALLOWLIST"),
    maxCompute: {
      enabled: process.env.MAXCOMPUTE_ENABLED === "true",
      command: process.env.MAXCOMPUTE_COMMAND || "odpscmd",
      args: process.env.MAXCOMPUTE_ARGS || "",
      project: process.env.MAXCOMPUTE_PROJECT || "",
      scheduleTime: scheduleTime("MAXCOMPUTE_SCHEDULE_TIME", "06:15"),
    },
    backup: {
      enabled: process.env.BACKUP_ENABLED !== "false",
      directory: resolve(process.env.BACKUP_DIR || join(dataDir, "backups")),
      intervalMs: boundedInteger("BACKUP_INTERVAL_HOURS", 24, 1, 168) * 60 * 60 * 1000,
      retention: boundedInteger("BACKUP_RETENTION", 14, 1, 365),
    },
  };
}

function scheduleTime(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`${name} must use HH:mm.`);
  return value;
}

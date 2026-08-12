import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { PermissionUpdate, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  ClaudeConfig,
  ConversationSession,
  JsonObject,
  JsonValue,
  Permission,
  ToolApprovals,
} from "../domain/models.js";
import type { PermissionDecision as SafePermissionDecision } from "../security/permissions.js";

export type UnknownRecord = Record<string, unknown>;

export interface PromptQueue {
  stream: AsyncIterable<SDKUserMessage>;
  push(content: string, priority?: "now" | "next" | "later"): boolean;
  close(): void;
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordAt(value: unknown, key: string): UnknownRecord | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

export function stringAt(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return typeof nested === "string" ? nested : undefined;
}

export function numberAt(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return typeof nested === "number" && Number.isFinite(nested) ? nested : undefined;
}

export function arrayAt(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return Array.isArray(nested) ? nested : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    const output: { [key: string]: JsonValue } = {};
    for (const [key, nested] of Object.entries(value)) output[key] = toJsonValue(nested);
    return output;
  }
  return String(value);
}

export function toJsonObject(value: unknown): JsonObject {
  return isRecord(value) ? (toJsonValue(value) as JsonObject) : {};
}

function sdkUserMessage(content: string, priority: "now" | "next" | "later" = "next"): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    priority,
    timestamp: new Date().toISOString(),
  };
}

export function createPromptQueue(initialPrompt: string): PromptQueue {
  const queue: SDKUserMessage[] = [sdkUserMessage(initialPrompt, "now")];
  const waiters: Array<() => void> = [];
  let closed = false;
  const wake = (): void => {
    let waiter = waiters.shift();
    while (waiter) {
      waiter();
      waiter = waiters.shift();
    }
  };
  return {
    stream: (async function* stream(): AsyncGenerator<SDKUserMessage> {
      while (!closed || queue.length > 0) {
        const message = queue.shift();
        if (message) yield message;
        else await new Promise<void>((resolveWaiter) => waiters.push(resolveWaiter));
      }
    })(),
    push(content, priority = "next") {
      if (closed) return false;
      queue.push(sdkUserMessage(content, priority));
      wake();
      return true;
    },
    close() {
      closed = true;
      wake();
    },
  };
}

export function sanitizeClaudeExtraArgs(args: readonly string[]): string[] {
  const consumesValue = new Set([
    "--input-format", "--output-format", "--resume", "-r", "--session-id",
    "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  ]);
  const blocked = new Set(["-p", "--print", "--continue", "-c", "--replay-user-messages", ...consumesValue]);
  const sanitized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (blocked.has(argument)) {
      if (consumesValue.has(argument)) index += 1;
      continue;
    }
    if (/^--(?:input-format|output-format|resume|session-id|allowedTools|allowed-tools|disallowedTools|disallowed-tools)=/.test(argument)) continue;
    sanitized.push(argument);
  }
  return sanitized;
}

export function cliArgsToExtraArgs(args: readonly string[]): Record<string, string | null> {
  const output: Record<string, string | null> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals > 2) {
      output[argument.slice(2, equals)] = argument.slice(equals + 1);
      continue;
    }
    const key = argument.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("-")) output[key] = null;
    else {
      output[key] = next;
      index += 1;
    }
  }
  return output;
}

export function parseMcpToolName(name: string): { toolName: string; serverName: string } {
  if (!name.startsWith("mcp__")) return { toolName: name, serverName: "" };
  const parts = name.split("__");
  return { serverName: parts[1] ?? "", toolName: parts.slice(2).join("__") || name };
}

export function approvedToolSpecs(session: ConversationSession, config: ClaudeConfig): string[] {
  const specifications = new Set(config.mcpToolAllowlist);
  for (const tool of [...session.toolApprovals.onceTools, ...session.toolApprovals.alwaysTools]) {
    if (tool) specifications.add(tool);
  }
  for (const server of session.toolApprovals.alwaysServers) {
    if (server) specifications.add(`mcp__${server}__*`);
  }
  return [...specifications];
}

export function normalizePlanStatus(value: unknown): "pending" | "in_progress" | "completed" | "deleted" {
  if (value === "completed" || value === "done") return "completed";
  if (value === "in_progress" || value === "running") return "in_progress";
  if (value === "deleted") return "deleted";
  return "pending";
}

export function splitArguments(value: string): string[] {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) =>
    part.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, double: string | undefined, single: string | undefined) => double ?? single ?? part),
  ) ?? [];
}

export function autoCompactWindow(config: ClaudeConfig): number {
  const contextTokens = Math.max(1_000, config.modelContextTokens || 1_000_000);
  const ratio = Math.min(0.9, Math.max(0.1, config.autoCompactRatio || 0.62));
  return Math.floor(contextTokens * ratio);
}

/** Bare commands intentionally use the SDK-bundled Claude Code executable. */
export function resolveClaudeExecutable(command: string): string | undefined {
  if (!command) return undefined;
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  if (command.includes("/") || command.includes("\\")) {
    const candidate = resolve(command);
    return existsSync(candidate) ? candidate : undefined;
  }
  return undefined;
}

export function isToolApproved(session: ConversationSession, config: ClaudeConfig, toolName: string): boolean {
  const parsed = parseMcpToolName(toolName);
  return config.mcpToolAllowlist.includes(toolName)
    || session.toolApprovals.onceTools.includes(toolName)
    || session.toolApprovals.alwaysTools.includes(toolName)
    || Boolean(parsed.serverName && session.toolApprovals.alwaysServers.includes(parsed.serverName));
}

export function guardedPrompt(session: ConversationSession, config: ClaudeConfig, prompt: string): string {
  const allowed = approvedToolSpecs(session, config);
  return [
    "WebUI 工具边界提醒：",
    allowed.length > 0
      ? `WebUI 已预授权的工具：${allowed.join(", ")}`
      : "WebUI 当前没有预授权工具；这不限制 Claude Code 运行时已有的工具。",
    "实际可用工具以 Claude Code 运行时为准；需要工具时直接尝试，未预授权操作会触发审批。",
    "不要编造工具调用结果；真实调用失败时报告运行时错误。",
    "",
    "用户新消息：",
    prompt,
  ].join("\n");
}

export function planSummary(items: readonly { status: string; activeForm: string; content: string }[]): string {
  const visible = items.filter((item) => item.status !== "deleted");
  const completed = visible.filter((item) => item.status === "completed").length;
  const active = visible.find((item) => item.status === "in_progress");
  return `执行计划 ${completed}/${visible.length}${active ? `\n正在执行：${active.activeForm || active.content}` : ""}`;
}

export function permissionUpdates(permission: Permission, decision: SafePermissionDecision): PermissionUpdate[] {
  if (decision === "allow_once") return [];
  const target = decision === "allow_always_server" && permission.serverName
    ? `mcp__${permission.serverName}__*`
    : permission.toolName;
  return target
    ? [{ type: "addRules", rules: [{ toolName: target }], behavior: "allow", destination: "session" }]
    : [];
}

export function claudeRuntimeEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const exact = new Set([
    "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "HOME", "USERPROFILE", "PATH", "SHELL", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR",
    "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]);
  const result: Record<string, string> = { TERM: "xterm-256color" };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && exact.has(key)) result[key] = value;
  }
  return result;
}

export function sanitizeCachedApprovals(approvals: ToolApprovals): ToolApprovals {
  const highRisk = new Set(["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
  return {
    onceTools: approvals.onceTools.filter((tool) => !highRisk.has(tool)),
    alwaysTools: approvals.alwaysTools.filter((tool) => !highRisk.has(tool)),
    alwaysServers: [...approvals.alwaysServers],
  };
}

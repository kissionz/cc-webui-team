import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { splitArguments } from "../runtime/runtime-helpers.js";
import type { MaxComputeCredentials, MaxComputeQueryClient, MaxComputeQueryOptions, MaxComputeRow } from "./maxcompute-client.js";

export interface PyOdpsClientOptions {
  command: string;
  args: string;
  project: string;
  endpoint: string;
  credentials: MaxComputeCredentials;
  timeoutMs?: number;
  helperPath?: string;
  platform?: NodeJS.Platform;
  onDiagnostic?: (diagnostic: PyOdpsDiagnostic) => void;
}

export interface PyOdpsDiagnostic {
  pythonCommand: string;
  pythonVersion: string;
  sdkVersion: string;
  instanceId: string;
  rows: number;
  stderr: string;
}

export type PyOdpsErrorKind = "python_not_found" | "pyodps_not_installed" | "failed" | "invalid_output" | "too_many_rows";

export class PyOdpsError extends Error {
  constructor(readonly kind: PyOdpsErrorKind, message: string, readonly diagnostic?: Partial<PyOdpsDiagnostic>) {
    super(message);
    this.name = "PyOdpsError";
  }
}

interface PythonInvocation { command: string; args: string[] }
interface HelperMessage {
  type?: string;
  value?: unknown;
  pythonVersion?: unknown;
  sdkVersion?: unknown;
  instanceId?: unknown;
  rows?: unknown;
  code?: unknown;
  message?: unknown;
  detail?: unknown;
}

const DEFAULT_HELPER = fileURLToPath(new URL("./pyodps-helper.py", import.meta.url));
const MAX_QUERY_ROWS = 5_000_000;
const MAX_LINE_CHARS = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 2 * 1024 * 1024;

export function pythonInvocations(command: string, args: string, platform: NodeJS.Platform = process.platform): PythonInvocation[] {
  const extra = splitArguments(args);
  const normalized = command.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, double: string | undefined, single: string | undefined) => double ?? single ?? command.trim());
  if (normalized && normalized.toLowerCase() !== "auto" && !normalized.toLowerCase().includes("odpscmd")) return [{ command: normalized, args: extra }];
  return platform === "win32"
    ? [{ command: "py", args: ["-3", ...extra] }, { command: "python", args: extra }, { command: "python3", args: extra }]
    : [{ command: "python3", args: extra }, { command: "python", args: extra }];
}

export class PyOdpsClient implements MaxComputeQueryClient {
  constructor(private readonly options: PyOdpsClientOptions) {}

  async query(sql: string, fields: readonly string[], queryOptions: MaxComputeQueryOptions = {}): Promise<MaxComputeRow[]> {
    const rows: MaxComputeRow[] = [];
    for await (const row of this.stream(sql, fields, queryOptions)) {
      rows.push(row);
      if (rows.length > MAX_QUERY_ROWS) throw new PyOdpsError("too_many_rows", `非流式查询超过 ${MAX_QUERY_ROWS} 行，已停止以避免内存耗尽。`);
    }
    return rows;
  }

  async *stream(sql: string, fields: readonly string[], queryOptions: MaxComputeQueryOptions = {}): AsyncGenerator<MaxComputeRow> {
    if (!this.options.project) throw new Error("MaxCompute 执行项目尚未配置。");
    if (!this.options.endpoint) throw new Error("MaxCompute Endpoint 尚未配置。");
    if (!fields.length) return;
    const attempts: string[] = [];
    let lastMissingSdk: PyOdpsError | null = null;
    for (const invocation of pythonInvocations(this.options.command, this.options.args, this.options.platform)) {
      let emitted = false;
      try {
        for await (const row of this.runStream(invocation, sql, fields, queryOptions)) {
          emitted = true;
          yield row;
        }
        return;
      } catch (error) {
        if (emitted || !(error instanceof PyOdpsError) || !["python_not_found", "pyodps_not_installed"].includes(error.kind)) throw error;
        attempts.push(formatInvocation(invocation));
        if (error.kind === "pyodps_not_installed") lastMissingSdk = error;
      }
    }
    if (lastMissingSdk) {
      const installCommand = (this.options.platform ?? process.platform) === "win32"
        ? "py -3 -m pip install pyodps==0.13.0"
        : "python3 -m pip install pyodps==0.13.0";
      throw new PyOdpsError("pyodps_not_installed", `${lastMissingSdk.message} 已尝试：${attempts.join("、")}。请在服务所用 Python 环境执行 \"${installCommand}\"。`, lastMissingSdk.diagnostic);
    }
    throw new PyOdpsError("python_not_found", `未找到可用的 Python 3。已尝试：${attempts.join("、")}。请安装 Python 3.9+，或在高级设置中填写 python.exe 的绝对路径。`);
  }

  private async *runStream(invocation: PythonInvocation, sql: string, fields: readonly string[], queryOptions: MaxComputeQueryOptions): AsyncGenerator<MaxComputeRow> {
    const helperPath = this.options.helperPath ?? DEFAULT_HELPER;
    const child = spawn(invocation.command, [...invocation.args, helperPath], {
      env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let rowCount = 0;
    let doneRows: number | null = null;
    let timedOut = false;
    let meta: Partial<PyOdpsDiagnostic> = { pythonCommand: formatInvocation(invocation), rows: 0 };
    const timeoutMs = this.options.timeoutMs ?? 30 * 60 * 1_000;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    timeout.unref();
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= MAX_STDERR_CHARS) return;
      stderr += (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk).slice(0, MAX_STDERR_CHARS - stderr.length);
    });
    child.stdin.on("error", () => undefined);
    const completion = new Promise<{ exitCode: number; error: unknown | null }>((resolve) => {
      child.once("error", (error) => resolve({ exitCode: 1, error }));
      child.once("close", (code) => resolve({ exitCode: code ?? 1, error: null }));
    });
    child.stdin.end(JSON.stringify({
      accessKeyId: this.options.credentials.accessKeyId,
      accessKeySecret: this.options.credentials.accessKeySecret,
      endpoint: this.options.endpoint,
      project: this.options.project,
      sql,
      fields,
      validateOnly: Boolean(queryOptions.validateOnly),
    }));

    try {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (line.length > MAX_LINE_CHARS) throw new PyOdpsError("invalid_output", "PyODPS 返回的单行数据超过 16 MB，已停止读取。", meta);
        let message: HelperMessage;
        try { message = JSON.parse(line) as HelperMessage; }
        catch (error) { throw new PyOdpsError("invalid_output", `PyODPS Helper 返回了无法识别的数据：${error instanceof Error ? error.message : String(error)}`, meta); }
        if (message.type === "meta") {
          meta = { ...meta, pythonVersion: stringValue(message.pythonVersion), sdkVersion: stringValue(message.sdkVersion), instanceId: stringValue(message.instanceId) };
        } else if (message.type === "row") {
          if (!isRow(message.value, fields)) throw new PyOdpsError("invalid_output", "PyODPS Helper 返回的 row 字段结构不正确。", meta);
          rowCount += 1;
          yield message.value;
        } else if (message.type === "done") {
          doneRows = Number(message.rows);
        } else {
          throw new PyOdpsError("invalid_output", "PyODPS Helper 返回了未知消息类型。", meta);
        }
      }
      const completed = await completion;
      if (completed.error) {
        const code = completed.error instanceof Error && "code" in completed.error ? String((completed.error as NodeJS.ErrnoException).code || "") : "";
        if (code === "ENOENT") throw new PyOdpsError("python_not_found", `找不到 Python 命令：${invocation.command}。`);
        throw new PyOdpsError("failed", `无法启动 Python：${safeError(completed.error, this.options.credentials)}`);
      }
      const diagnostic: PyOdpsDiagnostic = {
        pythonCommand: meta.pythonCommand ?? formatInvocation(invocation),
        pythonVersion: meta.pythonVersion ?? "",
        sdkVersion: meta.sdkVersion ?? "",
        instanceId: meta.instanceId ?? "",
        rows: rowCount,
        stderr: safeText(stderr, this.options.credentials).slice(-4_000),
      };
      this.options.onDiagnostic?.(diagnostic);
      if (timedOut) throw new PyOdpsError("failed", `PyODPS 查询超过 ${Math.round(timeoutMs / 1_000)} 秒，已终止。`, diagnostic);
      if (completed.exitCode !== 0) throw helperError(stderr, completed.exitCode, this.options.credentials, diagnostic);
      if (doneRows === null || doneRows !== rowCount) throw new PyOdpsError("invalid_output", "PyODPS Helper 未返回完整的结束标记，查询结果可能不完整。", diagnostic);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }
}

function helperError(stderr: string, exitCode: number, credentials: MaxComputeCredentials, diagnostic: PyOdpsDiagnostic): PyOdpsError {
  const lines = stderr.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as HelperMessage;
      if (value.type !== "error") continue;
      const code = stringValue(value.code);
      const message = safeText(`${stringValue(value.message)}${value.detail ? ` ${stringValue(value.detail)}` : ""}`, credentials).trim();
      if (code === "PYODPS_NOT_INSTALLED" || code === "PYODPS_IMPORT_FAILED") return new PyOdpsError("pyodps_not_installed", message, diagnostic);
      const hint = code === "MAXCOMPUTE_PERMISSION_DENIED"
        ? " 请确认 RAM 用户拥有目标项目及租户级 Information Schema、InstanceTunnel 读取权限。"
        : code === "MAXCOMPUTE_TUNNEL_FAILED" ? " 请确认目标表读取权限及 InstanceTunnel 可用。" : "";
      return new PyOdpsError("failed", `${message}${hint}`, diagnostic);
    } catch { /* Ignore non-protocol warnings. */ }
  }
  const detail = safeText(stderr, credentials).trim().slice(-2_000);
  if ([127, 9009].includes(exitCode) || /python was not found|not recognized as an internal or external command/i.test(detail)) return new PyOdpsError("python_not_found", `找不到 Python 命令：${diagnostic.pythonCommand}。`, diagnostic);
  return new PyOdpsError("failed", `PyODPS 查询失败（退出码 ${exitCode}）${detail ? `：${detail}` : "。"}`, diagnostic);
}

function isRow(value: unknown, fields: readonly string[]): value is MaxComputeRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return fields.every((field) => typeof (value as Record<string, unknown>)[field] === "string");
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function formatInvocation(value: PythonInvocation): string { return [value.command, ...value.args].join(" "); }
function safeError(value: unknown, credentials: MaxComputeCredentials): string { return safeText(value instanceof Error ? value.message : String(value), credentials); }
function safeText(value: string, credentials: MaxComputeCredentials): string { return value.replaceAll(credentials.accessKeySecret, "[REDACTED]").replaceAll(credentials.accessKeyId, "[REDACTED]"); }

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, win32 } from "node:path";

import { splitArguments } from "../runtime/runtime-helpers.js";

export type MaxComputeRow = Record<string, string>;

export interface MaxComputeQueryClient {
  query(sql: string, fields: readonly string[]): Promise<MaxComputeRow[]>;
}

export interface OdpsCommandClientOptions {
  command: string;
  args: string;
  project: string;
  configPath?: string;
  timeoutMs?: number;
}

export interface MaxComputeCredentials {
  accessKeyId: string;
  accessKeySecret: string;
}

export interface TemporaryOdpsConfigOptions extends MaxComputeCredentials {
  endpoint: string;
  project: string;
}

export type OdpsCommandErrorKind = "not_found" | "failed" | "invalid_output" | "output_too_large";

export class OdpsCommandError extends Error {
  constructor(
    readonly kind: OdpsCommandErrorKind,
    message: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = "OdpsCommandError";
  }
}

export interface OdpsInvocation {
  command: string;
  args: string[];
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function resolveOdpsInvocation(
  command: string,
  args: string[],
  platform = process.platform,
  comSpec = process.env.ComSpec || "cmd.exe",
): OdpsInvocation {
  if (platform !== "win32") return { command, args };
  if (/[\r\n\0"]/.test(command)) throw new OdpsCommandError("failed", "odpscmd 命令路径包含不支持的字符。");
  if (["cmd", "cmd.exe"].includes(win32.basename(command).toLowerCase())) {
    const commandIndex = args.findIndex((argument) => argument.toLowerCase() === "/c");
    const batchCommand = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
    if (batchCommand && [".bat", ".cmd"].includes(extname(batchCommand).toLowerCase())) {
      const quotedBatchCommand = /\s/.test(batchCommand) ? `"${batchCommand}"` : batchCommand;
      return { command, args: ["/d", "/c", quotedBatchCommand, ...args.slice(commandIndex + 2)] };
    }
    return { command, args };
  }
  const extension = extname(command).toLowerCase();
  if (extension && extension !== ".bat" && extension !== ".cmd") return { command, args };
  const quotedCommand = /\s/.test(command) ? `"${command}"` : command;
  return { command: comSpec, args: ["/d", "/c", quotedCommand, ...args] };
}

export function decodeOdpsOutput(buffer: Buffer): string {
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gb18030").decode(buffer);
  } catch {
    return utf8;
  }
}

export class OdpsCommandClient implements MaxComputeQueryClient {
  constructor(private readonly options: OdpsCommandClientOptions) {}

  async query(sql: string, fields: readonly string[]): Promise<MaxComputeRow[]> {
    if (!this.options.project) throw new Error("MaxCompute 项目名称尚未配置。");
    if (!fields.length) return [];
    const output = `set odps.sql.select.output.format={"needHeader":true,"fieldDelim":"\\t"};\n${sql.trim().replace(/;?\s*$/, ";")}`;
    const queryRoot = await mkdtemp(join(tmpdir(), "cc-maxcompute-query-"));
    const queryPath = join(queryRoot, "query.sql");
    try {
      await writeFile(queryPath, output, { mode: 0o600, flag: "wx" });
      const args = [...splitArguments(this.options.args), ...(this.options.configPath ? [`--config=${this.options.configPath}`] : []), `--project=${this.options.project}`, "-f", queryPath];
      const invocation = resolveOdpsInvocation(this.options.command, args);
      const child = spawn(invocation.command, invocation.args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const timeout = setTimeout(() => child.kill("SIGTERM"), this.options.timeoutMs ?? 10 * 60 * 1_000);
      timeout.unref();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let outputTooLarge = false;
      const collect = (target: Buffer[]) => (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          outputTooLarge = true;
          child.kill("SIGTERM");
          return;
        }
        target.push(buffer);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      let exitCode: number;
      try {
        exitCode = await new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolve(code ?? 1));
        });
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code || "") : "";
        if (code === "ENOENT") {
          throw new OdpsCommandError("not_found", `找不到 odpscmd 命令：${this.options.command}。Windows 请填写 odpscmd.bat 的绝对路径，额外启动参数留空。`);
        }
        throw new OdpsCommandError("failed", `无法启动 odpscmd：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timeout);
      }
      if (outputTooLarge) throw new OdpsCommandError("output_too_large", "odpscmd 返回内容超过 64 MB，已终止本次查询。");
      const stdoutText = decodeOdpsOutput(Buffer.concat(stdout));
      const stderrText = decodeOdpsOutput(Buffer.concat(stderr));
      if (exitCode !== 0) {
        const detail = stderrText.trim() || stdoutText.trim();
        throw new OdpsCommandError("failed", `odpscmd 查询失败（退出码 ${exitCode}）${detail ? `：${detail.slice(-2_000)}` : ""}`, exitCode);
      }
      return parseOdpsRows(stdoutText, fields);
    } finally {
      await rm(queryRoot, { recursive: true, force: true });
    }
  }
}

function parseOdpsRows(output: string, fields: readonly string[]): MaxComputeRow[] {
  const expectedHeader = fields.join("\t");
  const rows: MaxComputeRow[] = [];
  let headerFound = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (!headerFound) {
      if (line.trim() === expectedHeader) headerFound = true;
      continue;
    }
    if (!line || /^OK\b|^ID\b|^Log view:/i.test(line)) continue;
    const values = line.split("\t");
    if (values.length !== fields.length) continue;
    const row: MaxComputeRow = {};
    fields.forEach((field, index) => { row[field] = values[index] ?? ""; });
    rows.push(row);
  }
  if (!headerFound) {
    throw new OdpsCommandError("invalid_output", "无法识别 odpscmd 输出。请确认客户端可用，并在 odps_config.ini 中关闭 use_instance_tunnel。");
  }
  return rows;
}

export async function withTemporaryOdpsConfig<T>(options: TemporaryOdpsConfigOptions, task: (configPath: string) => Promise<T>): Promise<T> {
  for (const [name, value] of Object.entries(options)) {
    if (!value.trim() || /[\r\n]/.test(value)) throw new Error(`${name} 配置不正确。`);
  }
  const root = await mkdtemp(join(tmpdir(), "cc-maxcompute-"));
  const path = join(root, "odps_config.ini");
  const content = [
    `project_name=${options.project}`,
    `access_id=${options.accessKeyId}`,
    `access_key=${options.accessKeySecret}`,
    `end_point=${options.endpoint}`,
    "https_check=true",
    "use_instance_tunnel=false",
  ].join("\n");
  try {
    await writeFile(path, content, { mode: 0o600, flag: "wx" });
    return await task(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

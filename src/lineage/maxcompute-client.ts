import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, win32 } from "node:path";

import { splitArguments } from "../runtime/runtime-helpers.js";

export type MaxComputeRow = Record<string, string>;

export interface MaxComputeQueryClient {
  query(sql: string, fields: readonly string[], options?: MaxComputeQueryOptions): Promise<MaxComputeRow[]>;
}

export interface MaxComputeQueryOptions {
  validateOnly?: boolean;
}

export interface OdpsCommandClientOptions {
  command: string;
  args: string;
  project: string;
  configPath?: string;
  timeoutMs?: number;
  onOutput?: (output: OdpsCommandOutput) => void;
}

export interface OdpsCommandOutput {
  stdout: string;
  stderr: string;
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

  async query(sql: string, fields: readonly string[], options: MaxComputeQueryOptions = {}): Promise<MaxComputeRow[]> {
    if (!this.options.project) throw new Error("MaxCompute 项目名称尚未配置。");
    if (!fields.length) return [];
    const output = buildOdpsScript(sql);
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
      this.options.onOutput?.({ stdout: stdoutText, stderr: stderrText });
      const businessFailure = extractOdpsFailure(stdoutText, stderrText);
      if (exitCode !== 0 || businessFailure) {
        const detail = businessFailure || stderrText.trim() || stdoutText.trim();
        const exitLabel = exitCode === 0 ? "SQL 执行失败" : `查询失败（退出码 ${exitCode}）`;
        throw new OdpsCommandError("failed", `odpscmd ${exitLabel}${detail ? `：${detail.slice(-2_000)}` : ""}`, exitCode);
      }
      if (options.validateOnly) return [];
      return parseOdpsRowsFromChannels(stdoutText, stderrText, fields);
    } finally {
      await rm(queryRoot, { recursive: true, force: true });
    }
  }
}

export function buildOdpsScript(sql: string): string {
  return [
    "set odps.namespace.schema=true;",
    'set odps.sql.select.output.format={"needHeader":true,"fieldDelim":"\\t"};',
    sql.trim().replace(/;?\s*$/, ";"),
  ].join("\n");
}

export function extractOdpsFailure(stdout: string, stderr: string): string {
  const output = `${stdout}\n${stderr}`.trim();
  const match = output.match(/(?:^|\n)\s*(FAILED\s*:|ERROR\s*:|ODPS-\d{6,}\b)/i);
  return match?.index === undefined ? "" : output.slice(match.index).trim().slice(-2_000);
}

export function parseOdpsRowsFromChannels(stdout: string, stderr: string, fields: readonly string[]): MaxComputeRow[] {
  const candidates = [stdout, stderr, `${stdout}\n${stderr}`].filter((value, index, values) => value.trim() && values.indexOf(value) === index);
  let lastError: unknown;
  for (const candidate of candidates) {
    try { return parseOdpsRows(candidate, fields); }
    catch (error) {
      if (!(error instanceof OdpsCommandError) || error.kind !== "invalid_output") throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new OdpsCommandError("invalid_output", "odpscmd 查询已执行，但 stdout 和 stderr 均为空。");
}

export function parseOdpsRows(output: string, fields: readonly string[]): MaxComputeRow[] {
  const lines = output
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ""));
  const fixedWidthRows = parseFixedWidthOdpsTable(lines, fields);
  if (fixedWidthRows) return fixedWidthRows;
  const rows: MaxComputeRow[] = [];
  let delimiter: "tab" | "pipe" | "space" | null = null;
  let headerFound = false;
  let successMarkerFound = false;
  for (const line of lines) {
    if (/^OK\b/i.test(line.trim())) successMarkerFound = true;
    const parsed = splitOdpsLine(line);
    if (!headerFound) {
      if (parsed && headerMatches(parsed.values, fields)) {
        headerFound = true;
        delimiter = parsed.delimiter;
      }
      continue;
    }
    if (!parsed || parsed.delimiter !== delimiter || isOdpsNoise(line) || isSeparator(parsed.values)) continue;
    addOdpsRow(rows, fields, parsed.values);
  }
  if (headerFound) return rows;

  // Some odpscmd versions honor fieldDelim but omit needHeader for file-based execution.
  // Multi-column tab rows are still unambiguous because client log lines do not contain
  // exactly the requested number of tab-separated fields.
  if (fields.length > 1) {
    for (const line of lines) {
      const parsed = splitOdpsLine(line);
      if (parsed?.delimiter !== "tab" || parsed.values.length !== fields.length || isOdpsNoise(line)) continue;
      addOdpsRow(rows, fields, parsed.values);
    }
    if (rows.length || successMarkerFound) return rows;
  }
  if (successMarkerFound) return [];
  const summary = outputSummary(output);
  throw new OdpsCommandError("invalid_output", `odpscmd 查询已执行，但无法识别返回格式。${summary ? `输出摘要：${summary}` : "未返回可解析的标准输出。"}`);
}

function parseFixedWidthOdpsTable(lines: string[], fields: readonly string[]): MaxComputeRow[] | null {
  for (let top = 0; top < lines.length; top += 1) {
    const boundaries = separatorBoundaries(lines[top] ?? "");
    if (boundaries.length !== fields.length + 1) continue;
    const headerIndex = nextContentLine(lines, top + 1);
    if (headerIndex < 0) continue;
    const header = fixedWidthValues(lines[headerIndex] ?? "", boundaries);
    if (!header || !headerMatches(header, fields)) continue;
    const dividerIndex = nextMatchingSeparator(lines, headerIndex + 1, boundaries);
    if (dividerIndex < 0) continue;
    const rows: MaxComputeRow[] = [];
    for (let index = dividerIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (sameBoundaries(separatorBoundaries(line), boundaries)) return rows;
      if (isOdpsNoise(line)) continue;
      const values = fixedWidthValues(line, boundaries);
      if (values) addOdpsRow(rows, fields, values);
    }
    return rows;
  }
  return null;
}

function separatorBoundaries(line: string): number[] {
  if (!/^\s*\+(?:[-=]+\+)+\s*$/.test(line)) return [];
  const positions: number[] = [];
  for (let index = 0; index < line.length; index += 1) if (line[index] === "+") positions.push(index);
  return positions;
}

function nextContentLine(lines: string[], from: number): number {
  for (let index = from; index < lines.length; index += 1) if ((lines[index] ?? "").trim()) return index;
  return -1;
}

function nextMatchingSeparator(lines: string[], from: number, boundaries: number[]): number {
  for (let index = from; index < lines.length; index += 1) {
    if (sameBoundaries(separatorBoundaries(lines[index] ?? ""), boundaries)) return index;
  }
  return -1;
}

function sameBoundaries(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fixedWidthValues(line: string, boundaries: number[]): string[] | null {
  if (line.includes("\t")) {
    const tabValues = line.trim().split("\t").map((value) => value.trim());
    if (tabValues.length === boundaries.length - 1) return tabValues;
  }
  if (line.length < (boundaries.at(-1) ?? 0)) return null;
  const values: string[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    values.push(line.slice((boundaries[index] ?? 0) + 1, boundaries[index + 1]).trim());
  }
  return values;
}

function splitOdpsLine(line: string): { delimiter: "tab" | "pipe" | "space"; values: string[] } | null {
  if (line.includes("\t")) return { delimiter: "tab", values: line.split("\t").map((value) => value.trim()) };
  const trimmed = line.trim();
  if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
    return { delimiter: "pipe", values: trimmed.slice(1, -1).split("|").map((value) => value.trim()) };
  }
  const aligned = trimmed.split(/\s{2,}/).map((value) => value.trim());
  if (aligned.length > 1) return { delimiter: "space", values: aligned };
  return null;
}

function headerMatches(values: string[], fields: readonly string[]): boolean {
  return values.length === fields.length && values.every((value, index) => normalizeHeader(value) === normalizeHeader(fields[index] ?? ""));
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/^[`'"]|[`'"]$/g, "").toLowerCase();
}

function isSeparator(values: string[]): boolean {
  return values.every((value) => /^[-+:=\s]*$/.test(value));
}

function isOdpsNoise(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed || /^OK\b|^ID\b|^Log view:|^Time taken:/i.test(trimmed) || /^\d{4}-\d{2}-\d{2}.*\b(?:M\d+|R\d+_\d+)_job_.*\[(?:RUNNING|TERMINATED)\]/i.test(trimmed);
}

function addOdpsRow(rows: MaxComputeRow[], fields: readonly string[], values: string[]): void {
  if (values.length !== fields.length || isSeparator(values)) return;
  const row: MaxComputeRow = {};
  fields.forEach((field, index) => { row[field] = values[index] ?? ""; });
  rows.push(row);
}

function outputSummary(output: string): string {
  return output
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/\s{2,}/g, " ")
    .trim()
    .slice(-1_000);
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

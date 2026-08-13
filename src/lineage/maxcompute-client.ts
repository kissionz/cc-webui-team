import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { splitArguments } from "../runtime/runtime-helpers.js";

export type MaxComputeRow = Record<string, string>;

export interface MaxComputeQueryClient {
  query(sql: string, fields: readonly string[]): Promise<MaxComputeRow[]>;
}

export interface OdpsCommandClientOptions {
  command: string;
  args: string;
  project: string;
  timeoutMs?: number;
}

export class OdpsCommandClient implements MaxComputeQueryClient {
  constructor(private readonly options: OdpsCommandClientOptions) {}

  async query(sql: string, fields: readonly string[]): Promise<MaxComputeRow[]> {
    if (!this.options.project) throw new Error("MaxCompute 项目名称尚未配置。");
    if (!fields.length) return [];
    const output = `set odps.sql.select.output.format={"needHeader":true,"fieldDelim":"\\t"};\n${sql.trim().replace(/;?\s*$/, ";")}`;
    const args = [...splitArguments(this.options.args), `--project=${this.options.project}`, "-e", output];
    const child = spawn(this.options.command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), this.options.timeoutMs ?? 10 * 60 * 1_000);
    timeout.unref();
    const expectedHeader = fields.join("\t");
    const rows: MaxComputeRow[] = [];
    const stderr: string[] = [];
    let headerFound = false;
    let stdoutTail = "";
    const lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lineReader.on("line", (raw) => {
      const line = raw.replace(/\r$/, "");
      stdoutTail = `${stdoutTail}\n${line}`.slice(-8_192);
      if (!headerFound) {
        if (line.trim() === expectedHeader) headerFound = true;
        return;
      }
      if (!line || /^OK\b|^ID\b|^Log view:/i.test(line)) return;
      const values = line.split("\t");
      if (values.length !== fields.length) return;
      const row: MaxComputeRow = {};
      fields.forEach((field, index) => { row[field] = values[index] ?? ""; });
      rows.push(row);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    }).finally(() => clearTimeout(timeout));
    if (exitCode !== 0) {
      const detail = stderr.join("").trim() || stdoutTail.trim();
      throw new Error(`odpscmd 查询失败（退出码 ${exitCode}）${detail ? `：${detail.slice(-2_000)}` : ""}`);
    }
    if (!headerFound) {
      throw new Error("无法识别 odpscmd 输出。请确认客户端可用，并在 odps_config.ini 中关闭 use_instance_tunnel。");
    }
    return rows;
  }
}

import { readFile, stat } from "node:fs/promises";
import { parse, relative, resolve } from "node:path";

import { query, type Options as ClaudeOptions } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeConfig } from "../domain/index.js";
import { resolveAllowedRealPath } from "../security/paths.js";
import { claudeRuntimeEnvironment, cliArgsToExtraArgs, resolveClaudeExecutable, sanitizeClaudeExtraArgs, splitArguments } from "../runtime/runtime-helpers.js";

export interface ColumnLineageRelation {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  transformation: string;
  confidence: "high" | "medium" | "low";
  evidenceIds: string[];
}

export interface ColumnLineageEvidence {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  language: string;
  snippet: string;
  explanation: string;
}

export interface ColumnLineageResult {
  status: "found" | "partial" | "not_found";
  table: string;
  column: string;
  summary: string;
  relations: ColumnLineageRelation[];
  evidence: ColumnLineageEvidence[];
  warnings: string[];
}

export interface ColumnLineageAnalyzerOptions {
  maximumConcurrent?: number;
  timeoutMs?: number;
  queryFactory?: typeof query;
}

export class ColumnLineageAnalyzer {
  private active = 0;
  private readonly maximumConcurrent: number;
  private readonly timeoutMs: number;
  private readonly queryFactory: typeof query;

  constructor(options: ColumnLineageAnalyzerOptions = {}) {
    this.maximumConcurrent = options.maximumConcurrent ?? 2;
    this.timeoutMs = options.timeoutMs ?? 3 * 60 * 1_000;
    this.queryFactory = options.queryFactory ?? query;
  }

  async analyze(input: { cwd: string; table: string; column: string; config: ClaudeConfig }): Promise<ColumnLineageResult> {
    if (this.active >= this.maximumConcurrent) throw new Error("字段血缘分析任务已满，请稍后重试。");
    this.active += 1;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(new Error("字段血缘分析超时。")), this.timeoutMs);
    timeout.unref();
    try {
      const cwd = await resolveAllowedRealPath(input.cwd, [input.config.workspaceRoot]);
      const executable = resolveClaudeExecutable(input.config.command);
      const options: ClaudeOptions = {
        cwd,
        abortController,
        env: claudeRuntimeEnvironment(),
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Glob", "Grep"],
        disallowedTools: ["Write", "Edit", "Bash", "NotebookEdit", "WebFetch", "WebSearch", "Task"],
        maxTurns: 15,
        maxBudgetUsd: 1,
        effort: "medium",
        extraArgs: cliArgsToExtraArgs(sanitizeClaudeExtraArgs(splitArguments(input.config.args))),
        outputFormat: { type: "json_schema", schema: COLUMN_LINEAGE_SCHEMA },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          autoAllowBashIfSandboxed: false,
          filesystem: { denyRead: [parse(cwd).root], allowRead: [cwd], allowWrite: [] },
        },
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      };
      let structured: unknown;
      let textResult = "";
      const handle = this.queryFactory({ prompt: lineagePrompt(input.table, input.column), options });
      for await (const event of handle) {
        if (!event || typeof event !== "object" || !("type" in event) || event.type !== "result") continue;
        if ("structured_output" in event) structured = event.structured_output;
        if ("result" in event && typeof event.result === "string") textResult = event.result;
        if ("is_error" in event && event.is_error) {
          const errors = "errors" in event && Array.isArray(event.errors) ? event.errors.join("；") : textResult;
          throw new Error(errors || "Claude Code 字段血缘分析失败。");
        }
      }
      if (!structured && textResult) {
        try { structured = JSON.parse(textResult) as unknown; } catch { /* structured output is authoritative */ }
      }
      const parsed = parseColumnLineageResult(structured, input.table, input.column);
      return await hydrateEvidence(parsed, cwd);
    } finally {
      clearTimeout(timeout);
      this.active -= 1;
    }
  }

  metricsSnapshot(): Record<string, unknown> { return { active: this.active, maximumConcurrent: this.maximumConcurrent }; }
}

const COLUMN_LINEAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "table", "column", "summary", "relations", "evidence", "warnings"],
  properties: {
    status: { type: "string", enum: ["found", "partial", "not_found"] },
    table: { type: "string" },
    column: { type: "string" },
    summary: { type: "string" },
    relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sourceTable", "sourceColumn", "targetTable", "targetColumn", "transformation", "confidence", "evidenceIds"],
        properties: {
          sourceTable: { type: "string" }, sourceColumn: { type: "string" }, targetTable: { type: "string" },
          targetColumn: { type: "string" }, transformation: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    evidence: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "path", "startLine", "endLine", "language", "explanation"],
        properties: {
          id: { type: "string" }, path: { type: "string" }, startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 }, language: { type: "string" }, explanation: { type: "string" },
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const;

function lineagePrompt(table: string, column: string): string {
  return `你是数据血缘分析器。请在当前 workspace 中只读搜索与 MaxCompute 表 ${table} 的字段 ${column} 有关的 SQL、Python、Shell、配置或调度代码。\n\n要求：\n1. 找出该字段的直接上游、直接下游以及加工表达式。\n2. 每条关系必须引用 evidenceIds，证据必须是当前 workspace 内真实存在的文件和准确行号。\n3. 不要猜测。无法从代码证明时返回 not_found 或 partial，并写入 warnings。\n4. sourceTable/targetTable 使用 project.table 或 table，禁止添加 default schema。\n5. transformation 用简洁中文说明聚合、CASE、JOIN、直接映射或其他加工。\n6. 不要输出代码块或额外文字，只按给定 JSON Schema 返回。`;
}

async function hydrateEvidence(result: ColumnLineageResult, cwd: string): Promise<ColumnLineageResult> {
  const evidence: ColumnLineageEvidence[] = [];
  const warnings = [...result.warnings];
  for (const item of result.evidence.slice(0, 20)) {
    try {
      const path = await resolveAllowedRealPath(resolve(cwd, item.path), [cwd]);
      if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error("文件超过 2MB");
      const lines = (await readFile(path, "utf8")).split(/\r?\n/);
      const startLine = Math.max(1, Math.min(lines.length || 1, item.startLine));
      const endLine = Math.max(startLine, Math.min(lines.length || startLine, item.endLine, startLine + 79));
      evidence.push({ ...item, path: relative(cwd, path), startLine, endLine, snippet: lines.slice(startLine - 1, endLine).join("\n") });
    } catch (error) {
      warnings.push(`证据 ${item.id} 无法读取：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const validIds = new Set(evidence.map((item) => item.id));
  const relations = result.relations.filter((relation) => relation.evidenceIds.some((id) => validIds.has(id)));
  const status = relations.length ? (relations.length === result.relations.length ? result.status : "partial") : "not_found";
  if (result.relations.length && !relations.length) warnings.push("Claude Code 返回的关系缺少可验证的 workspace 代码证据，已隐藏。" );
  return { ...result, status, relations, evidence, warnings };
}

function parseColumnLineageResult(value: unknown, table: string, column: string): ColumnLineageResult {
  if (!record(value)) throw new Error("Claude Code 未返回有效的字段血缘结构。");
  const status = oneOf(value.status, ["found", "partial", "not_found"] as const, "not_found");
  const relations = Array.isArray(value.relations) ? value.relations.filter(record).map((item): ColumnLineageRelation => ({
    sourceTable: text(item.sourceTable), sourceColumn: text(item.sourceColumn), targetTable: text(item.targetTable),
    targetColumn: text(item.targetColumn), transformation: text(item.transformation),
    confidence: oneOf(item.confidence, ["high", "medium", "low"] as const, "low"),
    evidenceIds: strings(item.evidenceIds),
  })).slice(0, 100) : [];
  const evidence = Array.isArray(value.evidence) ? value.evidence.filter(record).map((item): ColumnLineageEvidence => ({
    id: text(item.id), path: text(item.path), startLine: positive(item.startLine), endLine: positive(item.endLine),
    language: text(item.language, "text"), snippet: "", explanation: text(item.explanation),
  })).filter((item) => item.id && item.path).slice(0, 20) : [];
  return { status, table: text(value.table, table), column: text(value.column, column), summary: text(value.summary), relations, evidence, warnings: strings(value.warnings).slice(0, 50) };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value.slice(0, 20_000) : fallback; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 2_000)) : []; }
function positive(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1; }
function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] { return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T[number] : fallback; }

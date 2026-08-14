import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaudeConfig, MaxComputeConfig } from "../src/domain/index.js";
import { ColumnLineageAnalyzer } from "../src/lineage/column-analyzer.js";
import { buildOdpsScript, decodeOdpsOutput, extractOdpsFailure, parseOdpsRows, parseOdpsRowsFromChannels, resolveOdpsInvocation, type MaxComputeQueryClient, type MaxComputeRow } from "../src/lineage/maxcompute-client.js";
import { LineageScheduler, nextShanghaiRun, previousShanghaiDate } from "../src/lineage/scheduler.js";
import { LineageSyncService, parseTableList } from "../src/lineage/sync-service.js";
import { PersistenceRepository } from "../src/persistence/index.js";

const roots: string[] = [];
const now = Date.parse("2026-08-13T07:30:00+08:00");

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function repository(): Promise<PersistenceRepository> {
  const root = await mkdtemp(join(tmpdir(), "cc-lineage-"));
  roots.push(root);
  return (await PersistenceRepository.open({ databasePath: join(root, "app.sqlite"), now: () => now })).repository;
}

function config(overrides: Partial<MaxComputeConfig> = {}): MaxComputeConfig {
  return {
    enabled: true,
    command: "odpscmd",
    args: "--config=/run/secrets/odps.ini",
    project: "analytics",
    collectionMode: "all",
    collectionProjects: [],
    discoveredProjects: [],
    endpoint: "https://service.cn-shanghai.maxcompute.aliyun.com/api",
    credentialCiphertext: null,
    credentialUpdatedAt: null,
    scheduleTime: "06:15",
    timezone: "Asia/Shanghai",
    lastStartedAt: null,
    lastCompletedAt: null,
    lastStatus: "idle",
    lastError: null,
    lastDataDate: null,
    nextRunAt: null,
    updatedAt: now,
    ...overrides,
  };
}

class FixtureClient implements MaxComputeQueryClient {
  readonly sql: string[] = [];

  async query(statement: string): Promise<MaxComputeRow[]> {
    this.sql.push(statement);
    if (statement.includes("INFORMATION_SCHEMA.tables")) return [{
      table_catalog: "analytics", table_name: "dws_sales", table_type: "MANAGED_TABLE", table_comment: "销售汇总",
      owner_id: "owner-1", owner_name: "alice", is_partitioned: "true", create_time: "2025-01-01 08:00:00",
      last_modified_time: "", last_access_time: "", data_length: "", lifecycle: "30", storage_tier: "standard",
      cluster_type: "RANGE", number_buckets: "16", has_primary_key: "false", is_transactional: "false",
      is_delta_table: "false", table_storage: "native", table_format: "ORC",
    }];
    if (statement.includes("INFORMATION_SCHEMA.columns")) return [
      { table_catalog: "analytics", table_name: "dws_sales", column_name: "customer_id", ordinal_position: "1", data_type: "STRING", column_comment: "客户", is_nullable: "true", is_partition_key: "false", is_primary_key: "false" },
      { table_catalog: "analytics", table_name: "dws_sales", column_name: "ds", ordinal_position: "2", data_type: "STRING", column_comment: "日期", is_nullable: "true", is_partition_key: "true", is_primary_key: "false" },
    ];
    if (statement.includes("INFORMATION_SCHEMA.partitions")) return [{ table_catalog: "analytics", table_name: "dws_sales", partition_count: "38", data_length: "4096", last_modified_time: "2026-08-12 06:10:00", last_access_time: "2026-08-12 09:00:00" }];
    if (statement.includes("INFORMATION_SCHEMA.table_access_info")) return [{ table_catalog: "analytics", table_name: "dws_sales", access_count: "12", access_bytes: "2048", ds: "20260812" }];
    if (statement.includes("INFORMATION_SCHEMA.tasks_history")) return [{
      task_name: "sales_daily", task_type: "SQL", inst_id: "inst-001", status: "Terminated", owner_name: "scheduler",
      end_time: "2026-08-12 06:15:30", input_tables: "[analytics.ods_orders, analytics.dim_customer]",
      output_tables: "[analytics.dws_sales]", ext_node_id: "node-7", ext_node_name: "销售日汇总",
      ext_node_onduty: "u-42", ext_bizdate: "20260811",
    }];
    throw new Error(`unexpected SQL: ${statement}`);
  }
}

describe("MaxCompute table lineage sync", () => {
  it("launches Windows batch clients through cmd.exe without requiring a manual wrapper", () => {
    expect(resolveOdpsInvocation("C:\\MaxCompute Client\\bin\\odpscmd.bat", ["--project=analytics", "-f", "C:\\Temp\\query.sql"], "win32", "C:\\Windows\\System32\\cmd.exe")).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/c", '"C:\\MaxCompute Client\\bin\\odpscmd.bat"', "--project=analytics", "-f", "C:\\Temp\\query.sql"],
    });
    expect(resolveOdpsInvocation("odpscmd", [], "win32")).toMatchObject({ command: "cmd.exe", args: ["/d", "/c", "odpscmd"] });
    expect(resolveOdpsInvocation("C:\\MaxCompute\\odpscmd.exe", ["--help"], "win32")).toEqual({ command: "C:\\MaxCompute\\odpscmd.exe", args: ["--help"] });
    expect(resolveOdpsInvocation("C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "C:\\MaxCompute\\odpscmd.bat", "--project=analytics"], "win32")).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/c", "C:\\MaxCompute\\odpscmd.bat", "--project=analytics"],
    });
  });

  it("decodes UTF-8 and common Chinese Windows odpscmd output", () => {
    expect(decodeOdpsOutput(Buffer.from("连接成功", "utf8"))).toBe("连接成功");
    expect(decodeOdpsOutput(Buffer.from([0xb4, 0xed, 0xce, 0xf3]))).toBe("错误");
  });

  it("enables tenant namespace and treats SQL failures as errors even when odpscmd exits zero", () => {
    expect(buildOdpsScript("SELECT * FROM SYSTEM_CATALOG.INFORMATION_SCHEMA.catalogs")).toContain("set odps.namespace.schema=true;");
    expect(extractOdpsFailure("OK\r\nFAILED: ODPS-0130161: Parse exception", "")).toBe("FAILED: ODPS-0130161: Parse exception");
    expect(extractOdpsFailure("OK\r\ntable_catalog\r\n", "")).toBe("");
  });

  it("parses odpscmd tab, case-insensitive pipe, headerless, and empty outputs", () => {
    expect(parseOdpsRows("TABLE_CATALOG\tTABLE_NAME\r\nanalytics\tdws_sales\r\nOK\r\n", ["table_catalog", "table_name"])).toEqual([
      { table_catalog: "analytics", table_name: "dws_sales" },
    ]);
    expect(parseOdpsRows("+---------------+-----------+\r\n| table_catalog | table_name |\r\n+---------------+-----------+\r\n| analytics     | dws_sales  |\r\n+---------------+-----------+\r\n", ["table_catalog", "table_name"])).toEqual([
      { table_catalog: "analytics", table_name: "dws_sales" },
    ]);
    expect(parseOdpsRows("analytics\tdws_sales\r\nOK\r\n", ["table_catalog", "table_name"])).toEqual([
      { table_catalog: "analytics", table_name: "dws_sales" },
    ]);
    expect(parseOdpsRows("OK\r\n", ["table_catalog", "table_name"])).toEqual([]);
    expect(parseOdpsRows("catalog_name      status    region\r\nbtn_bft           NORMAL    cn-shanghai\r\n", ["catalog_name", "status", "region"])).toEqual([
      { catalog_name: "btn_bft", status: "NORMAL", region: "cn-shanghai" },
    ]);
  });

  it("prefers the fixed-width result table over tab-separated odps job progress", () => {
    const separator = "+--------------------+--------+------------+";
    const row = (first: string, second: string, third: string) => ` ${first.padEnd(20)} ${second.padEnd(8)} ${third.padEnd(12)} `;
    const output = [
      "2026-08-13 18:15:33\tM1_job_0:0/3/3[TERMINATED]\tR2_1_job_0:0/0/1[RUNNING]",
      separator,
      row("catalog_name", "status", "region"),
      separator,
      row("btn_bft", "NORMAL", "cn-shanghai"),
      row("btn_bi", "NORMAL", "cn-shanghai"),
      separator,
    ].join("\r\n");
    expect(parseOdpsRows(output, ["catalog_name", "status", "region"])).toEqual([
      { catalog_name: "btn_bft", status: "NORMAL", region: "cn-shanghai" },
      { catalog_name: "btn_bi", status: "NORMAL", region: "cn-shanghai" },
    ]);
  });

  it("preserves long project names when tab-delimited rows are enclosed by result separators", () => {
    const output = [
      "+--------------------+--------+------------+",
      "catalog_name\tstatus\tregion",
      "+--------------------+--------+------------+",
      "btn_bi_normal\tNORMAL\tcn-shanghai",
      "btn_datalake_cdm\tNORMAL\tcn-shanghai",
      "btn_datalake_finance_dev\tNORMAL\tcn-shanghai",
      "+--------------------+--------+------------+",
    ].join("\r\n");
    expect(parseOdpsRows(output, ["catalog_name", "status", "region"])).toEqual([
      { catalog_name: "btn_bi_normal", status: "NORMAL", region: "cn-shanghai" },
      { catalog_name: "btn_datalake_cdm", status: "NORMAL", region: "cn-shanghai" },
      { catalog_name: "btn_datalake_finance_dev", status: "NORMAL", region: "cn-shanghai" },
    ]);
  });

  it("includes a compact output summary when odpscmd returns an unknown format", () => {
    expect(() => parseOdpsRows("unexpected console output", ["table_catalog"])).toThrow("输出摘要：unexpected console output");
    expect(parseOdpsRowsFromChannels("", "TABLE_CATALOG\tTABLE_NAME\r\nanalytics\tdws_sales\r\n", ["table_catalog", "table_name"])).toEqual([
      { table_catalog: "analytics", table_name: "dws_sales" },
    ]);
  });

  it("persists rich metadata and derives idempotent input-to-output edges", async () => {
    const repo = await repository();
    const client = new FixtureClient();
    const service = new LineageSyncService({ repository: repo, client, project: "analytics", now: () => now });

    expect(await service.sync("20260812")).toEqual({ tablesProcessed: 1, columnsProcessed: 2, jobsProcessed: 1, edgesProcessed: 2 });
    expect(repo.getLineageTable("analytics.dws_sales")).toMatchObject({
      ownerName: "alice", partitionCount: 38, dataLength: 4096, accessCount: 12, accessBytes: 2048,
      lastTaskName: "sales_daily", scheduleNodeName: "销售日汇总", scheduleOnDuty: "u-42", lastBizDate: "20260811",
    });
    expect(repo.listLineageColumns("analytics.dws_sales").map((column) => column.name)).toEqual(["customer_id", "ds"]);
    expect(repo.listLineageEdges("analytics.dws_sales", "up", 3, 20)).toHaveLength(2);

    expect(await service.sync("20260812")).toEqual({ tablesProcessed: 1, columnsProcessed: 2, jobsProcessed: 0, edgesProcessed: 0 });
    expect(repo.listLineageEdges("analytics.dws_sales", "up", 3, 20).map((edge) => edge.occurrenceCount)).toEqual([1, 1]);
    expect(client.sql.every((sql) => sql.includes("SYSTEM_CATALOG.INFORMATION_SCHEMA"))).toBe(true);
    repo.close();
  });

  it("normalizes only default-schema table identifiers", () => {
    expect(parseTableList("[p.ods_order, `p.default.dwd_order`, local_table]", "p")).toEqual([
      "p.ods_order", "p.dwd_order", "p.local_table",
    ]);
    expect(parseTableList("p.custom.fact", "p")).toEqual([]);
  });

  it("queries every visible project or a selected project list from tenant Information Schema", async () => {
    const repo = await repository();
    const allProjects = new FixtureClient();
    await new LineageSyncService({ repository: repo, client: allProjects, project: "analytics", projects: null, now: () => now }).sync("20260812");
    expect(allProjects.sql.find((sql) => sql.includes("INFORMATION_SCHEMA.tables"))).not.toContain("WHERE table_catalog");
    expect(allProjects.sql.find((sql) => sql.includes("INFORMATION_SCHEMA.tasks_history"))).toContain("SELECT task_catalog");

    const selected = new FixtureClient();
    await new LineageSyncService({ repository: repo, client: selected, project: "analytics", projects: ["analytics", "finance"], now: () => now }).sync("20260812");
    expect(selected.sql.find((sql) => sql.includes("INFORMATION_SCHEMA.tables"))).toContain("table_catalog IN ('analytics', 'finance')");
    expect(selected.sql.find((sql) => sql.includes("INFORMATION_SCHEMA.tasks_history"))).toContain("task_catalog IN ('analytics', 'finance')");
    repo.close();
  });
});

describe("LineageScheduler", () => {
  it("computes the next Asia/Shanghai wall-clock run and the previous data date", () => {
    expect(new Date(nextShanghaiRun(Date.parse("2026-08-13T06:00:00+08:00"), "06:15")).toISOString()).toBe("2026-08-12T22:15:00.000Z");
    expect(new Date(nextShanghaiRun(Date.parse("2026-08-13T06:30:00+08:00"), "06:15")).toISOString()).toBe("2026-08-13T22:15:00.000Z");
    expect(previousShanghaiDate(Date.parse("2026-08-13T00:05:00+08:00"))).toBe("20260812");
  });

  it("supports manual execution and records success without requiring automatic scheduling", async () => {
    const repo = await repository();
    repo.saveUser({ id: "u1", username: "admin", passwordHash: "salt:hash", displayName: "Admin", email: "", role: "admin", status: "active", createdAt: now, updatedAt: now });
    repo.saveMaxComputeConfig(config({ enabled: false }));
    const sync = vi.fn(async () => ({ tablesProcessed: 3, columnsProcessed: 8, jobsProcessed: 2, edgesProcessed: 2 }));
    const scheduler = new LineageScheduler({ repository: repo, now: () => now, sync });
    const run = await scheduler.run("manual", "u1");
    expect(run).toMatchObject({ trigger: "manual", requestedBy: "u1", status: "success", dataDate: "20260812", tablesProcessed: 3 });
    expect(repo.getMaxComputeConfig()).toMatchObject({ lastStatus: "success", lastDataDate: "20260812" });
    expect(sync).toHaveBeenCalledOnce();
    await scheduler.close();
    repo.close();
  });
});

describe("ColumnLineageAnalyzer", () => {
  it("returns snippets re-read from the selected workspace and drops unverifiable relations", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-lineage-workspace-"));
    roots.push(root);
    await writeFile(join(root, "sales.sql"), "SELECT\n  customer_id,\n  SUM(amount) AS total_amount\nFROM analytics.ods_orders\nGROUP BY customer_id;\n");
    const queryFactory = (() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: {
            status: "found", table: "analytics.dws_sales", column: "total_amount", summary: "按客户汇总订单金额",
            relations: [
              { sourceTable: "analytics.ods_orders", sourceColumn: "amount", targetTable: "analytics.dws_sales", targetColumn: "total_amount", transformation: "SUM 聚合", confidence: "high", evidenceIds: ["e1"] },
              { sourceTable: "analytics.ghost", sourceColumn: "x", targetTable: "analytics.dws_sales", targetColumn: "total_amount", transformation: "无法验证", confidence: "low", evidenceIds: ["missing"] },
            ],
            evidence: [{ id: "e1", path: "sales.sql", startLine: 1, endLine: 5, language: "sql", explanation: "目标字段定义" }],
            warnings: [],
          },
        };
      },
    })) as never;
    const claudeConfig: ClaudeConfig = {
      command: "claude", args: "", workspaceRoot: root, modelContextTokens: 1_000_000, autoCompactRatio: 0.62,
      autoCompactEnabled: true, mcpToolAllowlist: [], enabled: true, available: true, version: "test", latencyMs: 1,
      authenticated: true, lastCheckAt: now, healthMessage: null, updatedAt: now,
    };
    const analyzer = new ColumnLineageAnalyzer({ queryFactory });
    const result = await analyzer.analyze({ cwd: root, table: "analytics.dws_sales", column: "total_amount", config: claudeConfig });
    expect(result.status).toBe("partial");
    expect(result.relations).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ path: "sales.sql", startLine: 1, endLine: 5 });
    expect(result.evidence[0]?.snippet).toContain("SUM(amount) AS total_amount");
  });
});

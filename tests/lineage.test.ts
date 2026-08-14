import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaudeConfig, MaxComputeConfig } from "../src/domain/index.js";
import { ColumnLineageAnalyzer } from "../src/lineage/column-analyzer.js";
import { DataWorksColumnLineageClient, inferDataWorksRegion } from "../src/lineage/dataworks-lineage-client.js";
import type { MaxComputeQueryClient, MaxComputeRow } from "../src/lineage/maxcompute-client.js";
import { PyOdpsClient, pythonInvocations } from "../src/lineage/pyodps-client.js";
import { LineageScheduler, nextShanghaiRun, previousShanghaiDate } from "../src/lineage/scheduler.js";
import { diagnoseLineageSource, LineageSyncService, parseTableList } from "../src/lineage/sync-service.js";
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
    command: "auto",
    args: "",
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

describe("PyODPS bridge", () => {
  it("selects sensible Python 3 launchers and treats legacy odpscmd settings as auto", () => {
    expect(pythonInvocations("auto", "", "win32")).toEqual([
      { command: "py", args: ["-3"] }, { command: "python", args: [] }, { command: "python3", args: [] },
    ]);
    expect(pythonInvocations('"C:\\Program Files\\Python311\\python.exe"', "-X utf8", "win32")).toEqual([
      { command: "C:\\Program Files\\Python311\\python.exe", args: ["-X", "utf8"] },
    ]);
    expect(pythonInvocations("odpscmd", "", "linux")[0]).toEqual({ command: "python3", args: [] });
  });

  it("reads structured NDJSON rows without exposing credentials in process arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-pyodps-fixture-"));
    roots.push(root);
    const fixture = join(root, "helper-fixture.mjs");
    await writeFile(fixture, `let body="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>body+=c);process.stdin.on("end",()=>{const req=JSON.parse(body);if(process.argv.join(" ").includes(req.accessKeySecret))process.exit(9);if(req.sql==="FAIL"){console.error(JSON.stringify({type:"error",code:"MAXCOMPUTE_QUERY_FAILED",message:"failed",detail:req.accessKeySecret}));process.exitCode=1;return;}console.log(JSON.stringify({type:"meta",pythonVersion:"3.11.9",sdkVersion:"0.13.0",instanceId:"i-test"}));if(req.sql==="STREAM"){for(let i=0;i<20000;i++)console.log(JSON.stringify({type:"row",value:{catalog_name:"p"+i,status:"NORMAL"}}));console.log(JSON.stringify({type:"done",rows:20000}));return;}console.log(JSON.stringify({type:"row",value:{catalog_name:"analytics",status:"NORMAL"}}));console.log(JSON.stringify({type:"done",rows:1}));});`);
    let diagnostic: unknown;
    const client = new PyOdpsClient({
      command: process.execPath, args: `"${fixture}"`, project: "analytics",
      endpoint: "https://service.cn-shanghai.maxcompute.aliyun.com/api",
      credentials: { accessKeyId: "test-id", accessKeySecret: "super-secret" },
      onDiagnostic: (value) => { diagnostic = value; },
    });
    await expect(client.query("SELECT 1", ["catalog_name", "status"])).resolves.toEqual([{ catalog_name: "analytics", status: "NORMAL" }]);
    expect(diagnostic).toMatchObject({ pythonVersion: "3.11.9", sdkVersion: "0.13.0", instanceId: "i-test", rows: 1 });
    const failure = await client.query("FAIL", ["catalog_name", "status"]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("[REDACTED]");
    expect(String(failure)).not.toContain("super-secret");
    let streamed = 0;
    for await (const _row of client.stream("STREAM", ["catalog_name", "status"])) streamed += 1;
    expect(streamed).toBe(20_000);
  });
});

describe("MaxCompute table lineage sync", () => {

  it("persists rich metadata and derives idempotent input-to-output edges", async () => {
    const repo = await repository();
    const client = new FixtureClient();
    const service = new LineageSyncService({ repository: repo, client, project: "analytics", now: () => now });

    expect(await service.sync("20260812")).toEqual({ projectsProcessed: 1, tablesProcessed: 1, columnsProcessed: 2, jobsProcessed: 1, edgesProcessed: 2 });
    expect(repo.getLineageTable("analytics.dws_sales")).toMatchObject({
      ownerName: "alice", partitionCount: 38, dataLength: 4096, accessCount: 12, accessBytes: 2048,
      lastTaskName: "sales_daily", scheduleNodeName: "销售日汇总", scheduleOnDuty: "u-42", lastBizDate: "20260811",
    });
    expect(repo.listLineageColumns("analytics.dws_sales").map((column) => column.name)).toEqual(["customer_id", "ds"]);
    expect(repo.listLineageEdges("analytics.dws_sales", "up", 3, 20)).toHaveLength(2);

    expect(await service.sync("20260812")).toEqual({ projectsProcessed: 1, tablesProcessed: 1, columnsProcessed: 2, jobsProcessed: 0, edgesProcessed: 0 });
    expect(repo.listLineageEdges("analytics.dws_sales", "up", 3, 20).map((edge) => edge.occurrenceCount)).toEqual([1, 1]);
    expect(repo.lineageStorageStats("20260812")).toEqual({ processedJobs: 1, totalEdges: 2 });
    expect(client.sql.every((sql) => sql.includes("SYSTEM_CATALOG.INFORMATION_SCHEMA"))).toBe(true);
    expect(repo.resetLineageData()).toEqual({ tables: 3, edges: 2, processedJobs: 1 });
    expect(repo.lineageStorageStats("20260812")).toEqual({ processedJobs: 0, totalEdges: 0 });
    expect(repo.searchLineageTables("", 20)).toHaveLength(0);
    repo.close();
  });

  it("does not permanently mark jobs whose non-empty table lists cannot be parsed", async () => {
    const repo = await repository();
    const fixture = new FixtureClient();
    const client: MaxComputeQueryClient = {
      query: (statement, fields, options) => statement.includes("INFORMATION_SCHEMA.tasks_history")
        ? Promise.resolve([{
          task_catalog: "analytics", task_name: "broken", task_type: "SQL", inst_id: "broken-1", status: "Terminated",
          end_time: "2026-08-12 06:15:30", input_tables: "{not-a-table}", output_tables: "[analytics.dws_sales]",
        }])
        : fixture.query(statement, fields, options),
    };
    expect(await new LineageSyncService({ repository: repo, client, project: "analytics", now: () => now }).sync("20260812")).toMatchObject({ jobsProcessed: 1, edgesProcessed: 0 });
    expect(repo.isLineageJobProcessed("broken-1")).toBe(false);
    repo.close();
  });

  it("normalizes only default-schema table identifiers", () => {
    expect(parseTableList("[p.ods_order, `p.default.dwd_order`, local_table]", "p")).toEqual([
      "p.ods_order", "p.dwd_order", "p.local_table",
    ]);
    expect(parseTableList("p.custom.fact", "p")).toEqual([]);
    expect(parseTableList("{not-a-table}", "p")).toEqual([]);
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

  it("accepts complete SDK result sets without adding command-line pagination", async () => {
    const repo = await repository();
    const sql: string[] = [];
    const tableRow = (project: string, name: string): MaxComputeRow => ({
      table_catalog: project, table_name: name, table_type: "MANAGED_TABLE", is_partitioned: "false",
    });
    const client: MaxComputeQueryClient = {
      async query() { throw new Error("sync must use the streaming client path"); },
      async *stream(statement) {
        sql.push(statement);
        if (statement.includes("INFORMATION_SCHEMA.tables")) {
          yield tableRow("p1", "a"); yield tableRow("p2", "b"); yield tableRow("p3", "c");
          return;
        }
        if (statement.includes("INFORMATION_SCHEMA.columns")) {
          const duplicate = { table_catalog: "p1", table_name: "a", column_name: "id", ordinal_position: "1", data_type: "STRING" };
          yield duplicate; yield { ...duplicate };
        }
      },
    };
    await expect(new LineageSyncService({
      repository: repo, client, project: "p1", projects: ["p1", "p2", "p3"], now: () => now,
    }).sync("20260812")).resolves.toMatchObject({ projectsProcessed: 3, tablesProcessed: 3, columnsProcessed: 2 });
    const tableQueries = sql.filter((statement) => statement.includes("INFORMATION_SCHEMA.tables"));
    expect(tableQueries).toHaveLength(1);
    expect(tableQueries.every((statement) => statement.includes("table_catalog IN ('p1', 'p2', 'p3')"))).toBe(true);
    expect(tableQueries[0]).not.toContain("sync_page");
    expect(repo.listLineageColumns("p1.a")).toHaveLength(1);
    expect(sql.find((statement) => statement.includes("INFORMATION_SCHEMA.tasks_history"))).toContain("COALESCE(output_tables");
    repo.close();
  });

  it("summarizes source jobs and exposes parser-safe diagnostic samples", async () => {
    const sql: string[] = [];
    const client: MaxComputeQueryClient = {
      async query(statement) {
        sql.push(statement);
        if (statement.includes("GROUP BY task_catalog")) return [{
          task_catalog: "analytics", task_type: "SQL", status: "Terminated", job_count: "12",
          with_inputs: "10", with_outputs: "8", lineage_ready: "7",
        }];
        return [{
          task_catalog: "analytics", task_name: "daily_sales", task_type: "SQL", inst_id: "i-1", status: "Terminated",
          input_tables: "[analytics.ods_orders]", output_tables: "[analytics.dws_sales]",
        }];
      },
    };
    await expect(diagnoseLineageSource(client, ["analytics"], "20260812")).resolves.toMatchObject({
      totalJobs: 12,
      lineageReadyJobs: 7,
      warnings: [],
      samples: [{ parsedInputs: ["analytics.ods_orders"], parsedOutputs: ["analytics.dws_sales"] }],
    });
    expect(sql).toHaveLength(2);
    expect(sql.every((statement) => statement.includes("task_catalog IN ('analytics')"))).toBe(true);
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
    const sync = vi.fn(async () => ({ projectsProcessed: 2, tablesProcessed: 3, columnsProcessed: 8, jobsProcessed: 2, edgesProcessed: 2 }));
    const scheduler = new LineageScheduler({ repository: repo, now: () => now, sync });
    const run = await scheduler.run("manual", "u1");
    expect(run).toMatchObject({ trigger: "manual", requestedBy: "u1", status: "success", dataDate: "20260812", projectsProcessed: 2, tablesProcessed: 3 });
    expect(repo.listLineageSyncRuns(1)[0]).toMatchObject({ projectsProcessed: 2, tablesProcessed: 3, edgesProcessed: 2 });
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

  it("keeps the requested field as the graph anchor instead of trusting a model alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-lineage-anchor-"));
    roots.push(root);
    await writeFile(join(root, "sales.sql"), "SELECT SUM(amount) AS total_amount FROM analytics.ods_orders;\n");
    const queryFactory = (() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result", subtype: "success", is_error: false,
          structured_output: {
            status: "found", table: "wrong_table", column: "wrong_column", summary: "汇总",
            relations: [{ sourceTable: "analytics.ods_orders", sourceColumn: "amount", targetTable: "analytics.dws_sales", targetColumn: "模型误写别名", transformation: "SUM 聚合", confidence: "high", evidenceIds: ["e1"] }],
            evidence: [{ id: "e1", path: "sales.sql", startLine: 1, endLine: 1, language: "sql", explanation: "字段定义" }], warnings: [],
          },
        };
      },
    })) as never;
    const claudeConfig: ClaudeConfig = {
      command: "claude", args: "", workspaceRoot: root, modelContextTokens: 1_000_000, autoCompactRatio: 0.62,
      autoCompactEnabled: true, mcpToolAllowlist: [], enabled: true, available: true, version: "test", latencyMs: 1,
      authenticated: true, lastCheckAt: now, healthMessage: null, updatedAt: now,
    };
    const result = await new ColumnLineageAnalyzer({ queryFactory }).analyze({ cwd: root, table: "analytics.dws_sales", column: "total_amount", config: claudeConfig });
    expect(result).toMatchObject({ table: "analytics.dws_sales", column: "total_amount" });
    expect(result.relations[0]).toMatchObject({ sourceColumn: "amount", targetColumn: "total_amount" });
  });

  it("uses server-collected read-only excerpts on native Windows without enabling unsandboxed tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-lineage-windows-"));
    roots.push(root);
    await writeFile(join(root, "sales.sql"), "SELECT amount AS total_amount FROM analytics.ods_orders;\n");
    let invocation: { prompt?: string; options?: { allowedTools?: string[]; sandbox?: unknown } } = {};
    const queryFactory = ((input: typeof invocation) => {
      invocation = input;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", is_error: false, structured_output: { status: "not_found", table: "analytics.dws_sales", column: "total_amount", summary: "", relations: [], evidence: [], warnings: [] } };
        },
      };
    }) as never;
    const claudeConfig: ClaudeConfig = {
      command: "claude", args: "", workspaceRoot: root, modelContextTokens: 1_000_000, autoCompactRatio: 0.62,
      autoCompactEnabled: true, mcpToolAllowlist: [], enabled: true, available: true, version: "test", latencyMs: 1,
      authenticated: true, lastCheckAt: now, healthMessage: null, updatedAt: now,
    };
    await new ColumnLineageAnalyzer({ queryFactory, platform: "win32" }).analyze({ cwd: root, table: "analytics.dws_sales", column: "total_amount", config: claudeConfig });
    expect(invocation.options?.allowedTools).toEqual([]);
    expect(invocation.options?.sandbox).toBeUndefined();
    expect(invocation.prompt).toContain("FILE sales.sql L1-L2");
  });
});

describe("DataWorks field lineage", () => {
  it("resolves the canonical column entity before querying upstream and downstream", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const selectedId = "maxcompute-column:::analytics::dws_sales:Total_Amount";
    const client = {
      async listColumns(request: Record<string, unknown>) {
        requests.push(request);
        return { body: { pagingInfo: { columns: [{ id: selectedId, name: "Total_Amount" }] } } };
      },
      async listLineages(request: Record<string, unknown>) {
        requests.push(request);
        if (request.dstEntityId) return { body: { pagingInfo: { totalCount: 1, lineages: [{
          srcEntity: { id: "maxcompute-column:::analytics::ods_orders:raw_amount", name: "raw_amount" },
          dstEntity: { id: selectedId, name: "Total_Amount" },
          relationships: [{ task: { id: "task-1", type: "dataworks-sql" }, createTime: 10 }],
        }] } } };
        return { body: { pagingInfo: { totalCount: 0, lineages: [] } } };
      },
    };
    const lineage = new DataWorksColumnLineageClient({ credentials: { accessKeyId: "id", accessKeySecret: "secret" }, region: "cn-shanghai", client: client as never });
    const relations = await lineage.queryColumn({ project: "analytics", table: "dws_sales", column: "total_amount" });
    expect(requests[0]).toMatchObject({ tableId: "maxcompute-table:::analytics::dws_sales", name: "total_amount" });
    expect(requests[1]).toMatchObject({ dstEntityId: selectedId });
    expect(relations).toEqual([expect.objectContaining({ sourceTable: "analytics.ods_orders", sourceColumn: "raw_amount", targetTable: "analytics.dws_sales", targetColumn: "Total_Amount" })]);
  });

  it("infers the DataWorks region from discovered projects or the MaxCompute endpoint", () => {
    expect(inferDataWorksRegion(config({ discoveredProjects: [{ name: "analytics", status: "NORMAL", region: "cn-beijing" }] }), "analytics")).toBe("cn-beijing");
    expect(inferDataWorksRegion(config(), "analytics")).toBe("cn-shanghai");
  });
});

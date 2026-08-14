import type {
  LineageColumn,
  LineageEdge,
  LineageTable,
} from "../domain/index.js";
import type { PersistenceRepository } from "../persistence/index.js";
import type { MaxComputeQueryClient, MaxComputeRow } from "./maxcompute-client.js";

export interface LineageSyncResult {
  projectsProcessed: number;
  tablesProcessed: number;
  columnsProcessed: number;
  jobsProcessed: number;
  edgesProcessed: number;
}

export interface LineageSourceDiagnosticGroup {
  project: string;
  taskType: string;
  status: string;
  jobs: number;
  withInputs: number;
  withOutputs: number;
  lineageReady: number;
}

export interface LineageSourceDiagnosticSample {
  project: string;
  taskName: string;
  taskType: string;
  instanceId: string;
  status: string;
  inputTables: string;
  outputTables: string;
  parsedInputs: string[];
  parsedOutputs: string[];
}

export interface LineageSourceDiagnostic {
  dataDate: string;
  totalJobs: number;
  lineageReadyJobs: number;
  groups: LineageSourceDiagnosticGroup[];
  samples: LineageSourceDiagnosticSample[];
  warnings: string[];
}

export interface LineageSyncServiceOptions {
  repository: PersistenceRepository;
  client: MaxComputeQueryClient;
  project: string;
  projects?: readonly string[] | null;
  pageSize?: number;
  now?: () => number;
}

export class LineageSyncService {
  private readonly now: () => number;

  constructor(private readonly options: LineageSyncServiceOptions) {
    this.now = options.now ?? Date.now;
    if (!/^[A-Za-z0-9_.-]+$/.test(options.project)) throw new Error("MaxCompute 项目名称格式不正确。");
    if (options.projects?.some((project) => !/^[A-Za-z0-9_.-]+$/.test(project))) throw new Error("MaxCompute 采集项目名称格式不正确。");
  }

  async sync(dataDate: string): Promise<LineageSyncResult> {
    if (!/^\d{8}$/.test(dataDate)) throw new Error("同步日期必须使用 yyyyMMdd 格式。");
    const projects = this.options.projects === undefined ? [this.options.project] : this.options.projects;
    const pageSize = this.options.pageSize ?? SYNC_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SYNC_PAGE_SIZE) throw new Error(`同步分页大小必须为 1-${SYNC_PAGE_SIZE}。`);
    const [tables, columns, partitions, access, jobs] = await Promise.all([
      pagedQuery(this.options.client, tablesSql(projects), TABLE_FIELDS, "table_catalog, table_name", pageSize),
      pagedQuery(this.options.client, columnsSql(projects), COLUMN_FIELDS, "table_catalog, table_name, ordinal_position", pageSize),
      pagedQuery(this.options.client, partitionsSql(projects), PARTITION_FIELDS, "table_catalog, table_name", pageSize),
      pagedQuery(this.options.client, accessSql(projects, dataDate), ACCESS_FIELDS, "table_catalog, table_name", pageSize),
      pagedQuery(this.options.client, tasksSql(projects, dataDate), TASK_FIELDS, "task_catalog, inst_id, task_name, end_time", pageSize),
    ]);
    const at = this.now();
    const processedProjects = new Set<string>([
      ...tables.map((row) => field(row, "table_catalog")),
      ...columns.map((row) => field(row, "table_catalog")),
      ...partitions.map((row) => field(row, "table_catalog")),
      ...access.map((row) => field(row, "table_catalog")),
      ...jobs.map((row) => row.task_catalog || this.options.project),
    ]);
    const partitionByTable = new Map(partitions.map((row) => [tableId(field(row, "table_catalog"), field(row, "table_name")), row]));
    const existing = new Map<string, LineageTable>();
    this.options.repository.transaction(() => {
      for (const row of tables) {
        const id = tableId(field(row, "table_catalog"), field(row, "table_name"));
        const current = this.options.repository.getLineageTable(id);
        const partition = partitionByTable.get(id);
        const table = tableFromRows(row, partition, current, at);
        this.options.repository.saveLineageTable(table);
        existing.set(id, table);
      }
      const columnsByTable = new Map<string, LineageColumn[]>();
      for (const row of columns) {
        const id = tableId(field(row, "table_catalog"), field(row, "table_name"));
        if (!this.options.repository.getLineageTable(id)) this.options.repository.ensureLineageTable(id, at);
        const values = columnsByTable.get(id) ?? [];
        values.push(columnFromRow(id, row, at));
        columnsByTable.set(id, values);
      }
      for (const [id, values] of columnsByTable) this.options.repository.replaceLineageColumns(id, values);
      for (const row of access) {
        this.options.repository.upsertLineageAccess(
          tableId(field(row, "table_catalog"), field(row, "table_name")),
          row.ds || dataDate,
          integer(row.access_count),
          integer(row.access_bytes),
          at,
        );
      }
    });

    let jobsProcessed = 0;
    let edgesProcessed = 0;
    for (const row of jobs) {
      const instanceId = row.inst_id;
      if (!instanceId || this.options.repository.isLineageJobProcessed(instanceId)) continue;
      const taskProject = row.task_catalog || this.options.project;
      const inputs = parseTableList(row.input_tables, taskProject);
      const outputs = parseTableList(row.output_tables, taskProject);
      const invalidInputs = tableListHasContent(row.input_tables) && inputs.length === 0;
      const invalidOutputs = tableListHasContent(row.output_tables) && outputs.length === 0;
      const endedAt = maxComputeTime(row.end_time) ?? at;
      this.options.repository.transaction(() => {
        for (const output of outputs) {
          this.options.repository.updateLineageTableSchedule(output, {
            at: endedAt,
            status: row.status || "unknown",
            taskName: nullable(row.task_name),
            instanceId: nullable(instanceId),
            owner: nullable(row.owner_name),
            nodeId: nullable(row.ext_node_id),
            nodeName: nullable(row.ext_node_name),
            onDuty: nullable(row.ext_node_onduty),
            bizDate: nullable(row.ext_bizdate),
          });
        }
        if (row.status === "Terminated" && ["SQL", "SQLRT"].includes(row.task_type ?? "")) {
          for (const sourceTableId of inputs) {
            for (const targetTableId of outputs) {
              if (sourceTableId === targetTableId) continue;
              const edge: LineageEdge = {
                sourceTableId,
                targetTableId,
                firstSeenAt: endedAt,
                lastSeenAt: endedAt,
                occurrenceCount: 1,
                lastInstanceId: nullable(instanceId),
                lastTaskName: nullable(row.task_name),
                lastOwnerName: nullable(row.owner_name),
                lastNodeId: nullable(row.ext_node_id),
                lastNodeName: nullable(row.ext_node_name),
                lastOnDuty: nullable(row.ext_node_onduty),
                updatedAt: at,
              };
              this.options.repository.upsertLineageEdge(edge);
              edgesProcessed += 1;
            }
          }
        }
        if (!invalidInputs && !invalidOutputs) this.options.repository.markLineageJobProcessed(instanceId, dataDate, at);
      });
      jobsProcessed += 1;
    }
    processedProjects.delete("");
    return { projectsProcessed: processedProjects.size, tablesProcessed: tables.length, columnsProcessed: columns.length, jobsProcessed, edgesProcessed };
  }
}

const TABLE_FIELDS = ["table_catalog", "table_name", "table_type", "table_comment", "owner_id", "owner_name", "is_partitioned", "create_time", "last_modified_time", "last_access_time", "data_length", "lifecycle", "storage_tier", "cluster_type", "number_buckets", "has_primary_key", "is_transactional", "is_delta_table", "table_storage", "table_format"] as const;
const COLUMN_FIELDS = ["table_catalog", "table_name", "column_name", "ordinal_position", "data_type", "column_comment", "is_nullable", "is_partition_key", "is_primary_key"] as const;
const PARTITION_FIELDS = ["table_catalog", "table_name", "partition_count", "data_length", "last_modified_time", "last_access_time"] as const;
const ACCESS_FIELDS = ["table_catalog", "table_name", "access_count", "access_bytes", "ds"] as const;
const TASK_FIELDS = ["task_catalog", "task_name", "task_type", "inst_id", "status", "owner_name", "end_time", "input_tables", "output_tables", "ext_node_id", "ext_node_name", "ext_node_onduty", "ext_bizdate"] as const;

function cleanText(name: string): string { return `REGEXP_REPLACE(COALESCE(${name}, ''), '[\\\\t\\\\r\\\\n]+', ' ') AS ${name}`; }
function quote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function timeText(name: string): string { return `COALESCE(TO_CHAR(${name}, 'yyyy-mm-dd hh:mi:ss'), '') AS ${name}`; }

function tablesSql(projects: readonly string[] | null): string {
  return `SELECT table_catalog, table_name, table_type, ${cleanText("table_comment")}, owner_id, owner_name,
    CAST(is_partitioned AS STRING) AS is_partitioned, ${timeText("create_time")}, ${timeText("last_modified_time")},
    ${timeText("last_access_time")}, CAST(data_length AS STRING) AS data_length, CAST(lifecycle AS STRING) AS lifecycle,
    storage_tier, cluster_type, CAST(number_buckets AS STRING) AS number_buckets,
    CAST(has_primary_key AS STRING) AS has_primary_key, CAST(is_transactional AS STRING) AS is_transactional,
    CAST(is_delta_table AS STRING) AS is_delta_table, table_storage, table_format
    FROM SYSTEM_CATALOG.INFORMATION_SCHEMA.tables${where(catalogFilter("table_catalog", projects))}`;
}

function columnsSql(projects: readonly string[] | null): string {
  return `SELECT table_catalog, table_name, column_name, CAST(ordinal_position AS STRING) AS ordinal_position,
    data_type, ${cleanText("column_comment")}, CAST(is_nullable AS STRING) AS is_nullable,
    CAST(is_partition_key AS STRING) AS is_partition_key, CAST(is_primary_key AS STRING) AS is_primary_key
    FROM SYSTEM_CATALOG.INFORMATION_SCHEMA.columns${where(catalogFilter("table_catalog", projects))}`;
}

function partitionsSql(projects: readonly string[] | null): string {
  return `SELECT table_catalog, table_name, CAST(COUNT(1) AS STRING) AS partition_count,
    CAST(SUM(data_length) AS STRING) AS data_length,
    COALESCE(TO_CHAR(MAX(last_modified_time), 'yyyy-mm-dd hh:mi:ss'), '') AS last_modified_time,
    COALESCE(TO_CHAR(MAX(last_access_time), 'yyyy-mm-dd hh:mi:ss'), '') AS last_access_time
    FROM SYSTEM_CATALOG.INFORMATION_SCHEMA.partitions${where(catalogFilter("table_catalog", projects))} GROUP BY table_catalog, table_name`;
}

function accessSql(projects: readonly string[] | null, dataDate: string): string {
  return `SELECT table_catalog, table_name, CAST(access_count AS STRING) AS access_count,
    CAST(access_bytes AS STRING) AS access_bytes, ds FROM SYSTEM_CATALOG.INFORMATION_SCHEMA.table_access_info
    ${where(catalogFilter("table_catalog", projects), `ds=${quote(dataDate)}`)}`;
}

function tasksSql(projects: readonly string[] | null, dataDate: string): string {
  return `SELECT task_catalog, ${cleanText("task_name")}, task_type, inst_id, status, owner_name, ${timeText("end_time")},
    ${cleanText("input_tables")}, ${cleanText("output_tables")}, ext_node_id, ${cleanText("ext_node_name")},
    ext_node_onduty, ext_bizdate FROM SYSTEM_CATALOG.INFORMATION_SCHEMA.tasks_history
    ${where(
      catalogFilter("task_catalog", projects),
      `ds=${quote(dataDate)}`,
      "task_type IN ('SQL','SQLRT')",
      "TRIM(COALESCE(output_tables, '')) NOT IN ('', '[]')",
    )}`;
}

const SYNC_PAGE_SIZE = 5_000;
const MAX_SYNC_ROWS = 5_000_000;

async function pagedQuery(
  client: MaxComputeQueryClient,
  sql: string,
  fields: readonly string[],
  orderBy: string,
  pageSize: number,
): Promise<MaxComputeRow[]> {
  const rows: MaxComputeRow[] = [];
  for (let offset = 0; offset <= MAX_SYNC_ROWS; offset += pageSize) {
    const page = await client.query(`${sql}\nORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`, fields);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
  throw new Error(`单类血缘同步记录超过 ${MAX_SYNC_ROWS} 行，已停止以避免内存耗尽。`);
}

export async function diagnoseLineageSource(
  client: MaxComputeQueryClient,
  projects: readonly string[] | null,
  dataDate: string,
): Promise<LineageSourceDiagnostic> {
  if (!/^\d{8}$/.test(dataDate)) throw new Error("诊断日期必须使用 yyyyMMdd 格式。");
  const filter = where(catalogFilter("task_catalog", projects), `ds=${quote(dataDate)}`, "task_type IN ('SQL','SQLRT')");
  const groups = await client.query(`SELECT task_catalog, task_type, status,
    CAST(COUNT(1) AS STRING) AS job_count,
    CAST(SUM(CASE WHEN TRIM(COALESCE(input_tables, '')) NOT IN ('', '[]') THEN 1 ELSE 0 END) AS STRING) AS with_inputs,
    CAST(SUM(CASE WHEN TRIM(COALESCE(output_tables, '')) NOT IN ('', '[]') THEN 1 ELSE 0 END) AS STRING) AS with_outputs,
    CAST(SUM(CASE WHEN status='Terminated' AND TRIM(COALESCE(input_tables, '')) NOT IN ('', '[]')
      AND TRIM(COALESCE(output_tables, '')) NOT IN ('', '[]') THEN 1 ELSE 0 END) AS STRING) AS lineage_ready
    FROM SYSTEM_CATALOG.INFORMATION_SCHEMA.tasks_history${filter}
    GROUP BY task_catalog, task_type, status ORDER BY task_catalog, task_type, status`,
  ["task_catalog", "task_type", "status", "job_count", "with_inputs", "with_outputs", "lineage_ready"]);
  const samples = await client.query(`SELECT task_catalog, ${cleanText("task_name")}, task_type, inst_id, status,
    ${cleanText("input_tables")}, ${cleanText("output_tables")}
    FROM SYSTEM_CATALOG.INFORMATION_SCHEMA.tasks_history${filter}
    ORDER BY end_time DESC LIMIT 20`,
  ["task_catalog", "task_name", "task_type", "inst_id", "status", "input_tables", "output_tables"]);
  const mappedGroups = groups.map((row) => ({
    project: field(row, "task_catalog"),
    taskType: field(row, "task_type"),
    status: field(row, "status"),
    jobs: integer(row.job_count),
    withInputs: integer(row.with_inputs),
    withOutputs: integer(row.with_outputs),
    lineageReady: integer(row.lineage_ready),
  }));
  const mappedSamples = samples.map((row) => {
    const project = field(row, "task_catalog");
    return {
      project,
      taskName: field(row, "task_name"),
      taskType: field(row, "task_type"),
      instanceId: field(row, "inst_id"),
      status: field(row, "status"),
      inputTables: field(row, "input_tables"),
      outputTables: field(row, "output_tables"),
      parsedInputs: parseTableList(row.input_tables, project),
      parsedOutputs: parseTableList(row.output_tables, project),
    };
  });
  const totalJobs = mappedGroups.reduce((sum, group) => sum + group.jobs, 0);
  const lineageReadyJobs = mappedGroups.reduce((sum, group) => sum + group.lineageReady, 0);
  const warnings: string[] = [];
  if (!totalJobs) warnings.push(`${dataDate} 没有返回 SQL/SQLRT 作业，请核对采集项目、AK 权限和数据日期。`);
  else if (!lineageReadyJobs) warnings.push("作业已返回，但没有同时包含输入表和输出表的成功任务，暂时无法生成表血缘。");
  if (mappedSamples.some((sample) => tableListHasContent(sample.inputTables) && !sample.parsedInputs.length)) warnings.push("部分 input_tables 非空但无法解析，请提供诊断 JSON 中的样例格式。");
  if (mappedSamples.some((sample) => tableListHasContent(sample.outputTables) && !sample.parsedOutputs.length)) warnings.push("部分 output_tables 非空但无法解析，请提供诊断 JSON 中的样例格式。");
  return { dataDate, totalJobs, lineageReadyJobs, groups: mappedGroups, samples: mappedSamples, warnings };
}

function catalogFilter(field: string, projects: readonly string[] | null): string {
  if (projects === null) return "";
  if (!projects.length) return "1=0";
  return `${field} IN (${projects.map(quote).join(", ")})`;
}

function where(...conditions: string[]): string {
  const filtered = conditions.filter(Boolean);
  return filtered.length ? ` WHERE ${filtered.join(" AND ")}` : "";
}

function tableFromRows(row: MaxComputeRow, partition: MaxComputeRow | undefined, current: LineageTable | null, at: number): LineageTable {
  const project = field(row, "table_catalog");
  const name = field(row, "table_name");
  const id = tableId(project, name);
  return {
    id,
    project,
    name,
    type: row.table_type || "MANAGED_TABLE",
    comment: row.table_comment || "",
    ownerId: nullable(row.owner_id),
    ownerName: nullable(row.owner_name),
    isPartitioned: truth(row.is_partitioned),
    createTime: maxComputeTime(row.create_time),
    lastModifiedTime: maxComputeTime(partition?.last_modified_time || row.last_modified_time),
    lastAccessTime: maxComputeTime(partition?.last_access_time || row.last_access_time),
    dataLength: numberOrNull(partition?.data_length || row.data_length),
    partitionCount: integer(partition?.partition_count),
    lifecycle: numberOrNull(row.lifecycle),
    storageTier: nullable(row.storage_tier),
    clusterType: nullable(row.cluster_type),
    numberBuckets: numberOrNull(row.number_buckets),
    hasPrimaryKey: truth(row.has_primary_key),
    isTransactional: truth(row.is_transactional),
    isDeltaTable: truth(row.is_delta_table),
    tableStorage: nullable(row.table_storage),
    tableFormat: nullable(row.table_format),
    lastScheduleTime: current?.lastScheduleTime ?? null,
    lastScheduleStatus: current?.lastScheduleStatus ?? null,
    lastTaskName: current?.lastTaskName ?? null,
    lastInstanceId: current?.lastInstanceId ?? null,
    scheduleOwner: current?.scheduleOwner ?? null,
    scheduleNodeId: current?.scheduleNodeId ?? null,
    scheduleNodeName: current?.scheduleNodeName ?? null,
    scheduleOnDuty: current?.scheduleOnDuty ?? null,
    lastBizDate: current?.lastBizDate ?? null,
    accessCount: current?.accessCount ?? 0,
    accessBytes: current?.accessBytes ?? 0,
    createdAt: current?.createdAt ?? at,
    updatedAt: at,
  };
}

function columnFromRow(tableIdValue: string, row: MaxComputeRow, at: number): LineageColumn {
  return { tableId: tableIdValue, name: field(row, "column_name"), ordinalPosition: integer(row.ordinal_position), dataType: row.data_type || "STRING", comment: row.column_comment || "", nullable: truth(row.is_nullable), partitionKey: truth(row.is_partition_key), primaryKey: truth(row.is_primary_key), updatedAt: at };
}

export function parseTableList(value: string | undefined, defaultProject: string): string[] {
  const normalized = (value ?? "").trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!normalized) return [];
  const ids = normalized.split(/[,，]/).map((item) => item.trim().replaceAll("`", "").replace(/^['"]|['"]$/g, "").replace(/\([^)]*\)$/, "")).flatMap((item) => {
    const parts = item.split(".").filter(Boolean);
    if (parts.length === 1 && validTableIdentifier(parts[0]!)) return [tableId(defaultProject, parts[0]!)];
    if (parts.length === 2 && parts.every(validTableIdentifier)) return [tableId(parts[0]!, parts[1]!)];
    if (parts.length === 3 && parts[1]?.toLowerCase() === "default" && validTableIdentifier(parts[0]!) && validTableIdentifier(parts[2]!)) return [tableId(parts[0]!, parts[2]!)];
    return [];
  });
  return [...new Set(ids)];
}

function validTableIdentifier(value: string): boolean { return /^[A-Za-z0-9_$-]+$/.test(value); }

function tableListHasContent(value: string | undefined): boolean {
  return Boolean((value ?? "").replace(/[\[\]\s]/g, ""));
}

function tableId(project: string, name: string): string { return `${project.trim()}.${name.trim()}`; }
function field(row: MaxComputeRow, name: string): string { return row[name] ?? ""; }
function nullable(value: string | undefined): string | null { const text = value?.trim() ?? ""; return text && text.toUpperCase() !== "NULL" ? text : null; }
function integer(value: string | undefined): number { const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : 0; }
function numberOrNull(value: string | undefined): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function truth(value: string | undefined): boolean { return ["true", "1", "yes"].includes((value ?? "").toLowerCase()); }
function maxComputeTime(value: string | undefined): number | null {
  if (!value || value.toUpperCase() === "NULL") return null;
  const parsed = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}+08:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

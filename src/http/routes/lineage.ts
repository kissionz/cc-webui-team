import { canSeeTeam, isSystemAdmin, type JsonObject, type LineageEdge, type LineageTable, type MaxComputeConfig, type MaxComputeProject } from "../../domain/index.js";
import type { PersistenceRepository } from "../../persistence/index.js";
import type { ClaudeConfig } from "../../domain/index.js";
import type { ColumnLineageAnalyzer, ColumnSelectionNode } from "../../lineage/column-analyzer.js";
import { previousShanghaiDate, type LineageScheduler } from "../../lineage/scheduler.js";
import { diagnoseLineageSource } from "../../lineage/sync-service.js";
import type { MaxComputeCredentials } from "../../lineage/maxcompute-client.js";
import { PyOdpsClient, PyOdpsError, type PyOdpsDiagnostic } from "../../lineage/pyodps-client.js";
import { DataWorksColumnLineageClient, inferDataWorksRegion, splitMaxComputeTable, type DataWorksColumnGraph, type DataWorksColumnRelation } from "../../lineage/dataworks-lineage-client.js";
import type { SecretBox } from "../../security/secret-box.js";
import { HttpError, readJsonBody, sendJson } from "../core.js";
import { assertOnlyKeys, inputBoolean, inputEnum, inputInteger, inputString, inputStringList, objectBody, optionalQuery, queryInteger } from "../validation.js";
import type { RouteDefinition, RouteRequest } from "./shared.js";
import { routeId } from "./shared.js";

export interface LineageRoutesOptions {
  repository: PersistenceRepository;
  scheduler: LineageScheduler;
  analyzer: ColumnLineageAnalyzer;
  secretBox: SecretBox;
  maxBodySize: number;
  now: () => number;
  claudeConfig: () => ClaudeConfig | null;
  audit: (userId: string | null, action: string, targetType: string, targetId: string, metadata: JsonObject) => void;
}

export class LineageRoutes {
  readonly definitions: readonly RouteDefinition[];
  private readonly columnGraphCache = new Map<string, { expiresAt: number; graph: DataWorksColumnGraph }>();

  constructor(private readonly options: LineageRoutesOptions) {
    this.definitions = [
      { method: "GET", path: "/api/lineage/status", handle: (input) => this.status(input) },
      { method: "PATCH", path: "/api/lineage/config", handle: (input) => this.updateConfig(input) },
      { method: "POST", path: "/api/lineage/sync", handle: (input) => this.manualSync(input) },
      { method: "POST", path: "/api/lineage/reprocess", handle: (input) => this.reprocess(input) },
      { method: "POST", path: "/api/lineage/source-diagnostic", handle: (input) => this.sourceDiagnostic(input) },
      { method: "POST", path: "/api/lineage/connection-test", handle: (input) => this.testConnection(input) },
      { method: "GET", path: "/api/lineage/tables", handle: (input) => this.searchTables(input) },
      { method: "GET", path: /^\/api\/lineage\/tables\/([^/]+)$/, handle: (input) => this.tableDetail(input) },
      { method: "GET", path: "/api/lineage/graph", handle: (input) => this.graph(input) },
      { method: "POST", path: "/api/lineage/columns/graph", handle: (input) => this.columnGraph(input) },
      { method: "POST", path: "/api/lineage/columns/analyze-selection", handle: (input) => this.analyzeColumnSelection(input) },
      { method: "POST", path: "/api/lineage/columns/analyze", handle: (input) => this.analyzeColumn(input) },
    ];
  }

  private status({ response, auth }: RouteRequest): void {
    this.assertDirectoryAccess(auth.user);
    const config = this.options.repository.getMaxComputeConfig();
    sendJson(response, 200, {
      config: config ? configDto(config, isSystemAdmin(auth.user), this.options.secretBox) : null,
      running: this.options.scheduler.isRunning(),
      runs: this.options.repository.listLineageSyncRuns(8),
    });
  }

  private async updateConfig({ request, response, auth }: RouteRequest): Promise<void> {
    if (!isSystemAdmin(auth.user)) throw forbidden();
    const current = this.options.repository.getMaxComputeConfig();
    if (!current) throw new HttpError(500, "MAXCOMPUTE_CONFIG_MISSING", "MaxCompute 配置尚未初始化。");
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    assertOnlyKeys(body, ["enabled", "command", "args", "project", "collectionMode", "collectionProjects", "endpoint", "scheduleTime", "accessKeyId", "accessKeySecret", "clearCredentials"]);
    const scheduleTime = body.scheduleTime === undefined ? current.scheduleTime : inputString(body.scheduleTime, "scheduleTime", 5, 5);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) throw new HttpError(400, "INVALID_SCHEDULE_TIME", "调度时间必须使用 HH:mm 格式。");
    const project = body.project === undefined ? current.project : inputString(body.project, "project", 0, 128);
    if (project && !/^[A-Za-z0-9_.-]+$/.test(project)) throw new HttpError(400, "INVALID_PROJECT", "MaxCompute 项目名称格式不正确。");
    const collectionMode = body.collectionMode === undefined ? current.collectionMode : inputEnum(body.collectionMode, ["all", "selected"] as const, "collectionMode");
    const collectionProjects = body.collectionProjects === undefined ? current.collectionProjects : inputStringList(body.collectionProjects, "collectionProjects", 500);
    if (collectionProjects.some((item) => !/^[A-Za-z0-9_.-]+$/.test(item))) throw new HttpError(400, "INVALID_PROJECT", "采集项目名称格式不正确。");
    if (collectionMode === "selected" && !collectionProjects.length) throw new HttpError(400, "EMPTY_PROJECT_SELECTION", "指定项目模式下至少选择一个采集项目。");
    const endpoint = body.endpoint === undefined ? current.endpoint : validEndpoint(inputString(body.endpoint, "endpoint", 0, 512));
    const accessKeyId = body.accessKeyId === undefined ? "" : inputString(body.accessKeyId, "accessKeyId", 0, 256);
    const accessKeySecret = body.accessKeySecret === undefined ? "" : inputString(body.accessKeySecret, "accessKeySecret", 0, 512);
    const clearCredentials = body.clearCredentials === undefined ? false : inputBoolean(body.clearCredentials, "clearCredentials");
    if (Boolean(accessKeyId) !== Boolean(accessKeySecret)) throw new HttpError(400, "INCOMPLETE_CREDENTIAL", "AccessKey ID 和 AccessKey Secret 必须同时填写。");
    const credentialCiphertext = clearCredentials
      ? null
      : accessKeyId && accessKeySecret
        ? this.options.secretBox.encrypt({ accessKeyId, accessKeySecret } satisfies MaxComputeCredentials)
        : current.credentialCiphertext;
    const updated: MaxComputeConfig = {
      ...current,
      enabled: body.enabled === undefined ? current.enabled : inputBoolean(body.enabled, "enabled"),
      command: body.command === undefined ? current.command : inputString(body.command, "command", 1, 512),
      args: body.args === undefined ? current.args : inputString(body.args, "args", 0, 2_000),
      project,
      collectionMode,
      collectionProjects,
      endpoint,
      credentialCiphertext,
      credentialUpdatedAt: clearCredentials ? null : accessKeyId ? this.options.now() : current.credentialUpdatedAt,
      scheduleTime,
      updatedAt: this.options.now(),
    };
    this.options.repository.saveMaxComputeConfig(updated);
    this.options.scheduler.reschedule();
    const saved = this.options.repository.getMaxComputeConfig() ?? updated;
    this.options.audit(auth.user.id, "lineage.config.updated", "maxcompute_config", "singleton", { enabled: saved.enabled, project: saved.project, collectionMode: saved.collectionMode, collectionProjects: saved.collectionProjects, scheduleTime: saved.scheduleTime });
    sendJson(response, 200, { config: configDto(saved, true, this.options.secretBox) });
  }

  private async testConnection({ response, auth }: RouteRequest): Promise<void> {
    if (!isSystemAdmin(auth.user)) throw forbidden();
    const config = this.options.repository.getMaxComputeConfig();
    if (!config?.project || !config.endpoint || !config.credentialCiphertext) throw new HttpError(400, "MAXCOMPUTE_CONFIG_INCOMPLETE", "请先保存项目、Endpoint 和 AccessKey。");
    const credential = this.options.secretBox.decrypt<MaxComputeCredentials>(config.credentialCiphertext);
    const startedAt = this.options.now();
    let diagnostic: PyOdpsDiagnostic | null = null;
    let projects: MaxComputeProject[] = [];
    try {
      const client = new PyOdpsClient({
        command: config.command, args: config.args, project: config.project, endpoint: config.endpoint,
        credentials: credential, timeoutMs: 90_000, onDiagnostic: (value) => { diagnostic = value; },
      });
      const rows = await client.query("SELECT catalog_name, status, region FROM SYSTEM_CATALOG.INFORMATION_SCHEMA.catalogs ORDER BY catalog_name", ["catalog_name", "status", "region"]);
      projects = rows.map((row) => ({ name: row.catalog_name ?? "", status: row.status ?? "", region: row.region ?? "" })).filter((item) => item.name);
    } catch (error) {
      this.options.audit(auth.user.id, "lineage.connection_tested", "maxcompute_config", "singleton", { project: config.project, endpoint: config.endpoint, success: false });
      if (error instanceof PyOdpsError) {
        const setupError = error.kind === "python_not_found" || error.kind === "pyodps_not_installed";
        throw new HttpError(
          setupError ? 400 : 502,
          error.kind === "python_not_found" ? "PYTHON_NOT_FOUND" : error.kind === "pyodps_not_installed" ? "PYODPS_NOT_INSTALLED" : "MAXCOMPUTE_CONNECTION_FAILED",
          error.message,
          { diagnostic: connectionDiagnostic(error.diagnostic ?? diagnostic, [], credential) },
        );
      }
      throw error;
    }
    const latest = this.options.repository.getMaxComputeConfig() ?? config;
    this.options.repository.saveMaxComputeConfig({ ...latest, discoveredProjects: projects, updatedAt: this.options.now() });
    this.options.audit(auth.user.id, "lineage.connection_tested", "maxcompute_config", "singleton", { project: config.project, endpoint: config.endpoint, success: true });
    sendJson(response, 200, {
      connected: true,
      latencyMs: this.options.now() - startedAt,
      checkedAt: this.options.now(),
      projects,
      diagnostic: connectionDiagnostic(diagnostic, projects.slice(0, 20), credential),
    });
  }

  private manualSync({ response, auth }: RouteRequest): void {
    if (!isSystemAdmin(auth.user)) throw forbidden();
    if (this.options.scheduler.isRunning()) throw new HttpError(409, "LINEAGE_SYNC_RUNNING", "血缘同步正在执行中。");
    void this.options.scheduler.run("manual", auth.user.id).catch(() => undefined);
    this.options.audit(auth.user.id, "lineage.sync.triggered", "lineage_sync", "manual", {});
    sendJson(response, 202, { accepted: true });
  }

  private reprocess({ response, auth }: RouteRequest): void {
    if (!isSystemAdmin(auth.user)) throw forbidden();
    if (this.options.scheduler.isRunning()) throw new HttpError(409, "LINEAGE_SYNC_RUNNING", "血缘同步正在执行中。");
    const config = this.options.repository.getMaxComputeConfig();
    if (!config?.project || !config.endpoint || !config.credentialCiphertext) throw new HttpError(400, "MAXCOMPUTE_CONFIG_INCOMPLETE", "请先保存并验证 MaxCompute 数据源。");
    const dataDate = previousShanghaiDate(this.options.now());
    const requeued = this.options.repository.transaction(() => this.options.repository.requeueLineageTasks());
    void this.options.scheduler.run("manual", auth.user.id).catch(() => undefined);
    this.options.audit(auth.user.id, "lineage.sync.reprocessed", "lineage_sync", dataDate, { requeued });
    sendJson(response, 202, { accepted: true, dataDate, requeued });
  }

  private async sourceDiagnostic({ response, auth }: RouteRequest): Promise<void> {
    if (!isSystemAdmin(auth.user)) throw forbidden();
    const config = this.options.repository.getMaxComputeConfig();
    if (!config?.project || !config.endpoint || !config.credentialCiphertext) throw new HttpError(400, "MAXCOMPUTE_CONFIG_INCOMPLETE", "请先保存项目、Endpoint 和 AccessKey。");
    const credential = this.options.secretBox.decrypt<MaxComputeCredentials>(config.credentialCiphertext);
    const dataDate = previousShanghaiDate(this.options.now());
    try {
      const client = new PyOdpsClient({
        command: config.command, args: config.args, project: config.project, endpoint: config.endpoint,
        credentials: credential, timeoutMs: 120_000,
      });
      const diagnostic = await diagnoseLineageSource(client, config.collectionMode === "all" ? null : config.collectionProjects, dataDate);
      const storage = this.options.repository.lineageStorageStats(dataDate);
      const displayCapSignature = storage.processedJobs > 0 && storage.processedJobs % 10_000 === 0;
      const warnings = [...diagnostic.warnings];
      if (displayCapSignature) warnings.push(`系统库恰好有 ${storage.processedJobs} 个已处理标记，符合旧版命令行同步被 10000 行上限截断的特征，建议重新解析已落库任务。`);
      const recoveryRecommended = diagnostic.lineageReadyJobs > 0 && (storage.stagedJobs > 0 || storage.processedJobs > 0)
        && (storage.totalEdges === 0 || storage.invalidJobs > 0 || warnings.length > 0 || displayCapSignature);
      this.options.audit(auth.user.id, "lineage.source.diagnosed", "lineage_sync", dataDate, {
        totalJobs: diagnostic.totalJobs,
        lineageReadyJobs: diagnostic.lineageReadyJobs,
        stagedJobs: storage.stagedJobs,
        invalidJobs: storage.invalidJobs,
        observations: storage.observations,
        processedJobs: storage.processedJobs,
        totalEdges: storage.totalEdges,
        recoveryRecommended,
      });
      sendJson(response, 200, { diagnostic: { ...diagnostic, warnings, storage, recoveryRecommended } });
    } catch (error) {
      if (error instanceof PyOdpsError) {
        const status = ["python_not_found", "pyodps_not_installed"].includes(error.kind) ? 400 : 502;
        throw new HttpError(status, "LINEAGE_SOURCE_DIAGNOSTIC_FAILED", error.message);
      }
      throw error;
    }
  }

  private searchTables({ response, url, auth }: RouteRequest): void {
    this.assertDirectoryAccess(auth.user);
    const query = optionalQuery(url, "q", 256) ?? "";
    const tables = query ? this.options.repository.searchLineageTables(query, queryInteger(url, "limit", 20, 1, 100)) : [];
    sendJson(response, 200, { tables });
  }

  private assertDirectoryAccess(user: RouteRequest["auth"]["user"]): void {
    if (!this.options.repository.canAccessDirectory(user.role, "lineage")) throw forbidden();
  }

  private tableDetail({ response, match, auth }: RouteRequest): void {
    this.assertDirectoryAccess(auth.user);
    const id = routeId(match, 1);
    const table = this.options.repository.getLineageTable(id);
    if (!table) throw new HttpError(404, "LINEAGE_TABLE_NOT_FOUND", "未找到该表的血缘元数据。");
    sendJson(response, 200, { table, columns: this.options.repository.listLineageColumns(id), relations: this.options.repository.countLineageRelations(id) });
  }

  private graph({ response, url, auth }: RouteRequest): void {
    this.assertDirectoryAccess(auth.user);
    const scope = inputEnum(url.searchParams.get("scope") ?? "first", ["first", "deep", "terminal", "path"] as const, "scope");
    const direction = inputEnum(url.searchParams.get("direction") ?? "both", ["up", "down", "both"] as const, "direction");
    const depth = scope === "first" ? 1 : queryInteger(url, "depth", 6, 1, 12);
    const limit = queryInteger(url, "limit", 120, 10, 500);
    let rootId = inputString(url.searchParams.get("table"), "table", 3, 260);
    let edges: Array<LineageEdge & { depth?: number; collapsed?: number }>;
    if (scope === "path") {
      const targetId = inputString(url.searchParams.get("target"), "target", 3, 260);
      edges = this.options.repository.findLineagePath(rootId, targetId, depth);
    } else {
      if (scope === "terminal" && direction === "both") {
        edges = [
          ...terminalEdges(rootId, this.options.repository.listLineageEdges(rootId, "up", depth, limit), "up"),
          ...terminalEdges(rootId, this.options.repository.listLineageEdges(rootId, "down", depth, limit), "down"),
        ];
      } else {
        const traversed = this.options.repository.listLineageEdges(rootId, direction, depth, limit);
        edges = scope === "terminal" ? terminalEdges(rootId, traversed, direction as "up" | "down") : traversed;
      }
    }
    const ids = new Set([rootId]);
    edges.forEach((edge) => { ids.add(edge.sourceTableId); ids.add(edge.targetTableId); });
    const tables = [...ids].map((id) => this.options.repository.getLineageTable(id) ?? tableStub(id));
    sendJson(response, 200, { rootId, scope, direction, tables, edges, truncated: edges.length >= limit });
  }

  private async analyzeColumn({ request, response, auth }: RouteRequest): Promise<void> {
    this.assertDirectoryAccess(auth.user);
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    assertOnlyKeys(body, ["teamId", "table", "column"]);
    const teamId = inputString(body.teamId, "teamId", 1, 128);
    const team = this.options.repository.getTeam(teamId);
    if (!team || !canSeeTeam(this.options.repository, auth.user, teamId)) throw forbidden();
    const table = inputString(body.table, "table", 1, 260);
    const column = inputString(body.column, "column", 1, 260);
    if (!/^[A-Za-z0-9_.-]+$/.test(table) || !/^[A-Za-z0-9_$-]+$/.test(column)) throw new HttpError(400, "INVALID_LINEAGE_IDENTIFIER", "表名或字段名格式不正确。");
    const config = this.options.claudeConfig();
    if (!config?.enabled || !config.available || !config.authenticated) throw new HttpError(503, "CLAUDE_UNAVAILABLE", "Claude Code 当前不可用或未登录。");
    try {
      const platform = await this.dataWorksColumnRelations(table, column);
      const result = await this.options.analyzer.analyze({
        cwd: team.workspacePath,
        table,
        column,
        config,
        platformRelations: platform.relations,
        platformWarnings: platform.warnings,
      });
      this.options.audit(auth.user.id, "lineage.column.analyzed", "lineage_column", `${table}.${column}`, {
        teamId,
        status: result.status,
        relations: result.relations.length,
        dataWorksRelations: platform.relations.length,
      });
      sendJson(response, 200, { result });
    } catch (error) {
      if (error instanceof Error && error.message.includes("任务已满")) throw new HttpError(429, "COLUMN_LINEAGE_BUSY", error.message);
      throw error;
    }
  }

  private async columnGraph({ request, response, auth }: RouteRequest): Promise<void> {
    this.assertDirectoryAccess(auth.user);
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    assertOnlyKeys(body, ["table", "column", "depth", "direction"]);
    const table = inputString(body.table, "table", 1, 260);
    const column = inputString(body.column, "column", 1, 260);
    const depth = body.depth === undefined ? 3 : inputInteger(body.depth, "depth", 1, 5);
    const direction = body.direction === undefined ? "both" : inputEnum(body.direction, ["up", "down", "both"] as const, "direction");
    validateColumnReference(table, column);
    const source = this.options.repository.getMaxComputeConfig();
    if (!source?.credentialCiphertext) throw new HttpError(400, "MAXCOMPUTE_CREDENTIAL_MISSING", "请先在系统设置的数据同步中配置 MaxCompute AccessKey。");
    const reference = splitMaxComputeTable(table, source.project);
    if (!reference) throw new HttpError(400, "INVALID_LINEAGE_IDENTIFIER", "无法确定字段所属的 MaxCompute 项目。");
    const region = inferDataWorksRegion(source, reference.project);
    if (!region) throw new HttpError(400, "DATAWORKS_REGION_UNKNOWN", "无法识别该项目所在的 DataWorks 地域。");
    const cacheKey = [source.updatedAt, region, reference.project, reference.table, column.toLocaleLowerCase(), depth, direction].join("\u0000");
    const cached = this.columnGraphCache.get(cacheKey);
    if (cached && cached.expiresAt > this.options.now()) return sendJson(response, 200, { graph: cached.graph, cached: true });
    const credentials = this.options.secretBox.decrypt<MaxComputeCredentials>(source.credentialCiphertext);
    try {
      const client = new DataWorksColumnLineageClient({ credentials, region });
      const graph = await client.queryColumnGraph({ ...reference, column, depth, direction, maximumNodes: 180 });
      this.columnGraphCache.set(cacheKey, { expiresAt: this.options.now() + 10 * 60 * 1_000, graph });
      while (this.columnGraphCache.size > 100) this.columnGraphCache.delete(this.columnGraphCache.keys().next().value!);
      this.options.audit(auth.user.id, "lineage.column.graph.viewed", "lineage_column", `${table}.${column}`, { depth, direction, nodes: graph.nodes.length, edges: graph.edges.length });
      sendJson(response, 200, { graph, cached: false });
    } catch (error) {
      throw new HttpError(502, "DATAWORKS_COLUMN_LINEAGE_FAILED", `DataWorks 字段血缘查询失败：${safeDataWorksError(error, credentials)}`);
    }
  }

  private async analyzeColumnSelection({ request, response, auth }: RouteRequest): Promise<void> {
    this.assertDirectoryAccess(auth.user);
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    assertOnlyKeys(body, ["teamId", "nodes", "relations"]);
    const teamId = inputString(body.teamId, "teamId", 1, 128);
    const team = this.options.repository.getTeam(teamId);
    if (!team || !canSeeTeam(this.options.repository, auth.user, teamId)) throw forbidden();
    if (!Array.isArray(body.nodes) || body.nodes.length < 1 || body.nodes.length > 20) throw new HttpError(400, "INVALID_COLUMN_SELECTION", "请选择 1 到 20 个字段进行分析。");
    if (!Array.isArray(body.relations) || body.relations.length > 200) throw new HttpError(400, "INVALID_COLUMN_RELATIONS", "字段关系数量不能超过 200 条。");
    const nodes: ColumnSelectionNode[] = body.nodes.map((raw, index) => {
      const item = objectBody(raw); assertOnlyKeys(item, ["id", "table", "column"]);
      const node = { id: inputString(item.id, `nodes[${index}].id`, 1, 512), table: inputString(item.table, `nodes[${index}].table`, 1, 260), column: inputString(item.column, `nodes[${index}].column`, 1, 260) };
      validateColumnReference(node.table, node.column); return node;
    });
    const relations: DataWorksColumnRelation[] = body.relations.map((raw, index) => {
      const item = objectBody(raw); assertOnlyKeys(item, ["sourceId", "sourceTable", "sourceColumn", "targetId", "targetTable", "targetColumn", "taskId", "taskType", "createTime"]);
      const relation: DataWorksColumnRelation = {
        sourceId: inputString(item.sourceId, `relations[${index}].sourceId`, 1, 512),
        sourceTable: inputString(item.sourceTable, `relations[${index}].sourceTable`, 1, 260),
        sourceColumn: inputString(item.sourceColumn, `relations[${index}].sourceColumn`, 1, 260),
        targetId: inputString(item.targetId, `relations[${index}].targetId`, 1, 512),
        targetTable: inputString(item.targetTable, `relations[${index}].targetTable`, 1, 260),
        targetColumn: inputString(item.targetColumn, `relations[${index}].targetColumn`, 1, 260),
        taskId: item.taskId === null ? null : inputString(item.taskId, `relations[${index}].taskId`, 0, 512),
        taskType: item.taskType === null ? null : inputString(item.taskType, `relations[${index}].taskType`, 0, 256),
        createTime: item.createTime === null ? null : inputInteger(item.createTime, `relations[${index}].createTime`, 0, Number.MAX_SAFE_INTEGER),
      };
      validateColumnReference(relation.sourceTable, relation.sourceColumn);
      validateColumnReference(relation.targetTable, relation.targetColumn);
      return relation;
    });
    const config = this.options.claudeConfig();
    if (!config?.enabled || !config.available || !config.authenticated) throw new HttpError(503, "CLAUDE_UNAVAILABLE", "Claude Code 当前不可用或未登录。");
    try {
      const result = await this.options.analyzer.analyzeSelection({ cwd: team.workspacePath, nodes, relations, config });
      this.options.audit(auth.user.id, "lineage.column.selection_analyzed", "lineage_column", nodes.map((node) => `${node.table}.${node.column}`).join(","), { teamId, nodes: nodes.length, relations: relations.length, groups: result.groups.length, status: result.status });
      sendJson(response, 200, { result });
    } catch (error) {
      if (error instanceof Error && error.message.includes("任务已满")) throw new HttpError(429, "COLUMN_LINEAGE_BUSY", error.message);
      throw error;
    }
  }

  private async dataWorksColumnRelations(table: string, column: string): Promise<{ relations: DataWorksColumnRelation[]; warnings: string[] }> {
    const source = this.options.repository.getMaxComputeConfig();
    if (!source?.credentialCiphertext) return { relations: [], warnings: ["未配置 MaxCompute AccessKey，字段血缘已使用 Claude Code 本地分析。"] };
    const reference = splitMaxComputeTable(table, source.project);
    if (!reference) return { relations: [], warnings: ["无法从表名确定 MaxCompute 项目，字段血缘已使用 Claude Code 本地分析。"] };
    const region = inferDataWorksRegion(source, reference.project);
    if (!region) return { relations: [], warnings: ["无法识别 DataWorks 地域，字段血缘已使用 Claude Code 本地分析。"] };
    let credentials: MaxComputeCredentials;
    try {
      credentials = this.options.secretBox.decrypt<MaxComputeCredentials>(source.credentialCiphertext);
    } catch {
      return { relations: [], warnings: ["MaxCompute AccessKey 无法解密，字段血缘已使用 Claude Code 本地分析。"] };
    }
    try {
      const client = new DataWorksColumnLineageClient({ credentials, region });
      const relations = await client.queryColumn({ project: reference.project, table: reference.table, column });
      return {
        relations,
        warnings: relations.length ? [] : ["DataWorks 未返回该字段的上下游关系，已继续使用 Claude Code 搜索工作空间。"],
      };
    } catch (error) {
      return {
        relations: [],
        warnings: [`DataWorks 字段血缘查询失败，已回退到 Claude Code：${safeDataWorksError(error, credentials)}`],
      };
    }
  }
}

function terminalEdges(rootId: string, edges: Array<LineageEdge & { depth: number }>, direction: "up" | "down"): Array<LineageEdge & { collapsed?: number }> {
  const outgoing = new Set(edges.map((edge) => direction === "down" ? edge.sourceTableId : edge.targetTableId));
  const terminals = new Set(edges.map((edge) => direction === "down" ? edge.targetTableId : edge.sourceTableId).filter((id) => !outgoing.has(id)));
  return [...terminals].map((terminal) => {
    const candidates = edges.filter((edge) => direction === "down" ? edge.targetTableId === terminal : edge.sourceTableId === terminal);
    const latest = candidates.sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]!;
    return { ...latest, sourceTableId: direction === "down" ? rootId : terminal, targetTableId: direction === "down" ? terminal : rootId, collapsed: Math.max(0, (latest.depth ?? 1) - 1) };
  });
}

function validateColumnReference(table: string, column: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(table) || !/^[A-Za-z0-9_$-]+$/.test(column)) throw new HttpError(400, "INVALID_LINEAGE_IDENTIFIER", "表名或字段名格式不正确。");
}

function configDto(config: MaxComputeConfig, admin: boolean, secretBox: SecretBox): Record<string, unknown> {
  let accessKeyIdMasked: string | null = null;
  if (admin && config.credentialCiphertext) {
    try {
      const credential = secretBox.decrypt<MaxComputeCredentials>(config.credentialCiphertext);
      accessKeyIdMasked = maskAccessKey(credential.accessKeyId);
    } catch { accessKeyIdMasked = "凭据无法解密"; }
  }
  const { credentialCiphertext: _secret, ...safe } = config;
  return { ...safe, credentialConfigured: Boolean(config.credentialCiphertext), accessKeyIdMasked, ...(admin ? {} : { command: undefined, args: undefined, endpoint: undefined, credentialUpdatedAt: undefined }) };
}

function maskAccessKey(value: string): string { return value.length <= 8 ? `${value.slice(0, 2)}••••` : `${value.slice(0, 4)}••••${value.slice(-4)}`; }
function safeDataWorksError(error: unknown, credentials: MaxComputeCredentials): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replaceAll(credentials.accessKeyId, "[REDACTED]").replaceAll(credentials.accessKeySecret, "[REDACTED]").slice(0, 500);
}
function connectionDiagnostic(diagnostic: Partial<PyOdpsDiagnostic> | null, parsed: MaxComputeProject[], credential: MaxComputeCredentials): Record<string, unknown> {
  const summary = diagnostic
    ? [
      diagnostic.pythonVersion ? `Python ${diagnostic.pythonVersion}` : "Python 3",
      diagnostic.sdkVersion ? `PyODPS ${diagnostic.sdkVersion}` : "PyODPS",
      `${diagnostic.rows ?? parsed.length} 行`,
      diagnostic.instanceId ? `Instance ${diagnostic.instanceId}` : "",
    ].filter(Boolean).join(" · ")
    : "PyODPS 未返回运行信息";
  return { stdout: summary, stderr: diagnosticPreview(diagnostic?.stderr ?? "", credential), parsed };
}
function diagnosticPreview(value: string, credential: MaxComputeCredentials): string {
  return value
    .replaceAll(credential.accessKeySecret, "[REDACTED]")
    .replaceAll(credential.accessKeyId, maskAccessKey(credential.accessKeyId))
    .replaceAll(/access_key\s*=\s*\S+/gi, "access_key=[REDACTED]")
    .trim()
    .slice(-4_000);
}
function validEndpoint(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return value.replace(/\/$/, "");
  } catch { throw new HttpError(400, "INVALID_ENDPOINT", "Endpoint 必须是有效的 HTTP 或 HTTPS 地址。"); }
}

function tableStub(id: string): LineageTable {
  const separator = id.indexOf(".");
  return { id, project: separator > 0 ? id.slice(0, separator) : "", name: separator > 0 ? id.slice(separator + 1) : id, type: "MANAGED_TABLE", comment: "", ownerId: null, ownerName: null, isPartitioned: false, createTime: null, lastModifiedTime: null, lastAccessTime: null, dataLength: null, partitionCount: 0, lifecycle: null, storageTier: null, clusterType: null, numberBuckets: null, hasPrimaryKey: false, isTransactional: false, isDeltaTable: false, tableStorage: null, tableFormat: null, lastScheduleTime: null, lastScheduleStatus: null, lastTaskName: null, lastInstanceId: null, scheduleOwner: null, scheduleNodeId: null, scheduleNodeName: null, scheduleOnDuty: null, lastBizDate: null, accessCount: 0, accessBytes: 0, createdAt: 0, updatedAt: 0 };
}

function forbidden(): HttpError { return new HttpError(403, "FORBIDDEN", "无权执行此操作。"); }

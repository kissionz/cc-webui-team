import { canSeeTeam, isSystemAdmin, type JsonObject, type LineageEdge, type LineageTable, type MaxComputeConfig } from "../../domain/index.js";
import type { PersistenceRepository } from "../../persistence/index.js";
import type { ClaudeConfig } from "../../domain/index.js";
import type { ColumnLineageAnalyzer } from "../../lineage/column-analyzer.js";
import type { LineageScheduler } from "../../lineage/scheduler.js";
import { OdpsCommandClient, withTemporaryOdpsConfig, type MaxComputeCredentials } from "../../lineage/maxcompute-client.js";
import type { SecretBox } from "../../security/secret-box.js";
import { HttpError, readJsonBody, sendJson } from "../core.js";
import { assertOnlyKeys, inputBoolean, inputEnum, inputInteger, inputString, objectBody, optionalQuery, queryInteger } from "../validation.js";
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

  constructor(private readonly options: LineageRoutesOptions) {
    this.definitions = [
      { method: "GET", path: "/api/lineage/status", handle: (input) => this.status(input) },
      { method: "PATCH", path: "/api/lineage/config", handle: (input) => this.updateConfig(input) },
      { method: "POST", path: "/api/lineage/sync", handle: (input) => this.manualSync(input) },
      { method: "POST", path: "/api/lineage/connection-test", handle: (input) => this.testConnection(input) },
      { method: "GET", path: "/api/lineage/tables", handle: (input) => this.searchTables(input) },
      { method: "GET", path: /^\/api\/lineage\/tables\/([^/]+)$/, handle: (input) => this.tableDetail(input) },
      { method: "GET", path: "/api/lineage/graph", handle: (input) => this.graph(input) },
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
    assertOnlyKeys(body, ["enabled", "command", "args", "project", "endpoint", "scheduleTime", "accessKeyId", "accessKeySecret", "clearCredentials"]);
    const scheduleTime = body.scheduleTime === undefined ? current.scheduleTime : inputString(body.scheduleTime, "scheduleTime", 5, 5);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) throw new HttpError(400, "INVALID_SCHEDULE_TIME", "调度时间必须使用 HH:mm 格式。");
    const project = body.project === undefined ? current.project : inputString(body.project, "project", 0, 128);
    if (project && !/^[A-Za-z0-9_.-]+$/.test(project)) throw new HttpError(400, "INVALID_PROJECT", "MaxCompute 项目名称格式不正确。");
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
      endpoint,
      credentialCiphertext,
      credentialUpdatedAt: clearCredentials ? null : accessKeyId ? this.options.now() : current.credentialUpdatedAt,
      scheduleTime,
      updatedAt: this.options.now(),
    };
    this.options.repository.saveMaxComputeConfig(updated);
    this.options.scheduler.reschedule();
    const saved = this.options.repository.getMaxComputeConfig() ?? updated;
    this.options.audit(auth.user.id, "lineage.config.updated", "maxcompute_config", "singleton", { enabled: saved.enabled, project: saved.project, scheduleTime: saved.scheduleTime });
    sendJson(response, 200, { config: configDto(saved, true, this.options.secretBox) });
  }

  private async testConnection({ response, auth }: RouteRequest): Promise<void> {
    if (!isSystemAdmin(auth.user)) throw forbidden();
    const config = this.options.repository.getMaxComputeConfig();
    if (!config?.project || !config.endpoint || !config.credentialCiphertext) throw new HttpError(400, "MAXCOMPUTE_CONFIG_INCOMPLETE", "请先保存项目、Endpoint 和 AccessKey。");
    const credential = this.options.secretBox.decrypt<MaxComputeCredentials>(config.credentialCiphertext);
    const startedAt = this.options.now();
    await withTemporaryOdpsConfig({ ...credential, endpoint: config.endpoint, project: config.project }, async (configPath) => {
      const client = new OdpsCommandClient({ command: config.command, args: config.args, project: config.project, configPath, timeoutMs: 90_000 });
      await client.query(`SELECT table_catalog FROM SYSTEM_CATALOG.INFORMATION_SCHEMA.tables WHERE table_catalog='${config.project.replaceAll("'", "''")}' LIMIT 1`, ["table_catalog"]);
    });
    this.options.audit(auth.user.id, "lineage.connection_tested", "maxcompute_config", "singleton", { project: config.project, endpoint: config.endpoint, success: true });
    sendJson(response, 200, { connected: true, latencyMs: this.options.now() - startedAt, checkedAt: this.options.now() });
  }

  private manualSync({ response, auth }: RouteRequest): void {
    if (!isSystemAdmin(auth.user)) throw forbidden();
    if (this.options.scheduler.isRunning()) throw new HttpError(409, "LINEAGE_SYNC_RUNNING", "血缘同步正在执行中。");
    void this.options.scheduler.run("manual", auth.user.id).catch(() => undefined);
    this.options.audit(auth.user.id, "lineage.sync.triggered", "lineage_sync", "manual", {});
    sendJson(response, 202, { accepted: true });
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
      const result = await this.options.analyzer.analyze({ cwd: team.workspacePath, table, column, config });
      this.options.audit(auth.user.id, "lineage.column.analyzed", "lineage_column", `${table}.${column}`, { teamId, status: result.status, relations: result.relations.length });
      sendJson(response, 200, { result });
    } catch (error) {
      if (error instanceof Error && error.message.includes("任务已满")) throw new HttpError(429, "COLUMN_LINEAGE_BUSY", error.message);
      throw error;
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

import { stat } from "node:fs/promises";
import type { AppConfig } from "../../config.js";
import { createId, isSystemAdmin, type AuditLog, type ConversationSession, type JsonObject, type TeamConfigTemplate, type User } from "../../domain/index.js";
import type { PersistenceRepository } from "../../persistence/index.js";
import type { RealtimeEvent, SseHub } from "../../events/sse.js";
import { HttpError, readJsonBody, sendDownload, sendJson } from "../core.js";
import { assertOnlyKeys, inputBoolean, inputEnum, inputInteger, inputNumber, inputString, inputStringList, objectBody, optionalQuery, queryInteger } from "../validation.js";
import type { RouteDefinition, RouteRequest } from "./shared.js";
import { routeId } from "./shared.js";

export interface MetricsSnapshotSource {
  metricsSnapshot(): Record<string, unknown>;
}

export interface AdminRoutesOptions {
  repository: PersistenceRepository;
  config: AppConfig;
  events: SseHub;
  runtime: MetricsSnapshotSource;
  maxBodySize: number;
  now: () => number;
  toSessionDto: (session: ConversationSession) => Record<string, unknown>;
  adminAudience: () => string[];
  sessionAudience: (session: ConversationSession) => string[];
  teamAudience: (teamId: string) => string[];
  audit: (userId: string | null, action: string, targetType: string, targetId: string, metadata: JsonObject) => void;
  backup?: MetricsSnapshotSource;
}

export class AdminRoutes {
  readonly definitions: readonly RouteDefinition[];

  constructor(private readonly options: AdminRoutesOptions) {
    this.definitions = [
      { method: "GET", path: "/api/audit-logs", handle: (input) => this.listAuditLogs(input) },
      { method: "GET", path: "/api/audit-logs/export", handle: (input) => this.exportAuditLogs(input) },
      { method: "POST", path: "/api/admin/sessions/archive-batch", handle: (input) => this.archiveSessions(input) },
      { method: "GET", path: "/api/admin/team-templates", handle: (input) => this.listTemplates(input) },
      { method: "POST", path: "/api/admin/team-templates", handle: (input) => this.saveTemplate(input) },
      { method: "DELETE", path: /^\/api\/admin\/team-templates\/([^/]+)$/, handle: (input) => this.deleteTemplate(input) },
      { method: "POST", path: /^\/api\/admin\/team-templates\/([^/]+)\/apply$/, handle: (input) => this.applyTemplate(input) },
      { method: "GET", path: "/api/admin/metrics", handle: (input) => this.metrics(input) },
    ];
  }

  private assertAdmin(user: User): void {
    if (!isSystemAdmin(user)) throw new HttpError(403, "FORBIDDEN", "仅系统管理员可以执行此操作。");
  }

  private listAuditLogs({ response, url, auth }: RouteRequest): void {
    this.assertAdmin(auth.user);
    const page = this.options.repository.listAuditLogs({
      limit: queryInteger(url, "limit", 100, 1, 200),
      cursor: optionalQuery(url, "cursor", 1_024) ?? null,
      ...auditFilters(url),
    });
    sendJson(response, 200, { auditLogs: page.items, nextCursor: page.nextCursor });
  }

  private exportAuditLogs({ response, url, auth }: RouteRequest): void {
    this.assertAdmin(auth.user);
    const format = inputEnum(url.searchParams.get("format") ?? "json", ["json", "csv"] as const, "format");
    const logs = collectAuditLogs(this.options.repository, auditFilters(url), 10_001);
    if (logs.length > 10_000) {
      throw new HttpError(413, "EXPORT_TOO_LARGE", "导出结果超过 10000 条，请先缩小筛选范围。");
    }
    this.options.audit(auth.user.id, "audit.exported", "audit_log", "filtered", { format, count: logs.length });
    const stamp = new Date(this.options.now()).toISOString().slice(0, 10);
    if (format === "csv") {
      const header = ["id", "createdAt", "userId", "action", "targetType", "targetId", "metadata"];
      const rows = logs.map((log) => [log.id, log.createdAt, log.userId ?? "", log.action, log.targetType, log.targetId, JSON.stringify(log.metadata)]);
      sendDownload(response, `audit-logs-${stamp}.csv`, `\uFEFF${[header, ...rows].map(csvRow).join("\r\n")}`, "text/csv; charset=utf-8");
      return;
    }
    sendDownload(response, `audit-logs-${stamp}.json`, JSON.stringify({ exportedAt: this.options.now(), filters: auditFilters(url), auditLogs: logs }, null, 2), "application/json; charset=utf-8");
  }

  private async archiveSessions({ request, response, auth }: RouteRequest): Promise<void> {
    this.assertAdmin(auth.user);
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    assertOnlyKeys(body, ["sessionIds", "archived"]);
    const sessionIds = inputStringList(body.sessionIds, "sessionIds", 500);
    const archived = inputBoolean(body.archived, "archived");
    if (!sessionIds.length) throw new HttpError(400, "INVALID_INPUT", "sessionIds 不能为空。");
    const sessions: Record<string, unknown>[] = [];
    const skipped: Array<{ id: string; code: string; message: string }> = [];
    const changed: ConversationSession[] = [];
    const updatedAt = this.options.now();
    this.options.repository.transaction(() => {
      for (const id of sessionIds) {
        const session = this.options.repository.getSession(id);
        if (!session) {
          skipped.push({ id, code: "SESSION_NOT_FOUND", message: "会话不存在。" });
          continue;
        }
        if (["queued", "running", "compacting", "waiting_permission"].includes(session.status)) {
          skipped.push({ id, code: "SESSION_ACTIVE", message: "运行中的会话不能批量归档或恢复。" });
          continue;
        }
        const isArchived = session.archivedAt !== null;
        if (isArchived === archived) {
          skipped.push({ id, code: "NO_CHANGE", message: archived ? "会话已经归档。" : "会话未归档。" });
          continue;
        }
        const updated = { ...session, archivedAt: archived ? updatedAt : null, updatedAt };
        this.options.repository.saveSession(updated);
        changed.push(updated);
        sessions.push(this.options.toSessionDto(updated));
      }
      this.options.audit(auth.user.id, archived ? "session.batch_archived" : "session.batch_unarchived", "session_batch", createId("batch"), {
        requested: sessionIds.length,
        updated: changed.length,
        skipped: skipped.length,
      });
    });
    for (const session of changed) {
      this.options.events.publish({ type: "session.updated", sessionId: session.id, teamId: session.teamId, session: this.options.toSessionDto(session) } as RealtimeEvent, this.options.sessionAudience(session));
    }
    sendJson(response, 200, { sessions, updatedCount: changed.length, skipped });
  }

  private listTemplates({ response, auth }: RouteRequest): void {
    this.assertAdmin(auth.user);
    sendJson(response, 200, { templates: this.options.repository.listTeamConfigTemplates() });
  }

  private async saveTemplate({ request, response, auth }: RouteRequest): Promise<void> {
    this.assertAdmin(auth.user);
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    assertOnlyKeys(body, ["id", "name", "description", "workspaceMode", "modelContextTokens", "autoCompactRatio", "autoCompactEnabled", "mcpToolAllowlist"]);
    const id = body.id === undefined ? createId("template") : inputString(body.id, "id", 1, 128);
    const existing = this.options.repository.getTeamConfigTemplate(id);
    const createdAt = existing?.createdAt ?? this.options.now();
    const template: TeamConfigTemplate = {
      id,
      name: inputString(body.name, "name", 2, 80),
      description: body.description === undefined ? "" : inputString(body.description, "description", 0, 500),
      workspaceMode: inputEnum(body.workspaceMode, ["shared", "isolated"] as const, "workspaceMode"),
      modelContextTokens: inputInteger(body.modelContextTokens, "modelContextTokens", 1_000, 10_000_000),
      autoCompactRatio: inputNumber(body.autoCompactRatio, "autoCompactRatio", 0.1, 0.9),
      autoCompactEnabled: inputBoolean(body.autoCompactEnabled, "autoCompactEnabled"),
      mcpToolAllowlist: inputStringList(body.mcpToolAllowlist, "mcpToolAllowlist", 500),
      createdBy: existing?.createdBy ?? auth.user.id,
      createdAt,
      updatedAt: this.options.now(),
    };
    try {
      this.options.repository.saveTeamConfigTemplate(template);
    } catch (error) {
      if (error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT")) {
        throw new HttpError(409, "TEMPLATE_NAME_EXISTS", "团队模板名称已存在。");
      }
      throw error;
    }
    this.options.audit(auth.user.id, existing ? "team_template.updated" : "team_template.created", "team_template", template.id, { name: template.name });
    sendJson(response, existing ? 200 : 201, { template });
  }

  private deleteTemplate({ response, auth, match }: RouteRequest): void {
    this.assertAdmin(auth.user);
    const id = routeId(match, 1);
    const template = this.options.repository.getTeamConfigTemplate(id);
    if (!template) throw new HttpError(404, "TEMPLATE_NOT_FOUND", "团队模板不存在。");
    this.options.repository.deleteTeamConfigTemplate(id);
    this.options.audit(auth.user.id, "team_template.deleted", "team_template", id, { name: template.name });
    sendJson(response, 200, { ok: true });
  }

  private async applyTemplate({ request, response, auth, match }: RouteRequest): Promise<void> {
    this.assertAdmin(auth.user);
    const templateId = routeId(match, 1);
    const template = this.options.repository.getTeamConfigTemplate(templateId);
    if (!template) throw new HttpError(404, "TEMPLATE_NOT_FOUND", "团队模板不存在。");
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    assertOnlyKeys(body, ["teamId"]);
    const teamId = inputString(body.teamId, "teamId", 1, 128);
    const team = this.options.repository.getTeam(teamId);
    if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "团队不存在。");
    const updatedAt = this.options.now();
    const runtimeDefaults = {
      modelContextTokens: template.modelContextTokens,
      autoCompactRatio: template.autoCompactRatio,
      autoCompactEnabled: template.autoCompactEnabled,
      mcpToolAllowlist: [...template.mcpToolAllowlist],
    };
    const appliedTeam = { ...team, workspaceMode: template.workspaceMode, runtimeDefaults, updatedAt };
    this.options.repository.transaction(() => {
      this.options.repository.saveTeam(appliedTeam);
      this.options.audit(auth.user.id, "team_template.applied", "team", team.id, {
        templateId: template.id,
        workspaceMode: template.workspaceMode,
        claudeConfigScope: "team",
      });
    });
    this.options.events.publish({ type: "team.updated", teamId: team.id, team: appliedTeam }, [...new Set([...this.options.teamAudience(team.id), ...this.options.adminAudience()])]);
    sendJson(response, 200, {
      template,
      appliedTeam,
      appliedClaudeConfig: {
        ...runtimeDefaults,
        scope: "team",
      },
    });
  }

  private async metrics({ response, auth }: RouteRequest): Promise<void> {
    this.assertAdmin(auth.user);
    const sampledAt = this.options.now();
    const counts = this.options.repository.countMetrics();
    const runtimeRaw = this.options.runtime.metricsSnapshot();
    const sseRaw = metricsOf(this.options.events);
    const [sizeBytes, walBytes] = await Promise.all([
      fileSize(this.options.config.databaseFile),
      fileSize(`${this.options.config.databaseFile}-wal`),
    ]);
    sendJson(response, 200, {
      sampledAt,
      sessions: {
        queued: counts.sessions.queued ?? 0,
        running: counts.sessions.running ?? 0,
        waitingPermission: counts.sessions.waiting_permission ?? 0,
        failed: counts.sessions.failed ?? 0,
        total: Object.values(counts.sessions).reduce((sum, count) => sum + count, 0),
      },
      runtime: {
        ...runtimeRaw,
        queued: numberField(runtimeRaw, "schedulerQueued"),
        running: numberField(runtimeRaw, "schedulerRunning"),
        waitingPermission: numberField(runtimeRaw, "permissionsPending"),
      },
      sse: {
        ...sseRaw,
        clients: numberField(sseRaw, "activeConnections"),
        eventsBuffered: numberField(sseRaw, "historyLength"),
      },
      database: { sizeBytes, walBytes, writeLatencyMs: null },
      platform: { activeUsers: counts.users, teams: counts.teams, messages: counts.messages, pendingPermissions: counts.pendingPermissions },
      backup: this.options.backup?.metricsSnapshot() ?? null,
    });
  }
}

function auditFilters(url: URL): { userId?: string; action?: string; targetType?: string; targetId?: string } {
  const userId = optionalQuery(url, "userId", 128);
  const action = optionalQuery(url, "action", 128);
  const targetType = optionalQuery(url, "targetType", 128);
  const targetId = optionalQuery(url, "targetId", 256);
  return {
    ...(userId ? { userId } : {}),
    ...(action ? { action } : {}),
    ...(targetType ? { targetType } : {}),
    ...(targetId ? { targetId } : {}),
  };
}

function collectAuditLogs(repository: PersistenceRepository, filters: ReturnType<typeof auditFilters>, maximum: number): AuditLog[] {
  const logs: AuditLog[] = [];
  let cursor: string | null = null;
  do {
    const page = repository.listAuditLogs({ ...filters, cursor, limit: Math.min(200, maximum - logs.length) });
    logs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && logs.length < maximum);
  return logs;
}

function csvRow(values: Array<string | number>): string {
  return values.map((value) => {
    const text = String(value);
    const safe = typeof value === "string" && /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  }).join(",");
}

async function fileSize(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

function metricsOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || !("metricsSnapshot" in value)) return {};
  const method = (value as { metricsSnapshot?: unknown }).metricsSnapshot;
  return typeof method === "function" ? method.call(value) as Record<string, unknown> : {};
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { hashPassword } from "../auth/passwords.js";
import type { AppConfig } from "../config.js";
import {
  canManageTeam,
  canSeeSession,
  canSeeTeam,
  createId,
  isSystemAdmin,
  type AuditLog,
  type ClaudeConfig,
  type ConversationSession,
  type JsonObject,
  type User,
} from "../domain/index.js";
import type { RuntimeEvent } from "../runtime/claude-runtime.js";
import { ClaudeRuntimeManager } from "../runtime/claude-runtime.js";
import { assertAllowedOrigin, InputValidationError, OriginNotAllowedError, resolveAllowedRealPath } from "../security/index.js";
import { readSessionPlan, readToolInventory } from "../services/runtime-store.js";
import type { PersistenceRepository } from "../persistence/index.js";
import { SseHub } from "../events/sse.js";
import {
  HttpError,
  readJsonBody,
  requestIp,
  sendJson,
} from "./core.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { AdminRoutes } from "./routes/admin.js";
import type { MetricsSnapshotSource } from "./routes/admin.js";
import { ExportRoutes } from "./routes/exports.js";
import { AuthController } from "./routes/auth.js";
import { TeamRoutes } from "./routes/teams.js";
import { SessionRoutes } from "./routes/sessions.js";
import { findRoute, type RouteAuth, type RouteDefinition } from "./routes/shared.js";
import { JsonLogger, redactRecord, type StructuredLogger } from "../observability/logger.js";
import type { LineageScheduler } from "../lineage/scheduler.js";
import type { ColumnLineageAnalyzer } from "../lineage/column-analyzer.js";
import { LineageRoutes } from "./routes/lineage.js";

const execFileAsync = promisify(execFile);
export interface ApiServerOptions {
  repository: PersistenceRepository;
  config: AppConfig;
  runtime: ClaudeRuntimeManager;
  events: SseHub;
  startedAt?: number;
  now?: () => number;
  logger?: StructuredLogger;
  backup?: MetricsSnapshotSource;
  lineageScheduler: LineageScheduler;
  columnLineageAnalyzer: ColumnLineageAnalyzer;
}

export class ApiServer {
  private readonly repository: PersistenceRepository;
  private readonly config: AppConfig;
  private readonly runtime: ClaudeRuntimeManager;
  private readonly events: SseHub;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly logger: StructuredLogger;
  private readonly modularRoutes: readonly RouteDefinition[];
  private readonly authController: AuthController;
  private readonly mutationLimiter = new FixedWindowRateLimiter({ limit: 180, windowMs: 60_000 });

  constructor(options: ApiServerOptions) {
    this.repository = options.repository;
    this.config = options.config;
    this.runtime = options.runtime;
    this.events = options.events;
    this.startedAt = options.startedAt ?? Date.now();
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? new JsonLogger();
    const routeOptions = {
      repository: this.repository,
      now: this.now,
      audit: (userId: string | null, action: string, targetType: string, targetId: string, metadata: JsonObject) => this.audit(userId, action, targetType, targetId, metadata),
    };
    this.authController = new AuthController({ ...routeOptions, config: this.config });
    const admin = new AdminRoutes({
      ...routeOptions,
      config: this.config,
      events: this.events,
      runtime: { metricsSnapshot: () => metricsSnapshotOf(this.runtime) },
      maxBodySize: this.config.maxBodySize,
      toSessionDto: (session) => ({ ...this.toSessionDto(session) }),
      adminAudience: () => this.adminAudience(),
      sessionAudience: (session) => this.sessionAudience(session),
      teamAudience: (teamId) => this.teamAudience(teamId),
      ...(options.backup ? { backup: options.backup } : {}),
    });
    const exports = new ExportRoutes(routeOptions);
    const teams = new TeamRoutes({
      ...routeOptions,
      events: this.events,
      maxBodySize: this.config.maxBodySize,
      claudeCommand: this.config.claudeCommand,
      prepareWorkspace: (path) => this.prepareWorkspace(path),
    });
    const sessions = new SessionRoutes({
      ...routeOptions,
      runtime: this.runtime,
      events: this.events,
      maxBodySize: this.config.maxBodySize,
      toSessionDto: (session) => ({ ...this.toSessionDto(session) }),
      sessionAudience: (session) => this.sessionAudience(session),
      teamAudience: (teamId) => this.teamAudience(teamId),
    });
    const lineage = new LineageRoutes({
      ...routeOptions,
      scheduler: options.lineageScheduler,
      analyzer: options.columnLineageAnalyzer,
      maxBodySize: this.config.maxBodySize,
      claudeConfig: () => this.repository.getClaudeConfig(),
    });
    this.modularRoutes = [...admin.definitions, ...exports.definitions, ...teams.definitions, ...sessions.definitions, ...lineage.definitions];
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = createId("request");
    const startedAt = this.now();
    response.setHeader("X-Request-Id", requestId);
    this.setSecurityHeaders(response);
    let userId: string | null = null;
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      const method = request.method || "GET";
      if (method === "OPTIONS") {
        response.writeHead(204, { Allow: "GET, POST, PATCH, DELETE, OPTIONS" });
        response.end();
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        await this.serveStatic(url.pathname, method, response);
        return;
      }
      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, uptimeMs: this.now() - this.startedAt });
        return;
      }
      if (method === "POST" && url.pathname === "/api/auth/login") {
        await this.assertMutationAllowed(request);
        await this.authController.login(request, response);
        return;
      }

      const auth = this.authController.authenticate(request);
      userId = auth.user.id;
      if (method !== "GET") {
        await this.assertMutationAllowed(request);
        const limit = this.mutationLimiter.consume(auth.user.id);
        if (!limit.allowed) {
          throw new HttpError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试。", { retryAfterSeconds: limit.retryAfterSeconds });
        }
      }
      if (method === "GET" && url.pathname === "/api/events") {
        const replayId = url.searchParams.get("lastEventId");
        if (replayId && /^\d+$/.test(replayId)) request.headers["last-event-id"] = replayId;
        this.events.connect(request, response, auth.user.id, auth.expiresAt);
        return;
      }
      const modular = findRoute(this.modularRoutes, method, url.pathname);
      if (modular) {
        await modular.route.handle({ request, response, url, auth, match: modular.match, requestId });
      } else {
        await this.routeAuthenticated(request, response, url, auth);
      }
    } catch (error) {
      if (response.headersSent || response.writableEnded) return;
      this.sendError(response, error, requestId);
    } finally {
      this.logger.info("http.request", {
        requestId,
        method: request.method || "GET",
        path: safeLogPath(request.url),
        status: response.statusCode,
        durationMs: Math.max(0, this.now() - startedAt),
        userId,
        ip: requestIp(request),
      });
    }
  }

  publishRuntimeEvent(event: RuntimeEvent): void {
    const session = this.repository.getSession(event.sessionId);
    if (!session) return;
    const normalized = event.type === "session.plan.updated"
      ? { ...event, plan: event.plan.items }
      : event.type === "session.status.changed"
        ? { ...event, session: this.toSessionDto(session) }
        : event;
    this.events.publish(normalized, this.sessionAudience(session));
  }

  private async routeAuthenticated(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    auth: RouteAuth,
  ): Promise<void> {
    const method = request.method || "GET";
    const path = url.pathname;
    if (method === "POST" && path === "/api/auth/logout") return this.authController.logout(response, auth);
    if (method === "PATCH" && path === "/api/auth/password") return this.authController.changePassword(request, response, auth);
    if (method === "GET" && path === "/api/bootstrap") return this.bootstrap(response, auth.user);
    if (method === "GET" && path === "/api/workspaces") return this.listWorkspaces(response, auth.user);
    if (method === "PATCH" && path === "/api/claude/config") return this.updateClaudeConfig(request, response, auth.user);
    if (method === "POST" && path === "/api/claude/health-check") return this.checkClaudeHealth(response, auth.user);
    if (method === "POST" && path === "/api/users") return this.createUser(request, response, auth.user);

    let match = path.match(/^\/api\/users\/([^/]+)\/password$/);
    if (match && method === "PATCH") return this.resetUserPassword(request, response, auth.user, decodePart(match[1]));
    match = path.match(/^\/api\/users\/([^/]+)\/status$/);
    if (match && method === "PATCH") return this.toggleUserStatus(response, auth.user, decodePart(match[1]));
    throw new HttpError(404, "NOT_FOUND", "接口不存在。");
  }

  private bootstrap(response: ServerResponse, user: User): void {
    const teams = this.repository.listTeamsForUser(user.id, isSystemAdmin(user));
    const teamIds = teams.map((team) => team.id);
    const members = teams.flatMap((team) => this.repository.listTeamMembers(team.id));
    const directoryIds = new Set(members.map((member) => member.userId));
    directoryIds.add(user.id);
    const canAddMembers = isSystemAdmin(user) || teams.some((team) => canManageTeam(this.repository, user, team.id));
    const users = this.repository.listUsers()
      .filter((candidate) => canAddMembers || directoryIds.has(candidate.id))
      .map(publicUser);
    const recentSessions = this.repository.listSessions({ teamIds, includeArchived: false, limit: 40 }).items
      .filter((session) => canSeeSession(this.repository, user, session));
    const config = this.repository.getClaudeConfig();
    const admin = isSystemAdmin(user);
    sendJson(response, 200, {
      currentUserId: user.id,
      users,
      teams,
      members,
      agents: this.repository.listAgents(teamIds),
      sessions: recentSessions.map((session) => this.toSessionDto(session)),
      messages: [],
      permissions: [],
      fileChanges: [],
      auditLogs: isSystemAdmin(user)
        ? this.repository.listAuditLogs({ limit: 200 }).items
        : [],
      claudeConfig: admin && config ? configDto(config) : publicConfigDto(config),
      serverInfo: {
        appVersion: "1.0.0",
        nodeVersion: process.version,
        sdkPackage: "@anthropic-ai/claude-agent-sdk",
        startedAt: this.startedAt,
        ...(admin ? { dataDir: this.config.dataDir, workspaceRoot: config?.workspaceRoot ?? "" } : {}),
      },
      toolInventory: readToolInventory(this.repository),
    });
  }

  private async createUser(request: IncomingMessage, response: ServerResponse, user: User): Promise<void> {
    if (!isSystemAdmin(user)) throw forbidden();
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const username = requiredString(body.username, "username", 3, 64).toLowerCase();
    if (!/^[a-z0-9_.-]+$/i.test(username)) throw invalid("用户名只能包含字母、数字、点、下划线和连字符。");
    if (this.repository.getUserByUsername(username)) throw new HttpError(409, "USERNAME_EXISTS", "用户名已存在。");
    const createdAt = this.now();
    const created: User = {
      id: createId("user"), username, passwordHash: await hashPassword(passwordInput(body.password)),
      displayName: requiredString(body.displayName, "displayName", 1, 80),
      email: typeof body.email === "string" ? requiredString(body.email, "email", 0, 254) : "",
      role: enumValue(body.role ?? "member", ["admin", "member"] as const, "role"), status: "active", createdAt, updatedAt: createdAt,
    };
    this.repository.saveUser(created);
    this.audit(user.id, "user.created", "user", created.id, { username, role: created.role });
    sendJson(response, 201, { user: publicUser(created) });
  }

  private async resetUserPassword(request: IncomingMessage, response: ServerResponse, user: User, userId: string): Promise<void> {
    if (!isSystemAdmin(user)) throw forbidden();
    const target = this.requireUser(userId);
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    this.repository.saveUser({ ...target, passwordHash: await hashPassword(passwordInput(body.newPassword)), updatedAt: this.now() });
    this.repository.revokeAuthSessionsForUser(target.id);
    this.audit(user.id, "user.password_reset", "user", target.id, {});
    sendJson(response, 200, { ok: true });
  }

  private toggleUserStatus(response: ServerResponse, user: User, userId: string): void {
    if (!isSystemAdmin(user)) throw forbidden();
    const target = this.requireUser(userId);
    if (target.id === user.id) throw new HttpError(409, "CANNOT_DISABLE_SELF", "不能停用当前登录账号。");
    const status: User["status"] = target.status === "active" ? "disabled" : "active";
    const updated = { ...target, status, updatedAt: this.now() };
    this.repository.saveUser(updated);
    if (status === "disabled") this.repository.revokeAuthSessionsForUser(target.id);
    this.audit(user.id, "user.status_changed", "user", target.id, { status });
    sendJson(response, 200, { user: publicUser(updated) });
  }

  private async updateClaudeConfig(request: IncomingMessage, response: ServerResponse, user: User): Promise<void> {
    if (!isSystemAdmin(user)) throw forbidden();
    const current = this.repository.getClaudeConfig();
    if (!current) throw new HttpError(500, "CONFIG_MISSING", "Claude 配置不存在。");
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const workspaceRoot = body.workspaceRoot === undefined
      ? current.workspaceRoot
      : await this.prepareWorkspace(requiredString(body.workspaceRoot, "workspaceRoot", 1, 1_024));
    const updated: ClaudeConfig = {
      ...current,
      command: body.command === undefined ? current.command : requiredString(body.command, "command", 1, 1_024),
      args: body.args === undefined ? current.args : requiredString(body.args, "args", 0, 4_096, false),
      workspaceRoot,
      modelContextTokens: body.modelContextTokens === undefined ? current.modelContextTokens : safeInteger(body.modelContextTokens, "modelContextTokens", 1_000, 10_000_000),
      autoCompactRatio: body.autoCompactRatio === undefined ? current.autoCompactRatio : safeNumber(body.autoCompactRatio, "autoCompactRatio", 0.1, 0.9),
      autoCompactEnabled: body.autoCompactEnabled === undefined ? current.autoCompactEnabled : requiredBoolean(body.autoCompactEnabled, "autoCompactEnabled"),
      mcpToolAllowlist: body.mcpToolAllowlist === undefined ? current.mcpToolAllowlist : stringList(body.mcpToolAllowlist, "mcpToolAllowlist", 500),
      available: false, authenticated: false, lastCheckAt: null, healthMessage: "配置已更新，请运行健康检查。", updatedAt: this.now(),
    };
    this.repository.saveClaudeConfig(updated);
    this.audit(user.id, "claude.config_updated", "config", "claude", {});
    sendJson(response, 200, { claudeConfig: configDto(updated) });
  }

  private async checkClaudeHealth(response: ServerResponse, user: User): Promise<void> {
    if (!isSystemAdmin(user)) throw forbidden();
    const current = this.repository.getClaudeConfig();
    if (!current) throw new HttpError(500, "CONFIG_MISSING", "Claude 配置不存在。");
    const started = this.now();
    let available = false;
    let version = "unknown";
    let message: string | null = null;
    try {
      if (!current.command || current.command === "claude") {
        const packageJson = JSON.parse(await readFile(resolve("node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")) as { claudeCodeVersion?: string };
        version = packageJson.claudeCodeVersion || "SDK bundled";
        available = true;
      } else {
        const result = await execFileAsync(current.command, ["--version"], { timeout: 10_000, maxBuffer: 256 * 1024 });
        version = `${result.stdout || result.stderr}`.trim().split(/\r?\n/)[0] || "unknown";
        available = true;
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".claude");
    const authenticated = Boolean(
      process.env.ANTHROPIC_API_KEY
      || process.env.CLAUDE_CODE_OAUTH_TOKEN
      || (claudeHome && existsSync(join(claudeHome, ".credentials.json"))),
    );
    const updated: ClaudeConfig = {
      ...current, available, authenticated, version, latencyMs: Math.max(0, this.now() - started),
      lastCheckAt: this.now(), healthMessage: message || (authenticated ? null : "Claude Code 可执行，但未检测到独立运行凭据。"), updatedAt: this.now(),
    };
    this.repository.saveClaudeConfig(updated);
    this.audit(user.id, "claude.health_checked", "config", "claude", { available });
    sendJson(response, 200, { claudeConfig: configDto(updated) });
  }

  private listWorkspaces(response: ServerResponse, user: User): void {
    const teams = this.repository.listTeamsForUser(user.id, isSystemAdmin(user));
    sendJson(response, 200, { workspaceRoot: this.currentWorkspaceRoot(), workspaces: teams.map((team) => ({ teamId: team.id, path: team.workspacePath })) });
  }

  private async assertMutationAllowed(request: IncomingMessage): Promise<void> {
    assertAllowedOrigin(
      typeof request.headers.origin === "string" ? request.headers.origin : undefined,
      this.config.allowedOrigins,
    );
  }

  private async prepareWorkspace(path: string): Promise<string> {
    const candidate = resolve(path);
    const root = resolve(this.currentWorkspaceRoot());
    const child = relative(root, candidate);
    if (child.startsWith("..") || resolve(root, child) !== candidate) {
      throw new HttpError(400, "PATH_OUTSIDE_ALLOWLIST", "工作区目录必须位于系统 workspace root 内。");
    }
    try {
      return await resolveAllowedRealPath(candidate, [root]);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new HttpError(400, "WORKSPACE_NOT_FOUND", "工作区目录不存在，请先创建目录。");
      }
      throw error;
    }
  }

  private currentWorkspaceRoot(): string {
    return this.repository.getClaudeConfig()?.workspaceRoot ?? this.config.workspaceRoot;
  }

  private toSessionDto(session: ConversationSession): ConversationSession & { archived: boolean; plan?: unknown[] } {
    const plan = readSessionPlan(this.repository, session.id);
    return {
      ...session,
      archived: session.archivedAt !== null,
      ...(plan ? { plan: plan.items } : {}),
    };
  }

  private sessionAudience(session: ConversationSession): string[] {
    return this.repository.listUsers()
      .filter((user) => user.status === "active" && canSeeSession(this.repository, user, session))
      .map((user) => user.id);
  }

  private teamAudience(teamId: string): string[] {
    return this.repository.listUsers()
      .filter((user) => user.status === "active" && canSeeTeam(this.repository, user, teamId))
      .map((user) => user.id);
  }

  private adminAudience(): string[] {
    return this.repository.listUsers().filter((user) => user.status === "active" && isSystemAdmin(user)).map((user) => user.id);
  }

  private requireUser(id: string): User {
    const user = this.repository.getUser(id);
    if (!user) throw new HttpError(404, "USER_NOT_FOUND", "用户不存在。");
    return user;
  }

  private audit(userId: string | null, action: string, targetType: string, targetId: string, metadata: JsonObject): void {
    const safeMetadata = redactRecord(metadata) as JsonObject;
    const log: AuditLog = { id: createId("audit"), userId, action, targetType, targetId, metadata: safeMetadata, createdAt: this.now() };
    this.repository.appendAuditLog(log);
    this.logger.info("audit.recorded", { auditId: log.id, userId, action, targetType, targetId, metadata: safeMetadata });
  }

  private async serveStatic(pathname: string, method: string, response: ServerResponse): Promise<void> {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "METHOD_NOT_ALLOWED", "请求方法不支持。");
    const files: Record<string, [string, string]> = {
      "/": ["index.html", "text/html; charset=utf-8"],
      "/index.html": ["index.html", "text/html; charset=utf-8"],
      "/styles.css": ["styles.css", "text/css; charset=utf-8"],
      "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    };
    const selected = files[pathname];
    if (!selected) throw new HttpError(404, "NOT_FOUND", "页面不存在。");
    try {
      const content = await readFile(resolve(this.config.publicDir, selected[0]));
      response.writeHead(200, { "Content-Type": selected[1], "Cache-Control": pathname === "/" || pathname.endsWith(".html") ? "no-cache" : "public, max-age=300" });
      response.end(method === "HEAD" ? undefined : content);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new HttpError(404, "ASSET_NOT_FOUND", "前端资源尚未构建。");
      throw error;
    }
  }

  private setSecurityHeaders(response: ServerResponse): void {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  }

  private sendError(response: ServerResponse, error: unknown, requestId: string): void {
    if (error instanceof HttpError) {
      this.logger.warn("http.error", { requestId, status: error.status, code: error.code, message: error.message });
      sendJson(response, error.status, { code: error.code, message: error.message, details: error.details, requestId });
      return;
    }
    if (error instanceof InputValidationError) {
      sendJson(response, 400, { code: error.code, message: error.message, requestId });
      return;
    }
    if (error instanceof OriginNotAllowedError) {
      sendJson(response, 403, { code: error.code, message: "请求来源不受信任。", requestId });
      return;
    }
    const code = error instanceof Error && "code" in error ? String(error.code) : "INTERNAL_ERROR";
    if (code === "INVALID_CURSOR" || code === "PATH_OUTSIDE_ALLOWLIST") {
      sendJson(response, 400, { code, message: error instanceof Error ? error.message : "请求参数不正确。", requestId });
      return;
    }
    this.logger.error("http.unhandled_error", { requestId, code, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) });
    sendJson(response, 500, { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试。", requestId });
  }
}

function metricsSnapshotOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || !("metricsSnapshot" in value)) return {};
  const method = (value as { metricsSnapshot?: unknown }).metricsSnapshot;
  return typeof method === "function" ? method.call(value) as Record<string, unknown> : {};
}

function safeLogPath(raw: string | undefined): string {
  if (!raw) return "/";
  try { return new URL(raw, "http://localhost").pathname; } catch { return "/invalid-url"; }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("请求体必须是 JSON 对象。");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, minimum: number, maximum: number, trim = true): string {
  if (typeof value !== "string") throw invalid(`${name} 必须是字符串。`);
  const parsed = trim ? value.trim() : value;
  if (parsed.length < minimum || parsed.length > maximum) throw invalid(`${name} 长度必须在 ${minimum} 到 ${maximum} 个字符之间。`);
  return parsed;
}

function passwordInput(value: unknown): string {
  const password = requiredString(value, "password", 8, 512, false);
  if (/^\s+$/.test(password)) throw invalid("密码不能只包含空白字符。");
  return password;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${name} 必须是布尔值。`);
  return value;
}

function safeInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw invalid(`${name} 数值不正确。`);
  return value as number;
}

function safeNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw invalid(`${name} 数值不正确。`);
  return value;
}

function stringList(value: unknown, name: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || item.length > 512)) {
    throw invalid(`${name} 必须是有效的字符串数组。`);
  }
  return [...new Set(value.map((item) => (item as string).trim()).filter(Boolean))];
}

function enumValue<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw invalid(`${name} 的值不正确。`);
  return value as T;
}

function invalid(message: string): HttpError {
  return new HttpError(400, "INVALID_INPUT", message);
}

function forbidden(message = "你没有执行此操作的权限。"): HttpError {
  return new HttpError(403, "FORBIDDEN", message);
}

function decodePart(value: string | undefined): string {
  if (!value) throw invalid("路径参数缺失。");
  try { return decodeURIComponent(value); } catch { throw invalid("路径参数编码不正确。"); }
}

function publicUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

function configDto(config: ClaudeConfig): Omit<ClaudeConfig, "healthMessage"> & { message: string | null } {
  const { healthMessage, ...rest } = config;
  return { ...rest, message: healthMessage };
}

function publicConfigDto(config: ClaudeConfig | null): Record<string, unknown> | null {
  if (!config) return null;
  return {
    command: "",
    args: "",
    workspaceRoot: "",
    modelContextTokens: config.modelContextTokens,
    autoCompactRatio: config.autoCompactRatio,
    autoCompactEnabled: config.autoCompactEnabled,
    mcpToolAllowlist: [],
    enabled: config.enabled,
    available: config.available,
    version: config.version,
    latencyMs: config.latencyMs,
    authenticated: config.authenticated,
    lastCheckAt: config.lastCheckAt,
    message: config.healthMessage ? "运行状态异常，请联系管理员。" : null,
  };
}

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { createSessionToken, digestSessionToken } from "../auth/session-token.js";
import type { AppConfig } from "../config.js";
import {
  canApprovePermission,
  canAskSession,
  canManageTeam,
  canSeeSession,
  canSeeTeam,
  canWriteSession,
  createId,
  isSystemAdmin,
  type Agent,
  type AuditLog,
  type ClaudeConfig,
  type ConversationSession,
  type JsonObject,
  type Message,
  type PermissionDecision,
  type SessionStatus,
  type SessionVisibility,
  type Team,
  type TeamMember,
  type TeamRole,
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
  parseCookies,
  readJsonBody,
  requestIp,
  sendJson,
  sessionCookie,
} from "./core.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";

const execFileAsync = promisify(execFile);
const SESSION_STATUSES: readonly SessionStatus[] = [
  "idle", "queued", "running", "compacting", "waiting_permission", "completed", "failed", "stopped", "interrupted",
];
const TEAM_ROLES: readonly TeamRole[] = ["owner", "admin", "member", "viewer"];
const VISIBILITIES: readonly SessionVisibility[] = ["private", "team"];
const RUNNING_STATUSES = new Set<SessionStatus>(["queued", "running", "compacting", "waiting_permission"]);

interface AuthenticatedRequest {
  user: User;
  rawToken: string;
  tokenDigest: string;
  expiresAt: number;
}

export interface ApiServerOptions {
  repository: PersistenceRepository;
  config: AppConfig;
  runtime: ClaudeRuntimeManager;
  events: SseHub;
  startedAt?: number;
  now?: () => number;
}

export class ApiServer {
  private readonly repository: PersistenceRepository;
  private readonly config: AppConfig;
  private readonly runtime: ClaudeRuntimeManager;
  private readonly events: SseHub;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly loginLimiter = new FixedWindowRateLimiter({ limit: 8, windowMs: 15 * 60_000 });
  private readonly mutationLimiter = new FixedWindowRateLimiter({ limit: 180, windowMs: 60_000 });

  constructor(options: ApiServerOptions) {
    this.repository = options.repository;
    this.config = options.config;
    this.runtime = options.runtime;
    this.events = options.events;
    this.startedAt = options.startedAt ?? Date.now();
    this.now = options.now ?? Date.now;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setSecurityHeaders(response);
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
        await this.login(request, response);
        return;
      }

      const auth = this.authenticate(request);
      if (method !== "GET") {
        await this.assertMutationAllowed(request);
        const limit = this.mutationLimiter.consume(auth.user.id);
        if (!limit.allowed) {
          throw new HttpError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试。", { retryAfterSeconds: limit.retryAfterSeconds });
        }
      }
      if (method === "GET" && url.pathname === "/api/events") {
        this.events.connect(request, response, auth.user.id, auth.expiresAt);
        return;
      }
      await this.routeAuthenticated(request, response, url, auth);
    } catch (error) {
      if (response.headersSent || response.writableEnded) return;
      this.sendError(response, error);
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
    auth: AuthenticatedRequest,
  ): Promise<void> {
    const method = request.method || "GET";
    const path = url.pathname;
    if (method === "POST" && path === "/api/auth/logout") return this.logout(response, auth);
    if (method === "PATCH" && path === "/api/auth/password") return this.changePassword(request, response, auth);
    if (method === "GET" && path === "/api/bootstrap") return this.bootstrap(response, auth.user);
    if (method === "GET" && path === "/api/sessions") return this.listSessions(response, url, auth.user);
    if (method === "GET" && path === "/api/workspaces") return this.listWorkspaces(response, auth.user);
    if (method === "POST" && path === "/api/teams") return this.createTeam(request, response, auth.user);
    if (method === "PATCH" && path === "/api/claude/config") return this.updateClaudeConfig(request, response, auth.user);
    if (method === "POST" && path === "/api/claude/health-check") return this.checkClaudeHealth(response, auth.user);
    if (method === "POST" && path === "/api/users") return this.createUser(request, response, auth.user);

    let match = path.match(/^\/api\/teams\/([^/]+)\/sessions$/);
    if (match && method === "POST") return this.createSession(request, response, auth.user, decodePart(match[1]));
    match = path.match(/^\/api\/teams\/([^/]+)\/members$/);
    if (match && method === "POST") return this.saveTeamMember(request, response, auth.user, decodePart(match[1]));
    match = path.match(/^\/api\/teams\/([^/]+)\/members\/([^/]+)$/);
    if (match && method === "DELETE") return this.removeTeamMember(response, auth.user, decodePart(match[1]), decodePart(match[2]));
    match = path.match(/^\/api\/teams\/([^/]+)$/);
    if (match && method === "PATCH") return this.updateTeam(request, response, auth.user, decodePart(match[1]));
    if (match && method === "DELETE") return this.deleteTeam(response, auth.user, decodePart(match[1]));

    match = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (match && method === "GET") return this.listMessages(response, url, auth.user, decodePart(match[1]));
    if (match && method === "POST") return this.sendMessage(request, response, auth.user, decodePart(match[1]));
    match = path.match(/^\/api\/sessions\/([^/]+)\/retry$/);
    if (match && method === "POST") return this.retrySession(request, response, auth.user, decodePart(match[1]));
    match = path.match(/^\/api\/sessions\/([^/]+)\/stop$/);
    if (match && method === "POST") return this.stopSession(response, auth.user, decodePart(match[1]));
    match = path.match(/^\/api\/sessions\/([^/]+)\/visibility$/);
    if (match && method === "PATCH") return this.updateVisibility(request, response, auth.user, decodePart(match[1]));
    match = path.match(/^\/api\/sessions\/([^/]+)\/tool-approvals$/);
    if (match && method === "DELETE") return this.removeToolApproval(request, response, auth.user, decodePart(match[1]));
    match = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (match && method === "PATCH") return this.updateSession(request, response, auth.user, decodePart(match[1]));
    if (match && method === "DELETE") return this.deleteSession(response, auth.user, decodePart(match[1]));

    match = path.match(/^\/api\/permissions\/([^/]+)\/(approve|reject)$/);
    if (match && method === "POST") return this.decidePermission(request, response, auth.user, decodePart(match[1]), match[2] as "approve" | "reject");
    match = path.match(/^\/api\/users\/([^/]+)\/password$/);
    if (match && method === "PATCH") return this.resetUserPassword(request, response, auth.user, decodePart(match[1]));
    match = path.match(/^\/api\/users\/([^/]+)\/status$/);
    if (match && method === "PATCH") return this.toggleUserStatus(response, auth.user, decodePart(match[1]));
    throw new HttpError(404, "NOT_FOUND", "接口不存在。");
  }

  private async login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const username = requiredString(body.username, "username", 1, 64).toLowerCase();
    const password = requiredString(body.password, "password", 1, 512, false);
    const rate = this.loginLimiter.consume(`${requestIp(request)}:${username}`);
    if (!rate.allowed) throw new HttpError(429, "LOGIN_RATE_LIMITED", "登录尝试过多，请稍后重试。");
    const user = this.repository.getUserByUsername(username);
    const verification = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, "invalid:invalid");
    if (!user || user.status !== "active" || !verification.valid) {
      this.audit(null, "auth.login_failed", "user", user?.id || username, { ip: requestIp(request) });
      throw new HttpError(401, "INVALID_CREDENTIALS", "用户名或密码不正确。");
    }
    if (verification.needsRehash) {
      this.repository.saveUser({ ...user, passwordHash: await hashPassword(password), updatedAt: this.now() });
    }
    const token = createSessionToken();
    const createdAt = this.now();
    this.repository.saveAuthSession({
      token: token.digest,
      userId: user.id,
      expiresAt: createdAt + this.config.sessionTtlMs,
      createdAt,
      lastSeenAt: createdAt,
    });
    this.audit(user.id, "auth.login", "user", user.id, { ip: requestIp(request) });
    sendJson(response, 200, { user: publicUser(user) }, {
      "Set-Cookie": sessionCookie(token.token, {
        secure: this.config.cookieSecure,
        maximumAgeSeconds: Math.floor(this.config.sessionTtlMs / 1000),
      }),
    });
  }

  private logout(response: ServerResponse, auth: AuthenticatedRequest): void {
    this.repository.deleteAuthSession(auth.tokenDigest);
    this.repository.deleteAuthSession(auth.rawToken);
    this.audit(auth.user.id, "auth.logout", "user", auth.user.id, {});
    sendJson(response, 200, { ok: true }, {
      "Set-Cookie": sessionCookie("", { secure: this.config.cookieSecure, maximumAgeSeconds: 0 }),
    });
  }

  private async changePassword(request: IncomingMessage, response: ServerResponse, auth: AuthenticatedRequest): Promise<void> {
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const currentPassword = requiredString(body.currentPassword, "currentPassword", 1, 512, false);
    const newPassword = passwordInput(body.newPassword);
    const verified = await verifyPassword(currentPassword, auth.user.passwordHash);
    if (!verified.valid) throw new HttpError(403, "CURRENT_PASSWORD_INVALID", "当前密码不正确。");
    this.repository.saveUser({ ...auth.user, passwordHash: await hashPassword(newPassword), updatedAt: this.now() });
    this.repository.revokeAuthSessionsForUser(auth.user.id, auth.tokenDigest);
    this.audit(auth.user.id, "auth.password_changed", "user", auth.user.id, {});
    sendJson(response, 200, { ok: true });
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
        : this.repository.listAuditLogs({ userId: user.id, limit: 100 }).items,
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

  private listSessions(response: ServerResponse, url: URL, user: User): void {
    const teamId = requiredQuery(url, "teamId", 128);
    if (!canSeeTeam(this.repository, user, teamId)) throw forbidden();
    const limit = integerQuery(url, "limit", 60, 1, 200);
    const cursor = url.searchParams.get("cursor");
    const q = (url.searchParams.get("q") || "").trim();
    const statusRaw = url.searchParams.get("status");
    const statuses = statusRaw ? [enumValue(statusRaw, SESSION_STATUSES, "status")] : undefined;
    const createdBy = url.searchParams.get("createdBy") || undefined;
    const archived = url.searchParams.get("archived") || "active";
    if (!["active", "archived", "all"].includes(archived)) throw invalid("archived 参数不正确。");
    if (createdBy && !this.repository.getUser(createdBy)) throw invalid("createdBy 用户不存在。");

    let sessions: ConversationSession[];
    let nextCursor: string | null;
    const visibleToUserId = canManageTeam(this.repository, user, teamId) ? undefined : user.id;
    if (q) {
      const page = this.repository.searchSessions({
        query: q, teamIds: [teamId], includeArchived: archived !== "active", limit, cursor,
        ...(createdBy ? { createdBy } : {}),
        ...(statuses ? { statuses } : {}),
        ...(visibleToUserId ? { visibleToUserId } : {}),
      });
      sessions = page.items;
      nextCursor = page.nextCursor;
    } else {
      const page = this.repository.listSessions({
        teamIds: [teamId],
        includeArchived: archived !== "active",
        limit,
        cursor,
        ...(createdBy ? { createdBy } : {}),
        ...(statuses ? { statuses } : {}),
        ...(visibleToUserId ? { visibleToUserId } : {}),
      });
      sessions = page.items;
      nextCursor = page.nextCursor;
    }
    sessions = sessions.filter((session) =>
      canSeeSession(this.repository, user, session)
      && (!statuses || statuses.includes(session.status))
      && (!createdBy || session.createdBy === createdBy)
      && (archived === "all" || (archived === "archived" ? session.archivedAt !== null : session.archivedAt === null))
    );
    sendJson(response, 200, { sessions: sessions.map((session) => this.toSessionDto(session)), nextCursor });
  }

  private listMessages(response: ServerResponse, url: URL, user: User, sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (!canSeeSession(this.repository, user, session)) throw forbidden();
    const page = this.repository.listMessages(session.id, {
      limit: integerQuery(url, "limit", 80, 1, 200),
      cursor: url.searchParams.get("cursor"),
    });
    sendJson(response, 200, {
      messages: page.items,
      nextCursor: page.nextCursor,
      permissions: this.repository.listPermissions(session.id),
      fileChanges: this.repository.listFileChanges(session.id),
    });
  }

  private async createTeam(request: IncomingMessage, response: ServerResponse, user: User): Promise<void> {
    if (!isSystemAdmin(user)) throw forbidden();
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const name = requiredString(body.name, "name", 2, 80);
    const workspacePath = await this.prepareWorkspace(requiredString(body.workspacePath, "workspacePath", 1, 1_024));
    const createdAt = this.now();
    const team: Team = { id: createId("team"), name, workspacePath, workspaceMode: "shared", createdBy: user.id, createdAt, updatedAt: createdAt };
    const member: TeamMember = { teamId: team.id, userId: user.id, role: "owner", createdAt, updatedAt: createdAt };
    const agent: Agent = {
      id: createId("agent"), teamId: team.id, name: "Claude Code", type: "claude_code", command: this.config.claudeCommand,
      enabled: true, status: "idle", metadata: {}, createdAt, updatedAt: createdAt,
    };
    this.repository.transaction(() => {
      this.repository.saveTeam(team);
      this.repository.saveTeamMember(member);
      this.repository.saveAgent(agent);
      this.audit(user.id, "team.created", "team", team.id, { name: team.name });
    });
    this.events.publish({ type: "team.created", team, member, agent }, this.adminAudience());
    sendJson(response, 201, { team, member, agent });
  }

  private async updateTeam(request: IncomingMessage, response: ServerResponse, user: User, teamId: string): Promise<void> {
    const team = this.requireTeam(teamId);
    if (!canManageTeam(this.repository, user, team.id)) throw forbidden();
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const workspacePath = body.workspacePath === undefined ? team.workspacePath : await this.prepareWorkspace(requiredString(body.workspacePath, "workspacePath", 1, 1_024));
    const name = body.name === undefined ? team.name : requiredString(body.name, "name", 2, 80);
    const updated = { ...team, name, workspacePath, updatedAt: this.now() };
    this.repository.saveTeam(updated);
    this.audit(user.id, "team.updated", "team", team.id, {});
    this.events.publish({ type: "team.updated", team: updated, teamId }, this.teamAudience(teamId));
    sendJson(response, 200, { team: updated });
  }

  private deleteTeam(response: ServerResponse, user: User, teamId: string): void {
    const team = this.requireTeam(teamId);
    if (!isSystemAdmin(user)) throw forbidden();
    const active = this.allTeamSessions(team.id).find((session) => RUNNING_STATUSES.has(session.status));
    if (active) throw new HttpError(409, "TEAM_ACTIVE", "团队仍有运行中的会话，请先停止后再删除。");
    const audience = this.teamAudience(teamId);
    this.repository.deleteTeam(teamId);
    this.audit(user.id, "team.deleted", "team", teamId, { name: team.name });
    this.events.publish({ type: "team.deleted", teamId }, audience);
    sendJson(response, 200, { ok: true });
  }

  private async saveTeamMember(request: IncomingMessage, response: ServerResponse, user: User, teamId: string): Promise<void> {
    this.requireTeam(teamId);
    if (!canManageTeam(this.repository, user, teamId)) throw forbidden();
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const userId = requiredString(body.userId, "userId", 1, 128);
    const role = enumValue(body.role, TEAM_ROLES, "role");
    const requesterRole = this.repository.getTeamRole(teamId, user.id);
    if (role === "owner" && !isSystemAdmin(user) && requesterRole !== "owner") throw forbidden("只有 owner 可以授予 owner 角色。");
    const target = this.repository.getUser(userId);
    if (!target || target.status !== "active") throw new HttpError(404, "USER_NOT_FOUND", "用户不存在或已停用。");
    const createdAt = this.now();
    const existing = this.repository.getTeamRole(teamId, userId);
    if (existing === "owner" && role !== "owner") {
      if (!isSystemAdmin(user) && requesterRole !== "owner") throw forbidden("团队管理员不能降级 owner。");
      if (this.repository.listTeamMembers(teamId).filter((member) => member.role === "owner").length <= 1) {
        throw new HttpError(409, "LAST_OWNER", "团队必须至少保留一位 owner。");
      }
    }
    const member: TeamMember = { teamId, userId, role, createdAt: existing ? createdAt : createdAt, updatedAt: createdAt };
    this.repository.saveTeamMember(member);
    this.audit(user.id, existing ? "team.member_updated" : "team.member_added", "team", teamId, { userId, role });
    this.events.publish({ type: "team.member_updated", teamId, member }, this.teamAudience(teamId));
    sendJson(response, existing ? 200 : 201, { member });
  }

  private removeTeamMember(response: ServerResponse, user: User, teamId: string, userId: string): void {
    this.requireTeam(teamId);
    if (!canManageTeam(this.repository, user, teamId)) throw forbidden();
    const role = this.repository.getTeamRole(teamId, userId);
    if (!role) throw new HttpError(404, "MEMBER_NOT_FOUND", "团队成员不存在。");
    const requesterRole = this.repository.getTeamRole(teamId, user.id);
    if (role === "owner" && !isSystemAdmin(user) && requesterRole !== "owner") throw forbidden("团队管理员不能移除 owner。");
    if (role === "owner" && this.repository.listTeamMembers(teamId).filter((member) => member.role === "owner").length <= 1) {
      throw new HttpError(409, "LAST_OWNER", "不能移除团队的最后一位 owner。");
    }
    const audience = this.teamAudience(teamId);
    this.repository.removeTeamMember(teamId, userId);
    this.audit(user.id, "team.member_removed", "team", teamId, { userId });
    this.events.publish({ type: "team.member_removed", teamId, userId }, audience);
    sendJson(response, 200, { ok: true });
  }

  private async createSession(request: IncomingMessage, response: ServerResponse, user: User, teamId: string): Promise<void> {
    const team = this.requireTeam(teamId);
    if (!canSeeTeam(this.repository, user, teamId) || !this.repository.getTeamRole(teamId, user.id) && !isSystemAdmin(user)) throw forbidden();
    const role = this.repository.getTeamRole(teamId, user.id);
    if (!isSystemAdmin(user) && role === "viewer") throw forbidden();
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
    const agent = agentId ? this.repository.getAgent(agentId) : this.repository.listAgents([teamId]).find((item) => item.teamId === teamId || item.teamId === null);
    if (!agent || !agent.enabled || (agent.teamId !== null && agent.teamId !== teamId)) throw new HttpError(409, "AGENT_UNAVAILABLE", "团队没有可用的 Agent。");
    const createdAt = this.now();
    const session: ConversationSession = {
      id: createId("session"), teamId, agentId: agent.id, createdBy: user.id,
      title: typeof body.title === "string" ? requiredString(body.title, "title", 1, 100) : "新会话",
      summary: null, summaryUpdatedAt: null, visibility: "private", status: "idle", cwd: team.workspacePath,
      claudeSessionId: null, toolApprovals: { onceTools: [], alwaysTools: [], alwaysServers: [] }, archivedAt: null,
      pinnedAt: null, createdAt, updatedAt: createdAt,
    };
    this.repository.createSession(session);
    this.audit(user.id, "session.created", "session", session.id, { teamId });
    this.events.publish({ type: "session.created", session: this.toSessionDto(session), teamId, sessionId: session.id }, this.sessionAudience(session));
    sendJson(response, 201, { session: this.toSessionDto(session) });
  }

  private async sendMessage(request: IncomingMessage, response: ServerResponse, user: User, sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!canAskSession(this.repository, user, session)) throw forbidden();
    if (session.archivedAt !== null) throw new HttpError(409, "SESSION_ARCHIVED", "请先恢复会话再发送消息。");
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const content = requiredString(body.content, "content", 1, 200_000);
    const mode = enumValue(body.mode ?? "send", ["send", "guide", "interrupt"] as const, "mode");
    if (mode !== "send") {
      if (!RUNNING_STATUSES.has(session.status)) throw new HttpError(409, "SESSION_NOT_RUNNING", "当前会话没有可引导的运行任务。");
      if (mode === "interrupt") await this.runtime.interrupt(session.id);
      const accepted = this.runtime.sendGuidance(session.id, content, mode === "interrupt" ? "now" : "next");
      if (!accepted) throw new HttpError(409, "RUNTIME_NOT_ACTIVE", "运行任务尚未就绪，请稍后重试。");
      const message = this.appendUserMessage(session, user, content, { guidance: true, interrupt: mode === "interrupt" });
      this.events.publish({ type: "session.message.created", sessionId, message }, this.sessionAudience(session));
      sendJson(response, 202, { accepted: true, message });
      return;
    }
    if (this.repository.getActiveTurn(session.id)) throw new HttpError(409, "SESSION_ALREADY_ACTIVE", "会话已有任务正在运行。");
    const scheduled = await this.runtime.submit({ sessionId, teamId: session.teamId, userId: user.id, prompt: content });
    const message = this.appendUserMessage(session, user, content, { turnId: scheduled.id });
    if (session.title === "新会话") {
      const updated = { ...this.requireSession(session.id), title: titleFromPrompt(content), updatedAt: this.now() };
      this.repository.saveSession(updated);
      this.events.publish({ type: "session.updated", sessionId, session: this.toSessionDto(updated) }, this.sessionAudience(updated));
    }
    this.events.publish({ type: "session.message.created", sessionId, message }, this.sessionAudience(session));
    sendJson(response, 202, { accepted: true, turnId: scheduled.id, message });
  }

  private async retrySession(request: IncomingMessage, response: ServerResponse, user: User, sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!canAskSession(this.repository, user, session)) throw forbidden();
    if (session.archivedAt !== null) throw new HttpError(409, "SESSION_ARCHIVED", "请先恢复会话再重试消息。");
    if (this.repository.getActiveTurn(session.id)) throw new HttpError(409, "SESSION_ALREADY_ACTIVE", "会话已有任务正在运行。");
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const requestedMessageId = body.messageId === undefined ? null : requiredString(body.messageId, "messageId", 1, 128);
    const recent = this.repository.listMessages(session.id, { limit: 200 }).items;
    const source = requestedMessageId
      ? this.repository.getMessage(requestedMessageId)
      : recent.find((message) => message.senderType === "user" && !message.metadata.guidance);
    if (source && (source.sessionId !== session.id || source.senderType !== "user" || source.metadata.guidance)) {
      throw new HttpError(400, "INVALID_RETRY_MESSAGE", "所选消息不能用于重试。");
    }
    if (!source) throw new HttpError(409, "NOTHING_TO_RETRY", "没有可重试的用户消息。");
    const scheduled = await this.runtime.submit({
      sessionId, teamId: session.teamId, userId: user.id, prompt: source.content, retryOfMessageId: source.id,
    });
    const message = this.appendUserMessage(session, user, source.content, { turnId: scheduled.id, retryOfMessageId: source.id });
    this.events.publish({ type: "session.message.created", sessionId, message }, this.sessionAudience(session));
    sendJson(response, 202, { accepted: true, turnId: scheduled.id, message });
  }

  private stopSession(response: ServerResponse, user: User, sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (!canWriteSession(this.repository, user, session)) throw forbidden();
    const stopped = this.runtime.stop(session.id, `Stopped by ${user.username}.`);
    if (!stopped) throw new HttpError(409, "SESSION_NOT_RUNNING", "会话当前没有运行任务。");
    this.audit(user.id, "session.stopped", "session", session.id, {});
    sendJson(response, 202, { accepted: true });
  }

  private async updateVisibility(request: IncomingMessage, response: ServerResponse, user: User, sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!canWriteSession(this.repository, user, session)) throw forbidden();
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const visibility = enumValue(body.visibility, VISIBILITIES, "visibility");
    const previousAudience = new Set(this.sessionAudience(session));
    const updated = { ...session, visibility, updatedAt: this.now() };
    this.repository.saveSession(updated);
    this.audit(user.id, "session.visibility_changed", "session", session.id, { visibility });
    const currentAudience = this.sessionAudience(updated);
    this.events.publish({ type: "session.updated", sessionId, session: this.toSessionDto(updated) }, currentAudience);
    const removedAudience = [...previousAudience].filter((userId) => !currentAudience.includes(userId));
    if (removedAudience.length) {
      this.events.publish({ type: "session.deleted", sessionId, teamId: session.teamId }, removedAudience);
    }
    sendJson(response, 200, { session: this.toSessionDto(updated) });
  }

  private async updateSession(request: IncomingMessage, response: ServerResponse, user: User, sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!canWriteSession(this.repository, user, session)) throw forbidden();
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    if (typeof body.archived !== "boolean") throw invalid("archived 必须是布尔值。");
    if (body.archived && RUNNING_STATUSES.has(session.status)) throw new HttpError(409, "SESSION_ACTIVE", "运行中的会话不能归档。");
    const updated = { ...session, archivedAt: body.archived ? this.now() : null, updatedAt: this.now() };
    this.repository.saveSession(updated);
    this.audit(user.id, body.archived ? "session.archived" : "session.unarchived", "session", session.id, {});
    this.events.publish({ type: "session.updated", sessionId, session: this.toSessionDto(updated) }, this.sessionAudience(updated));
    sendJson(response, 200, { session: this.toSessionDto(updated) });
  }

  private async removeToolApproval(request: IncomingMessage, response: ServerResponse, user: User, sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!canWriteSession(this.repository, user, session)) throw forbidden();
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const scope = enumValue(body.scope, ["tool", "server"] as const, "scope");
    const value = requiredString(body.value, "value", 1, 512);
    const approvals = {
      onceTools: session.toolApprovals.onceTools.filter((item) => !(scope === "tool" && item === value)),
      alwaysTools: session.toolApprovals.alwaysTools.filter((item) => !(scope === "tool" && item === value)),
      alwaysServers: session.toolApprovals.alwaysServers.filter((item) => !(scope === "server" && item === value)),
    };
    const updated = { ...session, toolApprovals: approvals, updatedAt: this.now() };
    this.repository.saveSession(updated);
    this.audit(user.id, "session.tool_approval_removed", "session", session.id, { scope, value });
    this.events.publish({ type: "session.updated", sessionId, session: this.toSessionDto(updated) }, this.sessionAudience(updated));
    sendJson(response, 200, { session: this.toSessionDto(updated) });
  }

  private deleteSession(response: ServerResponse, user: User, sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (!canWriteSession(this.repository, user, session)) throw forbidden();
    if (RUNNING_STATUSES.has(session.status) || this.repository.getActiveTurn(session.id)) {
      throw new HttpError(409, "SESSION_ACTIVE", "请先停止运行任务再删除会话。");
    }
    const audience = this.sessionAudience(session);
    this.repository.deleteSession(session.id);
    this.audit(user.id, "session.deleted", "session", session.id, { teamId: session.teamId });
    this.events.publish({ type: "session.deleted", sessionId, teamId: session.teamId }, audience);
    sendJson(response, 200, { ok: true });
  }

  private async decidePermission(
    request: IncomingMessage,
    response: ServerResponse,
    user: User,
    permissionId: string,
    action: "approve" | "reject",
  ): Promise<void> {
    const permission = this.repository.getPermission(permissionId);
    if (!permission) throw new HttpError(404, "PERMISSION_NOT_FOUND", "权限请求不存在。");
    const session = this.requireSession(permission.sessionId);
    if (!canApprovePermission(this.repository, user, session, permission)) throw forbidden();
    const body = record(await readJsonBody(request, this.config.maxBodySize));
    const rawDecision = action === "reject" ? "rejected" : body.decision;
    const decision = normalizePermissionDecision(rawDecision, permission.type);
    const result = await this.runtime.decidePermission(permission.id, decision, user.id);
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : result.reason === "expired" ? 410 : 409;
      throw new HttpError(status, `PERMISSION_${result.reason.toUpperCase()}`, permissionDecisionMessage(result.reason));
    }
    const updated = result.permission;
    this.audit(user.id, "permission.decided", "permission", permission.id, { decision });
    sendJson(response, 200, { permission: updated });
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

  private authenticate(request: IncomingMessage): AuthenticatedRequest {
    const rawToken = parseCookies(request).cc_session;
    if (!rawToken) throw unauthorized();
    const tokenDigest = digestSessionToken(rawToken);
    let authSession = this.repository.getAuthSession(tokenDigest);
    if (!authSession) {
      const legacy = this.repository.getAuthSession(rawToken);
      if (legacy) {
        this.repository.deleteAuthSession(rawToken);
        authSession = { ...legacy, token: tokenDigest, lastSeenAt: this.now() };
        this.repository.saveAuthSession(authSession);
      }
    }
    if (!authSession) throw unauthorized();
    const user = this.repository.getUser(authSession.userId);
    if (!user || user.status !== "active") {
      this.repository.deleteAuthSession(tokenDigest);
      throw unauthorized();
    }
    if (this.now() - authSession.lastSeenAt > 60_000) {
      this.repository.saveAuthSession({ ...authSession, lastSeenAt: this.now() });
    }
    return { user, rawToken, tokenDigest, expiresAt: authSession.expiresAt };
  }

  private async assertMutationAllowed(request: IncomingMessage): Promise<void> {
    const host = typeof request.headers.host === "string" ? request.headers.host : "";
    const sameHostOrigins = host ? [`http://${host}`, `https://${host}`] : [];
    assertAllowedOrigin(
      typeof request.headers.origin === "string" ? request.headers.origin : undefined,
      [...this.config.allowedOrigins, ...sameHostOrigins],
      { allowMissing: true },
    );
  }

  private appendUserMessage(session: ConversationSession, user: User, content: string, metadata: JsonObject): Message {
    const message: Message = {
      id: createId("message"), sessionId: session.id, senderType: "user", senderId: user.id,
      content, metadata, createdAt: this.now(), updatedAt: null,
    };
    this.repository.appendMessage(message);
    return message;
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

  private allTeamSessions(teamId: string): ConversationSession[] {
    const sessions: ConversationSession[] = [];
    let cursor: string | null = null;
    do {
      const page = this.repository.listSessions({ teamIds: [teamId], includeArchived: true, limit: 200, cursor });
      sessions.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return sessions;
  }

  private requireSession(id: string): ConversationSession {
    const session = this.repository.getSession(id);
    if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "会话不存在。");
    return session;
  }

  private requireTeam(id: string): Team {
    const team = this.repository.getTeam(id);
    if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "团队不存在。");
    return team;
  }

  private requireUser(id: string): User {
    const user = this.repository.getUser(id);
    if (!user) throw new HttpError(404, "USER_NOT_FOUND", "用户不存在。");
    return user;
  }

  private audit(userId: string | null, action: string, targetType: string, targetId: string, metadata: JsonObject): void {
    const log: AuditLog = { id: createId("audit"), userId, action, targetType, targetId, metadata, createdAt: this.now() };
    this.repository.appendAuditLog(log);
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

  private sendError(response: ServerResponse, error: unknown): void {
    if (error instanceof HttpError) {
      sendJson(response, error.status, { code: error.code, message: error.message, details: error.details });
      return;
    }
    if (error instanceof InputValidationError) {
      sendJson(response, 400, { code: error.code, message: error.message });
      return;
    }
    if (error instanceof OriginNotAllowedError) {
      sendJson(response, 403, { code: error.code, message: "请求来源不受信任。" });
      return;
    }
    const code = error instanceof Error && "code" in error ? String(error.code) : "INTERNAL_ERROR";
    if (code === "INVALID_CURSOR" || code === "PATH_OUTSIDE_ALLOWLIST") {
      sendJson(response, 400, { code, message: error instanceof Error ? error.message : "请求参数不正确。" });
      return;
    }
    console.error(error);
    sendJson(response, 500, { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试。" });
  }
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

function integerQuery(url: URL, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return safeInteger(value, name, minimum, maximum);
}

function requiredQuery(url: URL, name: string, maximum: number): string {
  return requiredString(url.searchParams.get(name), name, 1, maximum);
}

function invalid(message: string): HttpError {
  return new HttpError(400, "INVALID_INPUT", message);
}

function forbidden(message = "你没有执行此操作的权限。"): HttpError {
  return new HttpError(403, "FORBIDDEN", message);
}

function unauthorized(): HttpError {
  return new HttpError(401, "UNAUTHENTICATED", "登录已失效，请重新登录。");
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

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim())?.trim() || "新会话";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

function normalizePermissionDecision(value: unknown, type: "platform_gate" | "mcp_tool"): PermissionDecision {
  if (type === "platform_gate" && value === "approved") return "allow_once";
  return enumValue(value, ["allow_once", "allow_always_tool", "allow_always_server", "rejected"] as const, "decision");
}

function permissionDecisionMessage(reason: string): string {
  if (reason === "expired") return "权限请求已过期。";
  if (reason === "already_decided") return "权限请求已被处理。";
  if (reason === "invalid_decision") return "权限决策不正确。";
  if (reason === "runtime_missing") return "Claude Code 已不再等待此权限，请刷新会话状态。";
  return "权限请求不存在。";
}

import {
  canApprovePermission, canAskSession, canManageTeam, canSeeSession, canSeeTeam, canWriteSession, createId, isSystemAdmin,
  type ConversationSession, type JsonObject, type Message, type PermissionDecision, type SessionStatus, type User,
} from "../../domain/index.js";
import type { SseHub } from "../../events/sse.js";
import type { PersistenceRepository } from "../../persistence/index.js";
import type { ClaudeRuntimeManager } from "../../runtime/claude-runtime.js";
import { HttpError, readJsonBody, sendJson } from "../core.js";
import { inputBoolean, inputEnum, inputString, objectBody, optionalQuery, queryInteger } from "../validation.js";
import type { RouteDefinition, RouteRequest } from "./shared.js";
import { routeId } from "./shared.js";

const STATUSES: readonly SessionStatus[] = ["idle", "queued", "running", "compacting", "waiting_permission", "completed", "failed", "stopped", "interrupted"];
const ACTIVE = new Set<SessionStatus>(["queued", "running", "compacting", "waiting_permission"]);

export interface SessionRoutesOptions {
  repository: PersistenceRepository;
  runtime: ClaudeRuntimeManager;
  events: SseHub;
  maxBodySize: number;
  now: () => number;
  audit: (userId: string | null, action: string, targetType: string, targetId: string, metadata: JsonObject) => void;
  toSessionDto: (session: ConversationSession) => Record<string, unknown>;
  sessionAudience: (session: ConversationSession) => string[];
  teamAudience: (teamId: string) => string[];
}

export class SessionRoutes {
  readonly definitions: readonly RouteDefinition[];

  constructor(private readonly options: SessionRoutesOptions) {
    this.definitions = [
      { method: "GET", path: "/api/sessions", handle: (input) => this.listSessions(input) },
      { method: "POST", path: /^\/api\/teams\/([^/]+)\/sessions$/, handle: (input) => this.createSession(input) },
      { method: "GET", path: /^\/api\/sessions\/([^/]+)\/messages$/, handle: (input) => this.listMessages(input) },
      { method: "POST", path: /^\/api\/sessions\/([^/]+)\/messages$/, handle: (input) => this.sendMessage(input) },
      { method: "POST", path: /^\/api\/sessions\/([^/]+)\/retry$/, handle: (input) => this.retrySession(input) },
      { method: "POST", path: /^\/api\/sessions\/([^/]+)\/stop$/, handle: (input) => this.stopSession(input) },
      { method: "PATCH", path: /^\/api\/sessions\/([^/]+)\/visibility$/, handle: (input) => this.updateVisibility(input) },
      { method: "DELETE", path: /^\/api\/sessions\/([^/]+)\/tool-approvals$/, handle: (input) => this.removeApproval(input) },
      { method: "PATCH", path: /^\/api\/sessions\/([^/]+)$/, handle: (input) => this.updateSession(input) },
      { method: "DELETE", path: /^\/api\/sessions\/([^/]+)$/, handle: (input) => this.deleteSession(input) },
      { method: "POST", path: /^\/api\/permissions\/([^/]+)\/(approve|reject)$/, handle: (input) => this.decidePermission(input) },
    ];
  }

  private listSessions({ response, url, auth }: RouteRequest): void {
    const teamId = inputString(url.searchParams.get("teamId"), "teamId", 1, 128);
    if (!canSeeTeam(this.options.repository, auth.user, teamId)) throw forbidden();
    const limit = queryInteger(url, "limit", 60, 1, 200);
    const cursor = optionalQuery(url, "cursor", 1_024) ?? null;
    const query = optionalQuery(url, "q", 500)?.trim() ?? "";
    const rawStatus = url.searchParams.get("status");
    const statuses = rawStatus ? [inputEnum(rawStatus, STATUSES, "status")] : undefined;
    const createdBy = optionalQuery(url, "createdBy", 128);
    const archived = url.searchParams.get("archived") || "active";
    if (!["active", "archived", "all"].includes(archived)) throw new HttpError(400, "INVALID_INPUT", "archived 参数不正确。");
    if (createdBy && !this.options.repository.getUser(createdBy)) throw new HttpError(400, "INVALID_INPUT", "createdBy 用户不存在。");
    const visibleToUserId = canManageTeam(this.options.repository, auth.user, teamId) ? undefined : auth.user.id;
    const request = {
      teamIds: [teamId], includeArchived: archived !== "active", limit, cursor,
      ...(archived === "archived" ? { archivedOnly: true } : {}),
      ...(createdBy ? { createdBy } : {}), ...(statuses ? { statuses } : {}), ...(visibleToUserId ? { visibleToUserId } : {}),
    };
    const page = query ? this.options.repository.searchSessions({ ...request, query }) : this.options.repository.listSessions(request);
    const sessions = page.items.filter((session) => canSeeSession(this.options.repository, auth.user, session)
      && (!statuses || statuses.includes(session.status))
      && (!createdBy || session.createdBy === createdBy)
      && (archived === "all" || (archived === "archived" ? session.archivedAt !== null : session.archivedAt === null)));
    sendJson(response, 200, { sessions: sessions.map(this.options.toSessionDto), nextCursor: page.nextCursor });
  }

  private listMessages({ response, url, auth, match }: RouteRequest): void {
    const session = this.requireSession(routeId(match, 1));
    if (!canSeeSession(this.options.repository, auth.user, session)) throw forbidden();
    const page = this.options.repository.listMessages(session.id, { limit: queryInteger(url, "limit", 80, 1, 200), cursor: optionalQuery(url, "cursor", 1_024) ?? null });
    sendJson(response, 200, { messages: page.items, nextCursor: page.nextCursor, permissions: this.options.repository.listPermissions(session.id), fileChanges: this.options.repository.listFileChanges(session.id) });
  }

  private async createSession({ request, response, auth, match }: RouteRequest): Promise<void> {
    const teamId = routeId(match, 1);
    const team = this.options.repository.getTeam(teamId);
    if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "团队不存在。");
    const role = this.options.repository.getTeamRole(teamId, auth.user.id);
    if (!canSeeTeam(this.options.repository, auth.user, teamId) || (!role && !isSystemAdmin(auth.user)) || (!isSystemAdmin(auth.user) && role === "viewer")) throw forbidden();
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
    const agent = agentId ? this.options.repository.getAgent(agentId) : this.options.repository.listAgents([teamId]).find((item) => item.teamId === teamId || item.teamId === null);
    if (!agent || !agent.enabled || (agent.teamId !== null && agent.teamId !== teamId)) throw new HttpError(409, "AGENT_UNAVAILABLE", "团队没有可用的 Agent。");
    const at = this.options.now();
    const session: ConversationSession = {
      id: createId("session"), teamId, agentId: agent.id, createdBy: auth.user.id,
      title: typeof body.title === "string" ? inputString(body.title, "title", 1, 100) : "新会话",
      summary: null, summaryUpdatedAt: null, visibility: "private", status: "idle", cwd: team.workspacePath,
      claudeSessionId: null, toolApprovals: { onceTools: [], alwaysTools: [], alwaysServers: [] }, archivedAt: null, pinnedAt: null, createdAt: at, updatedAt: at,
    };
    this.options.repository.createSession(session);
    this.options.audit(auth.user.id, "session.created", "session", session.id, { teamId });
    this.options.events.publish({ type: "session.created", session: this.options.toSessionDto(session), teamId, sessionId: session.id }, this.options.sessionAudience(session));
    sendJson(response, 201, { session: this.options.toSessionDto(session) });
  }

  private async sendMessage({ request, response, auth, match }: RouteRequest): Promise<void> {
    const session = this.requireSession(routeId(match, 1));
    if (!canAskSession(this.options.repository, auth.user, session)) throw forbidden();
    if (session.archivedAt !== null) throw new HttpError(409, "SESSION_ARCHIVED", "请先恢复会话再发送消息。");
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    const content = inputString(body.content, "content", 1, 200_000);
    const mode = inputEnum(body.mode ?? "send", ["send", "guide", "interrupt"] as const, "mode");
    if (mode !== "send") {
      if (!ACTIVE.has(session.status)) throw new HttpError(409, "SESSION_NOT_RUNNING", "当前会话没有可引导的运行任务。");
      if (mode === "interrupt") await this.options.runtime.interrupt(session.id);
      if (!this.options.runtime.sendGuidance(session.id, content, mode === "interrupt" ? "now" : "next")) throw new HttpError(409, "RUNTIME_NOT_ACTIVE", "运行任务尚未就绪，请稍后重试。");
      const message = this.appendUserMessage(session, auth.user, content, { guidance: true, interrupt: mode === "interrupt" });
      this.options.events.publish({ type: "session.message.created", sessionId: session.id, message }, this.options.sessionAudience(session));
      sendJson(response, 202, { accepted: true, message });
      return;
    }
    if (this.options.repository.getActiveTurn(session.id)) throw new HttpError(409, "SESSION_ALREADY_ACTIVE", "会话已有任务正在运行。");
    const scheduled = await this.options.runtime.submit({ sessionId: session.id, teamId: session.teamId, userId: auth.user.id, prompt: content });
    const message = this.appendUserMessage(session, auth.user, content, { turnId: scheduled.id });
    if (session.title === "新会话") {
      const updated = { ...this.requireSession(session.id), title: titleFromPrompt(content), updatedAt: this.options.now() };
      this.options.repository.saveSession(updated);
      this.options.events.publish({ type: "session.updated", sessionId: session.id, session: this.options.toSessionDto(updated) }, this.options.sessionAudience(updated));
    }
    this.options.events.publish({ type: "session.message.created", sessionId: session.id, message }, this.options.sessionAudience(session));
    sendJson(response, 202, { accepted: true, turnId: scheduled.id, message });
  }

  private async retrySession({ request, response, auth, match }: RouteRequest): Promise<void> {
    const session = this.requireSession(routeId(match, 1));
    if (!canAskSession(this.options.repository, auth.user, session)) throw forbidden();
    if (session.archivedAt !== null) throw new HttpError(409, "SESSION_ARCHIVED", "请先恢复会话再重试消息。");
    if (this.options.repository.getActiveTurn(session.id)) throw new HttpError(409, "SESSION_ALREADY_ACTIVE", "会话已有任务正在运行。");
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    const requestedId = body.messageId === undefined ? null : inputString(body.messageId, "messageId", 1, 128);
    const source = requestedId ? this.options.repository.getMessage(requestedId) : this.options.repository.listMessages(session.id, { limit: 200 }).items.find((message) => message.senderType === "user" && !message.metadata.guidance);
    if (source && (source.sessionId !== session.id || source.senderType !== "user" || source.metadata.guidance)) throw new HttpError(409, "MESSAGE_NOT_RETRYABLE", "所选消息不能用于重试。");
    if (!source) throw new HttpError(409, "MESSAGE_NOT_RETRYABLE", "没有可重试的用户消息。");
    const scheduled = await this.options.runtime.submit({ sessionId: session.id, teamId: session.teamId, userId: auth.user.id, prompt: source.content, retryOfMessageId: source.id });
    const message = this.appendUserMessage(session, auth.user, source.content, { turnId: scheduled.id, retryOfMessageId: source.id });
    this.options.events.publish({ type: "session.message.created", sessionId: session.id, message }, this.options.sessionAudience(session));
    sendJson(response, 202, { accepted: true, turnId: scheduled.id, message });
  }

  private stopSession({ response, auth, match }: RouteRequest): void {
    const session = this.requireSession(routeId(match, 1));
    if (!canWriteSession(this.options.repository, auth.user, session)) throw forbidden();
    if (!this.options.runtime.stop(session.id, `Stopped by ${auth.user.username}.`)) throw new HttpError(409, "SESSION_NOT_RUNNING", "会话当前没有运行任务。");
    this.options.audit(auth.user.id, "session.stopped", "session", session.id, {});
    sendJson(response, 202, { accepted: true });
  }

  private async updateVisibility({ request, response, auth, match }: RouteRequest): Promise<void> {
    const session = this.requireSession(routeId(match, 1));
    if (!canWriteSession(this.options.repository, auth.user, session)) throw forbidden();
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    const previous = new Set(this.options.sessionAudience(session));
    const updated = { ...session, visibility: inputEnum(body.visibility, ["private", "team"] as const, "visibility"), updatedAt: this.options.now() };
    this.options.repository.saveSession(updated);
    this.options.audit(auth.user.id, "session.visibility_changed", "session", session.id, { visibility: updated.visibility });
    const current = this.options.sessionAudience(updated);
    this.options.events.publish({ type: "session.updated", sessionId: session.id, session: this.options.toSessionDto(updated) }, current);
    const removed = [...previous].filter((id) => !current.includes(id));
    if (removed.length) this.options.events.publish({ type: "session.deleted", sessionId: session.id, teamId: session.teamId }, removed);
    sendJson(response, 200, { session: this.options.toSessionDto(updated) });
  }

  private async updateSession({ request, response, auth, match }: RouteRequest): Promise<void> {
    const session = this.requireSession(routeId(match, 1));
    if (!canWriteSession(this.options.repository, auth.user, session)) throw forbidden();
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    const archived = inputBoolean(body.archived, "archived");
    if (archived && ACTIVE.has(session.status)) throw new HttpError(409, "SESSION_ACTIVE", "运行中的会话不能归档。");
    const updated = { ...session, archivedAt: archived ? this.options.now() : null, updatedAt: this.options.now() };
    this.options.repository.saveSession(updated);
    this.options.audit(auth.user.id, archived ? "session.archived" : "session.unarchived", "session", session.id, {});
    this.options.events.publish({ type: "session.updated", sessionId: session.id, session: this.options.toSessionDto(updated) }, this.options.sessionAudience(updated));
    sendJson(response, 200, { session: this.options.toSessionDto(updated) });
  }

  private async removeApproval({ request, response, auth, match }: RouteRequest): Promise<void> {
    const session = this.requireSession(routeId(match, 1));
    if (!canWriteSession(this.options.repository, auth.user, session)) throw forbidden();
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    const scope = inputEnum(body.scope, ["tool", "server"] as const, "scope");
    const value = inputString(body.value, "value", 1, 512);
    const updated = { ...session, toolApprovals: {
      onceTools: session.toolApprovals.onceTools.filter((item) => !(scope === "tool" && item === value)),
      alwaysTools: session.toolApprovals.alwaysTools.filter((item) => !(scope === "tool" && item === value)),
      alwaysServers: session.toolApprovals.alwaysServers.filter((item) => !(scope === "server" && item === value)),
    }, updatedAt: this.options.now() };
    this.options.repository.saveSession(updated);
    this.options.audit(auth.user.id, "session.tool_approval_removed", "session", session.id, { scope, value });
    this.options.events.publish({ type: "session.updated", sessionId: session.id, session: this.options.toSessionDto(updated) }, this.options.sessionAudience(updated));
    sendJson(response, 200, { session: this.options.toSessionDto(updated) });
  }

  private deleteSession({ response, auth, match }: RouteRequest): void {
    const session = this.requireSession(routeId(match, 1));
    if (!canWriteSession(this.options.repository, auth.user, session)) throw forbidden();
    if (ACTIVE.has(session.status) || this.options.repository.getActiveTurn(session.id)) throw new HttpError(409, "SESSION_ACTIVE", "请先停止运行任务再删除会话。");
    const audience = this.options.sessionAudience(session);
    this.options.repository.deleteSession(session.id);
    this.options.audit(auth.user.id, "session.deleted", "session", session.id, { teamId: session.teamId });
    this.options.events.publish({ type: "session.deleted", sessionId: session.id, teamId: session.teamId }, audience);
    sendJson(response, 200, { ok: true });
  }

  private async decidePermission({ request, response, auth, match }: RouteRequest): Promise<void> {
    const permission = this.options.repository.getPermission(routeId(match, 1));
    if (!permission) throw new HttpError(404, "PERMISSION_NOT_FOUND", "权限请求不存在。");
    const session = this.requireSession(permission.sessionId);
    if (!canApprovePermission(this.options.repository, auth.user, session, permission)) throw forbidden();
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    const action = match?.[2];
    const decision = normalizeDecision(action === "reject" ? "rejected" : body.decision, permission.type);
    const result = await this.options.runtime.decidePermission(permission.id, decision, auth.user.id);
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : result.reason === "expired" ? 410 : 409;
      throw new HttpError(status, `PERMISSION_${result.reason.toUpperCase()}`, permissionMessage(result.reason));
    }
    this.options.audit(auth.user.id, "permission.decided", "permission", permission.id, { decision });
    sendJson(response, 200, { permission: result.permission });
  }

  private appendUserMessage(session: ConversationSession, user: User, content: string, metadata: JsonObject): Message {
    const message: Message = { id: createId("message"), sessionId: session.id, senderType: "user", senderId: user.id, content, metadata, createdAt: this.options.now(), updatedAt: null };
    this.options.repository.appendMessage(message);
    return message;
  }

  private requireSession(id: string): ConversationSession {
    const session = this.options.repository.getSession(id);
    if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "会话不存在。");
    return session;
  }
}

function titleFromPrompt(prompt: string): string {
  const line = prompt.split(/\r?\n/).find((item) => item.trim())?.trim() || "新会话";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

function normalizeDecision(value: unknown, type: "platform_gate" | "mcp_tool"): PermissionDecision {
  if (type === "platform_gate" && value === "approved") return "allow_once";
  return inputEnum(value, ["allow_once", "allow_always_tool", "allow_always_server", "rejected"] as const, "decision");
}

function permissionMessage(reason: string): string {
  if (reason === "expired") return "权限请求已过期。";
  if (reason === "already_decided") return "权限请求已被处理。";
  if (reason === "runtime_missing") return "Claude Code 已不再等待此权限，请刷新会话状态。";
  return "权限请求不存在。";
}

function forbidden(): HttpError { return new HttpError(403, "FORBIDDEN", "你没有执行此操作的权限。"); }

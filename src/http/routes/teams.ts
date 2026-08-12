import { canManageTeam, canSeeTeam, createId, isSystemAdmin, type Agent, type ConversationSession, type JsonObject, type Team, type TeamMember, type User } from "../../domain/index.js";
import type { RealtimeEvent, SseHub } from "../../events/sse.js";
import type { PersistenceRepository } from "../../persistence/index.js";
import { HttpError, readJsonBody, sendJson } from "../core.js";
import { inputEnum, inputString, objectBody } from "../validation.js";
import type { RouteDefinition, RouteRequest } from "./shared.js";
import { routeId } from "./shared.js";

export interface TeamRoutesOptions {
  repository: PersistenceRepository;
  events: SseHub;
  maxBodySize: number;
  claudeCommand: string;
  now: () => number;
  prepareWorkspace: (path: string) => Promise<string>;
  audit: (userId: string | null, action: string, targetType: string, targetId: string, metadata: JsonObject) => void;
}

export class TeamRoutes {
  readonly definitions: readonly RouteDefinition[];

  constructor(private readonly options: TeamRoutesOptions) {
    this.definitions = [
      { method: "POST", path: "/api/teams", handle: (input) => this.createTeam(input) },
      { method: "PATCH", path: /^\/api\/teams\/([^/]+)$/, handle: (input) => this.updateTeam(input) },
      { method: "DELETE", path: /^\/api\/teams\/([^/]+)$/, handle: (input) => this.deleteTeam(input) },
      { method: "POST", path: /^\/api\/teams\/([^/]+)\/members$/, handle: (input) => this.saveMember(input) },
      { method: "DELETE", path: /^\/api\/teams\/([^/]+)\/members\/([^/]+)$/, handle: (input) => this.removeMember(input) },
    ];
  }

  private async createTeam({ request, response, auth }: RouteRequest): Promise<void> {
    if (!isSystemAdmin(auth.user)) throw forbidden();
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    const createdAt = this.options.now();
    const team: Team = {
      id: createId("team"),
      name: inputString(body.name, "name", 2, 80),
      workspacePath: await this.options.prepareWorkspace(inputString(body.workspacePath, "workspacePath", 1, 1_024)),
      workspaceMode: "shared",
      runtimeDefaults: {},
      createdBy: auth.user.id,
      createdAt,
      updatedAt: createdAt,
    };
    const member: TeamMember = { teamId: team.id, userId: auth.user.id, role: "owner", createdAt, updatedAt: createdAt };
    const agent: Agent = { id: createId("agent"), teamId: team.id, name: "Claude Code", type: "claude_code", command: this.options.claudeCommand, enabled: true, status: "idle", metadata: {}, createdAt, updatedAt: createdAt };
    this.options.repository.transaction(() => {
      this.options.repository.saveTeam(team);
      this.options.repository.saveTeamMember(member);
      this.options.repository.saveAgent(agent);
      this.options.audit(auth.user.id, "team.created", "team", team.id, { name: team.name });
    });
    this.options.events.publish({ type: "team.created", team, member, agent }, this.adminAudience());
    sendJson(response, 201, { team, member, agent });
  }

  private async updateTeam({ request, response, auth, match }: RouteRequest): Promise<void> {
    const team = this.requireTeam(routeId(match, 1));
    if (!canManageTeam(this.options.repository, auth.user, team.id)) throw forbidden();
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    const updated = {
      ...team,
      name: body.name === undefined ? team.name : inputString(body.name, "name", 2, 80),
      workspacePath: body.workspacePath === undefined ? team.workspacePath : await this.options.prepareWorkspace(inputString(body.workspacePath, "workspacePath", 1, 1_024)),
      workspaceMode: body.workspaceMode === undefined ? team.workspaceMode : inputEnum(body.workspaceMode, ["shared", "isolated"] as const, "workspaceMode"),
      updatedAt: this.options.now(),
    };
    this.options.repository.saveTeam(updated);
    this.options.audit(auth.user.id, "team.updated", "team", team.id, {});
    this.options.events.publish({ type: "team.updated", team: updated, teamId: team.id }, this.teamAudience(team.id));
    sendJson(response, 200, { team: updated });
  }

  private deleteTeam({ response, auth, match }: RouteRequest): void {
    const team = this.requireTeam(routeId(match, 1));
    if (!isSystemAdmin(auth.user)) throw forbidden();
    const active = this.allSessions(team.id).find((session) => ["queued", "running", "compacting", "waiting_permission"].includes(session.status));
    if (active) throw new HttpError(409, "TEAM_ACTIVE", "团队仍有运行中的会话，请先停止后再删除。");
    const audience = this.teamAudience(team.id);
    this.options.repository.deleteTeam(team.id);
    this.options.audit(auth.user.id, "team.deleted", "team", team.id, { name: team.name });
    this.options.events.publish({ type: "team.deleted", teamId: team.id }, audience);
    sendJson(response, 200, { ok: true });
  }

  private async saveMember({ request, response, auth, match }: RouteRequest): Promise<void> {
    const teamId = routeId(match, 1);
    this.requireTeam(teamId);
    if (!canManageTeam(this.options.repository, auth.user, teamId)) throw forbidden();
    const body = objectBody(await readJsonBody(request, this.options.maxBodySize));
    const userId = inputString(body.userId, "userId", 1, 128);
    const role = inputEnum(body.role, ["owner", "admin", "member", "viewer"] as const, "role");
    const requesterRole = this.options.repository.getTeamRole(teamId, auth.user.id);
    if (role === "owner" && !isSystemAdmin(auth.user) && requesterRole !== "owner") throw forbidden("只有 owner 可以授予 owner 角色。");
    const target = this.options.repository.getUser(userId);
    if (!target || target.status !== "active") throw new HttpError(404, "USER_NOT_FOUND", "用户不存在或已停用。");
    const existing = this.options.repository.getTeamRole(teamId, userId);
    if (existing === "owner" && role !== "owner") {
      if (!isSystemAdmin(auth.user) && requesterRole !== "owner") throw forbidden("团队管理员不能降级 owner。");
      if (this.options.repository.listTeamMembers(teamId).filter((member) => member.role === "owner").length <= 1) throw new HttpError(409, "LAST_OWNER", "团队必须至少保留一位 owner。");
    }
    const at = this.options.now();
    const member: TeamMember = { teamId, userId, role, createdAt: at, updatedAt: at };
    this.options.repository.saveTeamMember(member);
    this.options.audit(auth.user.id, existing ? "team.member_updated" : "team.member_added", "team", teamId, { userId, role });
    this.options.events.publish({ type: "team.member_updated", teamId, member }, this.teamAudience(teamId));
    sendJson(response, existing ? 200 : 201, { member });
  }

  private removeMember({ response, auth, match }: RouteRequest): void {
    const teamId = routeId(match, 1);
    const userId = routeId(match, 2);
    this.requireTeam(teamId);
    if (!canManageTeam(this.options.repository, auth.user, teamId)) throw forbidden();
    const role = this.options.repository.getTeamRole(teamId, userId);
    if (!role) throw new HttpError(404, "MEMBER_NOT_FOUND", "团队成员不存在。");
    const requesterRole = this.options.repository.getTeamRole(teamId, auth.user.id);
    if (role === "owner" && !isSystemAdmin(auth.user) && requesterRole !== "owner") throw forbidden("团队管理员不能移除 owner。");
    if (role === "owner" && this.options.repository.listTeamMembers(teamId).filter((member) => member.role === "owner").length <= 1) throw new HttpError(409, "LAST_OWNER", "不能移除团队的最后一位 owner。");
    const audience = this.teamAudience(teamId);
    this.options.repository.removeTeamMember(teamId, userId);
    this.options.audit(auth.user.id, "team.member_removed", "team", teamId, { userId });
    this.options.events.publish({ type: "team.member_removed", teamId, userId }, audience);
    sendJson(response, 200, { ok: true });
  }

  private requireTeam(id: string): Team {
    const team = this.options.repository.getTeam(id);
    if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "团队不存在。");
    return team;
  }

  private teamAudience(teamId: string): string[] {
    return this.options.repository.listUsers().filter((user) => user.status === "active" && canSeeTeam(this.options.repository, user, teamId)).map((user) => user.id);
  }

  private adminAudience(): string[] {
    return this.options.repository.listUsers().filter((user) => user.status === "active" && isSystemAdmin(user)).map((user) => user.id);
  }

  private allSessions(teamId: string): ConversationSession[] {
    const sessions: ConversationSession[] = [];
    let cursor: string | null = null;
    do {
      const page = this.options.repository.listSessions({ teamIds: [teamId], includeArchived: true, limit: 200, cursor });
      sessions.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return sessions;
  }
}

function forbidden(message = "你没有执行此操作的权限。"): HttpError {
  return new HttpError(403, "FORBIDDEN", message);
}

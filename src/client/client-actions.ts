import type { AppState, Permission, Session, Team } from "./types.js";
import { api } from "./api.js";
import { createLiveState } from "./live-state.js";

export interface ClientActionDeps {
  state(): AppState;
  refresh(): Promise<void>;
  renderLogin(error?: string): void;
  setActiveModal(value: string): void;
  upsertById<T extends { id: string }>(items: T[], item: T): T[];
  scheduleTeamRender(parts: { rail?: boolean; chat?: boolean; right?: boolean }, delay?: number): void;
  scheduleRender(): void;
  render(): void;
  sessionById(id?: string): Session | undefined;
  canApprove(permission: Permission): boolean;
  isSystemAdmin(): boolean;
  sortSessionsNewestFirst(sessions: Session[]): Session[];
  canManageTeam(teamId: string): boolean;
  canManageSession(session?: Session): boolean;
  sessionVisibility(session?: Session): string;
  normalizeSelectedSession(): void;
  syncLocation(): void;
  toast(message: string, tone?: "success" | "error" | "info"): void;
  uiMemory: { composerDrafts: Map<string, string> };
}

export function createClientActions(deps: ClientActionDeps) {
  const state = createLiveState(deps.state);
  const { refresh, renderLogin, setActiveModal, upsertById, scheduleTeamRender, sessionById, canApprove,
    isSystemAdmin, sortSessionsNewestFirst, canManageTeam, canManageSession, sessionVisibility,
    normalizeSelectedSession, syncLocation, toast, uiMemory, scheduleRender, render } = deps;

async function login(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const username = String(data.get("username") || "").trim();
  const password = String(data.get("password") || "");
  try {
    await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
    state.activeView = "teams";
    await refresh();
  } catch (err) {
    renderLogin(err instanceof Error ? err.message : "用户名或密码不正确");
  }
}

async function createTeam(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const payload = {
    name: String(data.get("name")),
    workspacePath: String(data.get("workspacePath")),
  };
  const result = await api<{ team: Team }>("/api/teams", { method: "POST", body: JSON.stringify(payload) });
  setActiveModal("");
  state.selectedTeamId = result.team.id;
  state.activeView = "team";
  await refresh();
}

async function createSession(): Promise<void> {
  const team = state.teams.find((item) => item.id === state.selectedTeamId);
  if (!team) throw new Error("团队不存在");
  const result = await api<{ session: Session }>(`/api/teams/${team.id}/sessions`, { method: "POST", body: "{}" });
  state.selectedSessionId = result.session.id;
  state.sessions = upsertById(state.sessions, result.session);
  state.messagePagination[result.session.id] = { nextCursor: null, loading: false, initialized: true };
  syncLocation();
  scheduleTeamRender({ rail: true, chat: true, right: true }, 0);
  window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(`[data-session-draft="${CSS.escape(result.session.id)}"]`)?.focus(), 0);
}

async function sendMessage(form: HTMLFormElement, submitter: HTMLButtonElement | null = null): Promise<void> {
  const session = sessionById(state.selectedSessionId);
  const content = String(new FormData(form).get("content") || "").trim();
  if (!session) throw new Error("新会话尚未准备完成，请重试。");
  if (!content) throw new Error("请输入消息后再发送。");
  const mode = submitter?.value || "send";
  await api(`/api/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ content, mode }) });
  uiMemory.composerDrafts.delete(session.id);
  form.reset();
}

async function decidePermission(id: string, decision: string): Promise<void> {
  const permission = state.permissions.find((item) => item.id === id);
  if (!permission || !canApprove(permission)) return;
  const action = decision === "rejected" ? "reject" : "approve";
  await api(`/api/permissions/${id}/${action}`, { method: "POST", body: JSON.stringify({ decision }) });
}

async function deleteSession(id: string): Promise<void> {
  const session = sessionById(id);
  if (!session) return;
  if (!confirm(`删除会话「${session.title}」？此操作会同时删除消息和权限记录。`)) return;
  await api(`/api/sessions/${id}`, { method: "DELETE" });
  if (state.selectedSessionId === id) {
    const next = sortSessionsNewestFirst(state.sessions.filter((item) => item.teamId === session.teamId && item.id !== id))[0];
    state.selectedSessionId = next?.id || "";
  }
  state.sessions = state.sessions.filter((item) => item.id !== id);
  state.messages = state.messages.filter((message) => message.sessionId !== id);
  state.permissions = state.permissions.filter((permission) => permission.sessionId !== id);
  scheduleTeamRender({ rail: true, chat: true, right: true }, 0);
}

async function deleteTeam(id: string): Promise<void> {
  const team = state.teams.find((item) => item.id === id);
  if (!team || !isSystemAdmin()) return;
  if (!confirm(`删除团队「${team.name}」？此操作会删除该团队的成员、会话、消息和权限记录。`)) return;
  await api(`/api/teams/${id}`, { method: "DELETE" });
  const sessionIds = new Set(state.sessions.filter((session) => session.teamId === id).map((session) => session.id));
  state.teams = state.teams.filter((item) => item.id !== id);
  state.members = state.members.filter((member) => member.teamId !== id);
  state.agents = state.agents.filter((agent) => agent.teamId !== id);
  state.sessions = state.sessions.filter((session) => session.teamId !== id);
  state.messages = state.messages.filter((message) => !sessionIds.has(message.sessionId));
  state.permissions = state.permissions.filter((permission) => !sessionIds.has(permission.sessionId));
  if (state.selectedTeamId === id) {
    state.selectedTeamId = state.teams[0]?.id || "";
    state.selectedSessionId = "";
    state.activeView = "teams";
  }
  scheduleRender();
}

async function removeMember(teamId: string, userId: string): Promise<void> {
  if (!canManageTeam(teamId)) return;
  const user = state.users.find((item) => item.id === userId);
  if (!confirm(`从团队中移除「${user?.displayName || user?.username || userId}」？`)) return;
  await api(`/api/teams/${teamId}/members/${userId}`, { method: "DELETE" });
  state.members = state.members.filter((member) => !(member.teamId === teamId && member.userId === userId));
  render();
}

async function toggleSessionVisibility(): Promise<void> {
  const session = sessionById(state.selectedSessionId);
  if (!session || !canManageSession(session)) return;
  const nextVisibility = sessionVisibility(session) === "team" ? "private" : "team";
  const result = await api<{ session: Session }>(`/api/sessions/${session.id}/visibility`, { method: "PATCH", body: JSON.stringify({ visibility: nextVisibility }) });
  state.sessions = upsertById(state.sessions, result.session);
  scheduleTeamRender({ rail: true, chat: true, right: true }, 0);
}

async function toggleSessionArchive(): Promise<void> {
  const session = sessionById(state.selectedSessionId);
  if (!session || !canManageSession(session)) return;
  const archived = !Boolean(session.archived || session.archivedAt);
  const result = await api<{ session: Session }>(`/api/sessions/${session.id}`, {
    method: "PATCH",
    body: JSON.stringify({ archived }),
  });
  state.sessions = upsertById(state.sessions, result.session);
  if (state.sessionArchiveFilter === "active" && archived) normalizeSelectedSession();
  syncLocation();
  scheduleTeamRender({ rail: true, chat: true, right: true }, 0);
  toast(archived ? "会话已归档" : "会话已恢复", "success");
}

async function removeToolApproval(scope: string, value: string): Promise<void> {
  const session = sessionById(state.selectedSessionId);
  if (!session) return;
  const result = await api<{ session: Session }>(`/api/sessions/${session.id}/tool-approvals`, { method: "DELETE", body: JSON.stringify({ scope, value }) });
  state.sessions = upsertById(state.sessions, result.session);
  scheduleTeamRender({ chat: true, right: true }, 0);
}

async function retrySession(messageId?: string): Promise<void> {
  const session = sessionById(state.selectedSessionId);
  if (!session || session.archived || session.archivedAt) return;
  await api(`/api/sessions/${session.id}/retry`, { method: "POST", body: JSON.stringify({ messageId }) });
  await refresh();
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

async function createUser(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const username = String(data.get("username")).trim();
  const payload = {
    username,
    password: String(data.get("password") || ""),
    displayName: String(data.get("displayName")).trim(),
    email: String(data.get("email") || "").trim(),
    role: String(data.get("role")),
  };
  await api("/api/users", { method: "POST", body: JSON.stringify(payload) });
  setActiveModal("");
  form.reset();
  await refresh();
}

async function updateUserRole(userId: string, role: string): Promise<void> {
  await api(`/api/users/${encodeURIComponent(userId)}/role`, { method: "PATCH", body: JSON.stringify({ role }) });
  toast("用户角色已更新，原登录态已注销", "success");
  await refresh();
}

async function saveDirectoryPermissions(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const directories = ["teams", ...(data.get("lineage") === "on" ? ["lineage"] : [])];
  await api("/api/admin/directory-permissions/member", { method: "PATCH", body: JSON.stringify({ directories }) });
  toast("Member 目录权限已更新", "success");
  await refresh();
}

async function changeOwnPassword(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const newPassword = String(data.get("newPassword") || "");
  const confirmPassword = String(data.get("confirmPassword") || "");
  if (newPassword !== confirmPassword) throw new Error("两次输入的新密码不一致");
  await api("/api/auth/password", {
    method: "PATCH",
    body: JSON.stringify({
      currentPassword: String(data.get("currentPassword") || ""),
      newPassword,
    }),
  });
  setActiveModal("");
  form.reset();
  await refresh();
}

async function resetUserPassword(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  await api(`/api/users/${form.dataset.userId}/password`, {
    method: "PATCH",
    body: JSON.stringify({ newPassword: String(data.get("newPassword") || "") }),
  });
  form.reset();
  await refresh();
}

async function addMember(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const teamId = form.dataset.team;
  await api(`/api/teams/${teamId}/members`, { method: "POST", body: JSON.stringify({ userId: String(data.get("userId")), role: String(data.get("role")) }) });
  await refresh();
}

async function saveConfig(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  await api("/api/claude/config", {
    method: "PATCH",
    body: JSON.stringify({
      command: String(data.get("command")).trim() || "claude",
      args: String(data.get("args")).trim(),
      workspaceRoot: String(data.get("workspaceRoot")).trim(),
      modelContextTokens: Number(data.get("modelContextTokens") || 1000000),
      autoCompactRatio: Number(data.get("autoCompactRatio") || 0.62),
      autoCompactEnabled: data.get("autoCompactEnabled") === "on",
      mcpToolAllowlist: String(data.get("mcpToolAllowlist") || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean),
    }),
  });
  await refresh();
}

async function saveWorkspace(form: HTMLFormElement): Promise<void> {
  const teamId = form.dataset.team;
  const data = new FormData(form);
  await api(`/api/teams/${teamId}`, {
    method: "PATCH",
    body: JSON.stringify({ workspacePath: String(data.get("workspacePath")).trim() }),
  });
  setActiveModal("");
  await refresh();
}
  return {
    login, createTeam, createSession, sendMessage, decidePermission, deleteSession, deleteTeam, removeMember,
    toggleSessionVisibility, toggleSessionArchive, removeToolApproval, retrySession, copyText, createUser,
    changeOwnPassword, resetUserPassword, updateUserRole, saveDirectoryPermissions, addMember, saveConfig, saveWorkspace,
  };
}

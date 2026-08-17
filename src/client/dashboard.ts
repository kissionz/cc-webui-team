import type {
  Agent, AppState, AppView, HtmlValue, Permission, RealtimeEvent, Session, SessionStatus,
  SessionVisibility, TeamRole, Toast, User,
} from "./types.js";
import { ApiError, api, downloadApi } from "./api.js";
import { RealtimeConnection } from "./events.js";
import { createAdminViews } from "./admin-views.js";
import { createTeamViews } from "./team-views.js";
import { createClientActions } from "./client-actions.js";
import { createUiShell } from "./ui-shell.js";
import { createSessionStore } from "./session-store.js";
import { createAdminController } from "./admin-controller.js";
import { createAppShellViews } from "./app-shell-views.js";
import { renderMarkdown } from "./markdown.js";
import { escapeHtml } from "./render.js";
import { createLineageFeature } from "./lineage-feature.js";
const icons = {
  teams: '<svg class="icon" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  settings: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 0 1 7.03 3.84l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.37.35.7.6 1 .3.27.7.4 1.1.4H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z"/></svg>',
  users: '<svg class="icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  plus: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  stop: '<svg class="icon" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  send: '<svg class="icon" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/></svg>',
  check: '<svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  close: '<svg class="icon" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  logout: '<svg class="icon" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
  terminal: '<svg class="icon" viewBox="0 0 24 24"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>',
  activity: '<svg class="icon" viewBox="0 0 24 24"><path d="M22 12h-4l-3 8L9 4l-3 8H2"/></svg>',
  info: '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  panel: '<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
  lineage: '<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><path d="M9 6h6M6 9v3a6 6 0 0 0 6 6h3"/></svg>',
  chevron: '<svg class="icon" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
};

const now = (): number => Date.now();
const fmt = (timestamp: number): string => new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp);
const CHAT_RENDER_LIMIT = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

const seedState = (): AppState => ({
  currentUserId: null,
  activeView: "teams",
  selectedTeamId: "team_platform",
  selectedSessionId: "session_login",
  sidebarCollapsed: localStorage.getItem("cc.sidebarCollapsed") === "true",
  sessionMemberFilter: "all",
  sessionSearch: "",
  sessionStatusFilter: "all",
  sessionArchiveFilter: "active",
  teamRailOpen: false,
  rightRailOpen: false,
  mobileNavOpen: false,
  allowedDirectories: ["teams"],
  roleDirectoryPermissions: { admin: ["teams", "lineage", "system"], member: ["teams"] },
  users: [],
  teams: [],
  members: [],
  agents: [],
  sessions: [],
  messages: [],
  permissions: [],
  fileChanges: [],
  auditLogs: [],
  claudeConfig: {
    command: "claude",
    args: "",
    workspaceRoot: "/srv/workspaces",
    modelContextTokens: 1000000,
    autoCompactRatio: 0.62,
    autoCompactEnabled: true,
    mcpToolAllowlist: [],
    enabled: true,
    available: true,
    version: "1.0.74",
    latencyMs: 118,
    authenticated: true,
    lastCheckAt: now() - 1000 * 60 * 16,
  },
  serverInfo: {},
  toolInventory: { tools: [], servers: [] },
  sessionPagination: { nextCursor: null, loading: false, initialized: false },
  messagePagination: {},
  toasts: [],
});

let state: AppState = loadState();
let realtime: RealtimeConnection | null = null;
let refreshTimer: number | undefined;
let renderTimer: number | undefined;
let teamRenderTimer: number | undefined;
let messagePatchTimer: number | undefined;
const pendingTeamRender = { rail: false, chat: false, right: false };
const pendingMessagePatches = new Set<string>();
const pendingActions = new Set<string>();
let toastSequence = 0;
let sessionSearchTimer: number | undefined;
const selectedSessionIds = new Set<string>();
let adminViews: ReturnType<typeof createAdminViews>;
const uiMemory = {
  composerDrafts: new Map<string, string>(),
  openTurnEvents: new Map<string, boolean>(),
  openSessionGroups: new Map<string, boolean>(),
};

function loadState(): AppState {
  const base = seedState();
  applyLocationToState(base);
  return {
    ...base,
    currentUserId: null,
    users: [],
    teams: [],
    members: [],
    agents: [],
    sessions: [],
    messages: [],
    permissions: [],
    fileChanges: [],
    auditLogs: [],
    serverInfo: {},
    toolInventory: { tools: [], servers: [] },
  };
}

function applyLocationToState(target: AppState): void {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  if (view && ["teams", "team", "lineage", "settings", "sync", "users", "audit", "permissions"].includes(view)) target.activeView = view as AppView;
  if (params.get("team")) target.selectedTeamId = params.get("team") || "";
  if (params.get("session")) target.selectedSessionId = params.get("session") || "";
  target.sessionSearch = params.get("q") || "";
  const status = params.get("status");
  if (status && ["idle", "queued", "running", "compacting", "waiting_permission", "completed", "failed", "stopped", "interrupted"].includes(status)) {
    target.sessionStatusFilter = status as SessionStatus;
  }
  const archived = params.get("archived");
  if (archived === "all" || archived === "archived") target.sessionArchiveFilter = archived;
}

function syncLocation(mode: "push" | "replace" = "replace"): void {
  if (!state.currentUserId) return;
  const params = new URLSearchParams();
  params.set("view", state.activeView);
  if (state.activeView === "team" && state.selectedTeamId) params.set("team", state.selectedTeamId);
  if (state.activeView === "team" && state.selectedSessionId) params.set("session", state.selectedSessionId);
  if (state.sessionSearch) params.set("q", state.sessionSearch);
  if (state.sessionStatusFilter !== "all") params.set("status", state.sessionStatusFilter);
  if (state.sessionArchiveFilter !== "active") params.set("archived", state.sessionArchiveFilter);
  const url = `${window.location.pathname}?${params.toString()}`;
  window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", url);
}

function setState(patch: Partial<AppState>, historyMode: "push" | "replace" = "replace"): void {
  state = { ...state, ...patch };
  syncLocation(historyMode);
  render();
}

function toast(message: string, tone: Toast["tone"] = "info"): void {
  const item = { id: ++toastSequence, message, tone };
  state.toasts = [...state.toasts, item].slice(-4);
  renderToasts();
  window.setTimeout(() => {
    state.toasts = state.toasts.filter((candidate) => candidate.id !== item.id);
    renderToasts();
  }, tone === "error" ? 6500 : 3500);
}

function renderToasts(): void {
  let region = document.querySelector<HTMLElement>("#toast-region");
  if (!region) {
    region = document.createElement("div");
    region.id = "toast-region";
    region.className = "toast-region";
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "false");
    document.body.appendChild(region);
  }
  region.innerHTML = state.toasts.map((item) => `<div class="toast ${item.tone}" role="status">${escapeHtml(item.message)}</div>`).join("");
}

async function refresh(): Promise<void> {
  try {
    const data = await api<Partial<AppState>>("/api/bootstrap");
    state = { ...state, ...data, claudeConfig: data.claudeConfig || state.claudeConfig };
    normalizeSelection();
    if (isSystemAdmin()) void adminController.refreshData();
    if (state.activeView === "team" && state.selectedTeamId) {
      await loadSessions({ reset: true });
      if (state.selectedSessionId) await loadMessages(state.selectedSessionId, { reset: true });
    }
    if (state.activeView === "lineage" || state.activeView === "sync") await lineageFeature.load();
    syncLocation();
    render();
    connectEvents();
  } catch (error) {
    if (realtime) {
      realtime.close();
      realtime = null;
    }
    setState({ currentUserId: null });
    if (!(error instanceof ApiError && error.status === 401) && error instanceof Error) toast(error.message, "error");
  }
}

function normalizeSelection(): void {
  if (state.selectedTeamId && !state.teams.some((team) => team.id === state.selectedTeamId)) state.selectedTeamId = state.teams[0]?.id || "";
  const systemViews: AppView[] = ["settings", "sync", "users", "audit", "permissions"];
  if (systemViews.includes(state.activeView) && !state.allowedDirectories.includes("system")) state.activeView = "teams";
  if (state.activeView === "lineage" && !state.allowedDirectories.includes("lineage")) state.activeView = "teams";
  if (state.activeView === "team" && !state.selectedTeamId) state.activeView = "teams";
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(), 180);
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => render(), 80);
}

function scheduleTeamRender(parts: Partial<typeof pendingTeamRender>, delay = 120): void {
  if (state.activeView !== "team") {
    scheduleRender();
    return;
  }
  if (!parts.rail && !parts.chat && !parts.right) return;
  pendingTeamRender.rail ||= Boolean(parts.rail);
  pendingTeamRender.chat ||= Boolean(parts.chat);
  pendingTeamRender.right ||= Boolean(parts.right);
  clearTimeout(teamRenderTimer);
  teamRenderTimer = setTimeout(() => {
    const next = { ...pendingTeamRender };
    pendingTeamRender.rail = false;
    pendingTeamRender.chat = false;
    pendingTeamRender.right = false;
    renderTeamParts(next);
  }, delay);
}

function scheduleSessionScopedRender(sessionId: string | undefined, selectedParts: Partial<typeof pendingTeamRender>, otherParts: Partial<typeof pendingTeamRender> = { rail: true }, delay = 120): void {
  if (state.activeView !== "team") {
    scheduleRender();
    return;
  }
  scheduleTeamRender(sessionId === state.selectedSessionId ? selectedParts : otherParts, delay);
}

function scheduleMessagePatch(messageId: string, delay = 90): void {
  if (state.activeView !== "team") {
    scheduleRender();
    return;
  }
  pendingMessagePatches.add(messageId);
  clearTimeout(messagePatchTimer);
  messagePatchTimer = setTimeout(() => {
    const ids = [...pendingMessagePatches];
    pendingMessagePatches.clear();
    const needsChatRender = ids.some((id) => !patchVisibleMessage(id));
    if (needsChatRender) scheduleTeamRender({ chat: true }, 90);
  }, delay);
}

const sessionStore = createSessionStore({
  state: () => state,
  now,
  dayMs: DAY_MS,
  uiMemory,
  scheduleTeamRender,
});
const {
  loadSessions, normalizeSelectedSession, loadMessages, dedupeById, upsertById,
  sortSessionsNewestFirst, groupSessionsByTime, sessionGroupKey, isSessionGroupExpanded, upsertMember,
} = sessionStore;
const adminController = createAdminController({
  state: () => state,
  isAdmin: isSystemAdmin,
  selectedSessionIds,
  refresh,
  scheduleRender,
  scheduleTeamRender,
  toast,
});

function connectEvents(): void {
  if (realtime || !state.currentUserId) return;
  realtime = new RealtimeConnection({
    onEvent: applyRealtimeEvent,
    onResync: scheduleRefresh,
    isActive: () => Boolean(state.currentUserId),
  });
  realtime.connect();
}

function applyRealtimeEvent(event: RealtimeEvent): void {
  if (event.type === "session.message.created" && event.message) {
    const createdMessage = event.message;
    const exists = state.messages.some((message) => message.id === createdMessage.id);
    if (!exists) state.messages = [...state.messages, createdMessage];
    scheduleSessionScopedRender(createdMessage.sessionId || event.sessionId, { chat: true }, { rail: true }, 90);
    return;
  }

  if (event.type === "session.message.delta") {
    state.messages = event.message
      ? upsertById(state.messages, event.message)
      : state.messages.map((message) => (message.id === event.messageId ? { ...message, content: `${message.content || ""}${event.text || ""}`, createdAt: message.createdAt } : message));
    if (event.sessionId === state.selectedSessionId && event.messageId) scheduleMessagePatch(event.messageId, 90);
    return;
  }

  if (event.type === "session.message.updated" && event.message) {
    const updatedMessage = event.message;
    state.messages = state.messages.map((message) => (message.id === updatedMessage.id ? updatedMessage : message));
    if ((updatedMessage.sessionId || event.sessionId) === state.selectedSessionId) scheduleMessagePatch(updatedMessage.id, 90);
    else scheduleSessionScopedRender(updatedMessage.sessionId || event.sessionId, { chat: true }, { rail: true }, 90);
    return;
  }

  if (event.type === "session.status.changed") {
    state.sessions = event.session
      ? upsertById(state.sessions, event.session)
      : state.sessions.map((session) => (session.id === event.sessionId ? { ...session, status: event.status || session.status, updatedAt: now() } : session));
    scheduleSessionScopedRender(event.sessionId, { rail: true, chat: true, right: true }, { rail: true }, 120);
    return;
  }

  if (event.type === "session.updated" && event.session) {
    state.sessions = upsertById(state.sessions, event.session);
    scheduleSessionScopedRender(event.sessionId, { rail: true, chat: true, right: true }, { rail: true }, 120);
    return;
  }

  if (event.type === "session.created" && event.session) {
    state.sessions = upsertById(state.sessions, event.session);
    if (event.message) state.messages = upsertById(state.messages, event.message);
    scheduleTeamRender({ rail: true }, 120);
    return;
  }

  if (event.type === "session.plan.updated") {
    state.sessions = state.sessions.map((session) => (session.id === event.sessionId ? { ...session, plan: event.plan, updatedAt: now() } : session));
    scheduleSessionScopedRender(event.sessionId, { chat: true }, { rail: true }, 120);
    return;
  }

  if (event.type === "session.deleted") {
    state.sessions = state.sessions.filter((session) => session.id !== event.sessionId);
    state.messages = state.messages.filter((message) => message.sessionId !== event.sessionId);
    if (state.selectedSessionId === event.sessionId) state.selectedSessionId = "";
    scheduleRender();
    return;
  }

  if ((event.type === "permission.created" || event.type === "permission.updated") && event.permission) {
    state.permissions = upsertById(state.permissions, event.permission);
    scheduleSessionScopedRender(event.sessionId, { chat: true, right: true }, { rail: true }, 90);
    return;
  }

  if (event.type === "team.sessions.changed") {
    scheduleTeamRender({ rail: true }, 120);
    return;
  }

  if (event.type === "team.created" && event.team) {
    state.teams = upsertById(state.teams, event.team);
    if (event.member) state.members = upsertMember(state.members, event.member);
    if (event.agent) state.agents = upsertById(state.agents, event.agent);
    scheduleRender();
    return;
  }

  if (event.type === "team.updated" && event.team) {
    state.teams = upsertById(state.teams, event.team);
    scheduleRender();
    return;
  }

  if (event.type === "team.member_updated" && event.member) {
    state.members = upsertMember(state.members, event.member);
    scheduleTeamRender({ rail: true, right: true }, 120);
    return;
  }

  if (event.type === "team.deleted") {
    const sessionIds = new Set(state.sessions.filter((session) => session.teamId === event.teamId).map((session) => session.id));
    state.teams = state.teams.filter((team) => team.id !== event.teamId);
    state.members = state.members.filter((member) => member.teamId !== event.teamId);
    state.agents = state.agents.filter((agent) => agent.teamId !== event.teamId);
    state.sessions = state.sessions.filter((session) => session.teamId !== event.teamId);
    state.messages = state.messages.filter((message) => !sessionIds.has(message.sessionId));
    state.permissions = state.permissions.filter((permission) => !sessionIds.has(permission.sessionId));
    if (state.selectedTeamId === event.teamId) {
      state.selectedTeamId = state.teams[0]?.id || "";
      state.selectedSessionId = "";
      state.activeView = "teams";
    }
    scheduleRender();
    return;
  }

  if (event.type === "team.member_removed") {
    state.members = state.members.filter((member) => !(member.teamId === event.teamId && member.userId === event.userId));
    if (event.userId === state.currentUserId && state.selectedTeamId === event.teamId && !isSystemAdmin()) {
      state.activeView = "teams";
      state.selectedTeamId = state.teams.find((team) => team.id !== event.teamId && teamRole(team.id))?.id || "";
      state.selectedSessionId = "";
      scheduleRender();
      return;
    }
    scheduleTeamRender({ rail: true, right: true }, 120);
    return;
  }

  if (event.type === "agent.error") {
    scheduleSessionScopedRender(event.sessionId, { right: true, chat: true }, { rail: true }, 120);
    return;
  }

  scheduleRender();
}

function currentUser(): User | undefined {
  return state.users.find((user) => user.id === state.currentUserId);
}

function teamRole(teamId: string, userId: string | null = state.currentUserId): TeamRole | undefined {
  return state.members.find((member) => member.teamId === teamId && member.userId === userId)?.role;
}

function canWriteTeam(teamId: string): boolean {
  const role = teamRole(teamId);
  return currentUser()?.role === "admin" || (role !== undefined && ["owner", "admin", "member"].includes(role));
}

function canManageTeam(teamId: string): boolean {
  const role = teamRole(teamId);
  return currentUser()?.role === "admin" || (role !== undefined && ["owner", "admin"].includes(role));
}

function isSystemAdmin(): boolean {
  return currentUser()?.role === "admin";
}

function canManageSession(session?: Session): boolean {
  return Boolean(session && (canManageTeam(session.teamId) || session.createdBy === state.currentUserId));
}

function canAskSession(session?: Session): boolean {
  return Boolean(session && canWriteTeam(session.teamId) && session.createdBy === state.currentUserId);
}

function sessionVisibility(session?: Session): SessionVisibility {
  return session?.visibility === "team" ? "team" : "private";
}

function canApprove(permission: Permission): boolean {
  const teamId = sessionById(permission.sessionId)?.teamId;
  const role = teamId ? teamRole(teamId) : undefined;
  return Boolean((role !== undefined && ["owner", "admin"].includes(role)) || currentUser()?.role === "admin");
}

function sessionById(id?: string): Session | undefined {
  return state.sessions.find((session) => session.id === id);
}

function agentById(id?: string): Agent | undefined {
  return state.agents.find((agent) => agent.id === id);
}

function userName(id?: string | null): string {
  return state.users.find((user) => user.id === id)?.displayName || "Unknown";
}

function badge(text: HtmlValue, tone = ""): string {
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

function titleText(value: HtmlValue): string {
  return String(value || "新会话")
    .replace(/Claude Code/gi, "Harness")
    .replace(/\bClaude\b/gi, "Harness")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50) || "新会话";
}

function compactText(value: unknown, max = 900): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2);
  const normalized = String(text || "").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function permissionById(id?: string): Permission | undefined {
  return state.permissions.find((permission) => permission.id === id);
}

const appShellViews = createAppShellViews({
  state: () => state,
  currentUser,
  icons,
  escapeHtml,
});
const { appRoot, topbar, renderLogin } = appShellViews;

let activeModal = "";
let modalTeamId = "";

function showError(err: unknown): void {
  toast(err instanceof Error ? err.message : "操作失败", "error");
}

const teamViews = createTeamViews({
  state: () => state, icons, now, fmt, appRoot, topbar, currentUser, isSystemAdmin, canManageTeam,
  canWriteTeam, canManageSession, canAskSession, canApprove, sessionVisibility, teamRole, agentById, userName, escapeHtml, badge,
  titleText, compactText, sessionById, permissionById, groupSessionsByTime, isSessionGroupExpanded, sortSessionsNewestFirst,
  selectedSessionIds, uiMemory, renderMarkdown,
});
const {
  metricCard, renderTeams, renderTeamDetail, renderTeamRail, renderChat, renderRightRail,
  renderMessage, renderPermissionOverlay, renderModal,
} = teamViews;

const lineageFeature = createLineageFeature({
  state: () => state,
  isAdmin: isSystemAdmin,
  appRoot,
  topbar,
  escape: escapeHtml,
  fmt,
  toast,
  scheduleRender,
});

adminViews = createAdminViews({
  state: () => state,
  metrics: adminController.metrics,
  templates: adminController.templates,
  editingTemplate: adminController.editingTemplate,
  isAdmin: isSystemAdmin,
  loading: adminController.loading,
  auditFilters: adminController.filters,
  auditCursor: adminController.cursor,
  auditLoading: adminController.auditLoading,
  escape: escapeHtml,
  fmt,
  badge,
  metric: metricCard,
  userName,
  appRoot,
  topbar,
  icons,
  auditQuery: adminController.auditQuery,
  renderDataSync: lineageFeature.renderDataSync,
  fallback: renderTeams,
});

const uiShell = createUiShell({
  state: () => state, adminViews, renderLineage: lineageFeature.render, renderLogin, renderTeams, renderTeamDetail, renderTeamRail, renderChat,
  renderRightRail, renderMessage, renderModal, renderPermissionOverlay, activeModal: () => activeModal,
  modalTeamId: () => modalTeamId, renderToasts, sortSessionsNewestFirst, uiMemory,
});
const { render, renderTeamParts, patchVisibleMessage, captureUiSnapshot, restoreUiSnapshot, cssEscape } = uiShell;

function setElementBusy(element: HTMLElement, busy: boolean): void {
  element.setAttribute("aria-busy", String(busy));
  const controls = element instanceof HTMLFormElement ? [...element.querySelectorAll<HTMLButtonElement>("button[type='submit']")] : element instanceof HTMLButtonElement ? [element] : [];
  controls.forEach((control) => { control.disabled = busy; });
}

const clientActions = createClientActions({
  state: () => state, refresh, renderLogin, setActiveModal: (value) => { activeModal = value; },
  upsertById, scheduleTeamRender, scheduleRender, render, sessionById, canApprove, isSystemAdmin, sortSessionsNewestFirst,
  canManageTeam, canManageSession, sessionVisibility, normalizeSelectedSession, syncLocation, toast, uiMemory,
});
const {
  login, createTeam, createSession, sendMessage, decidePermission, deleteSession, deleteTeam, removeMember,
  toggleSessionVisibility, toggleSessionArchive, removeToolApproval, retrySession, copyText, createUser,
  changeOwnPassword, resetUserPassword, updateUserRole, saveDirectoryPermissions, addMember, saveConfig, saveWorkspace,
} = clientActions;

async function runAction(key: string, element: HTMLElement, action: () => Promise<void>, successMessage?: string): Promise<void> {
  if (pendingActions.has(key)) return;
  pendingActions.add(key);
  setElementBusy(element, true);
  try {
    await action();
    if (successMessage) toast(successMessage, "success");
  } catch (error) {
    showError(error);
  } finally {
    pendingActions.delete(key);
    if (element.isConnected) setElementBusy(element, false);
  }
}

async function changeSessionFilters(): Promise<void> {
  selectedSessionIds.clear();
  state.sessionPagination = { nextCursor: null, loading: false, initialized: false };
  await loadSessions({ reset: true });
  if (state.selectedSessionId) await loadMessages(state.selectedSessionId, { reset: true });
  syncLocation();
  scheduleTeamRender({ rail: true, chat: true, right: true }, 0);
}

document.addEventListener("submit", (event) => {
  const submitEvent = event as SubmitEvent;
  const form = submitEvent.target instanceof HTMLFormElement ? submitEvent.target : null;
  if (!form) return;
  submitEvent.preventDefault();
  const kind = form.dataset.form || "unknown";
  const submitter = submitEvent.submitter instanceof HTMLButtonElement ? submitEvent.submitter : null;
  const actions: Record<string, () => Promise<void>> = {
    login: () => login(form),
    team: () => createTeam(form),
    message: () => sendMessage(form, submitter),
    user: () => createUser(form),
    password: () => changeOwnPassword(form),
    "admin-password": () => resetUserPassword(form),
    member: () => addMember(form),
    config: () => saveConfig(form),
    workspace: () => saveWorkspace(form),
    "audit-filter": () => adminController.filterAudit(form),
    "team-template": () => adminController.saveTemplate(form),
    "lineage-query": () => lineageFeature.submitQuery(form),
    "lineage-config": () => lineageFeature.saveConfig(form),
    "directory-permissions": () => saveDirectoryPermissions(form),
  };
  const action = actions[kind];
  if (action) void runAction(
    `form:${kind}:${form.dataset.userId || form.dataset.team || state.selectedSessionId}`,
    form,
    action,
    ["message", "login", "team-template", "lineage-query", "lineage-config", "directory-permissions"].includes(kind) ? undefined : "保存成功",
  );
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.matches("[data-session-draft]") && target.dataset.sessionDraft) {
    uiMemory.composerDrafts.set(target.dataset.sessionDraft, target.value);
  }
  if (target.matches("[data-session-search]")) {
    state.sessionSearch = target.value;
    syncLocation();
    window.clearTimeout(sessionSearchTimer);
    sessionSearchTimer = window.setTimeout(() => void runAction("session-filter", target, changeSessionFilters), 280);
  }
  if (target.matches("[data-lineage-table-search]")) lineageFeature.search(target.value, target.dataset.lineageTableSearch === "target" ? "target" : "source");
});

document.addEventListener("toggle", (event) => {
  const details = event.target instanceof HTMLDetailsElement ? event.target.closest<HTMLDetailsElement>("[data-turn-events]") : null;
  if (details?.dataset.turnEvents) uiMemory.openTurnEvents.set(details.dataset.turnEvents, details.open);
}, true);

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.name === "collectionMode" && (target.value === "all" || target.value === "selected")) {
    lineageFeature.setCollectionMode(target.value);
    return;
  }
  if (target instanceof HTMLInputElement && target.matches("[data-session-select]")) {
    const id = target.dataset.sessionSelect;
    if (id) target.checked ? selectedSessionIds.add(id) : selectedSessionIds.delete(id);
    scheduleTeamRender({ rail: true }, 0);
    return;
  }
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.matches("[data-user-role]")) {
    void runAction(`user-role:${target.dataset.userRole}`, target, () => updateUserRole(target.dataset.userRole || "", target.value));
    return;
  }
  if (target.matches("[data-session-member-filter]")) state.sessionMemberFilter = target.value || "all";
  else if (target.matches("[data-session-status-filter]")) state.sessionStatusFilter = target.value as AppState["sessionStatusFilter"];
  else if (target.matches("[data-session-archive-filter]")) state.sessionArchiveFilter = target.value as AppState["sessionArchiveFilter"];
  else return;
  void runAction("session-filter", target, changeSessionFilters);
});

document.addEventListener("close", (event) => {
  if (!(event.target instanceof HTMLDialogElement) || !event.target.matches("[data-modal-dialog]")) return;
  activeModal = "";
  render();
}, true);

document.addEventListener("click", (event) => {
  const origin = event.target;
  if (!(origin instanceof Element)) return;
  const expandColumn = origin.closest<SVGElement>("[data-lineage-expand-column]");
  if (expandColumn?.dataset.lineageExpandColumn && (expandColumn.dataset.lineageDirection === "up" || expandColumn.dataset.lineageDirection === "down")) {
    void lineageFeature.expandColumn(expandColumn.dataset.lineageExpandColumn, expandColumn.dataset.lineageDirection).catch(showError);
    return;
  }
  const collapseColumn = origin.closest<SVGElement>("[data-lineage-collapse-column]");
  if (collapseColumn?.dataset.lineageCollapseColumn && (collapseColumn.dataset.lineageDirection === "up" || collapseColumn.dataset.lineageDirection === "down")) {
    lineageFeature.collapseColumn(collapseColumn.dataset.lineageCollapseColumn, collapseColumn.dataset.lineageDirection);
    return;
  }
  const expandTable = origin.closest<SVGElement>("[data-lineage-expand-table]");
  if (expandTable?.dataset.lineageExpandTable && (expandTable.dataset.lineageDirection === "up" || expandTable.dataset.lineageDirection === "down")) {
    void lineageFeature.expandTable(expandTable.dataset.lineageExpandTable, expandTable.dataset.lineageDirection).catch(showError);
    return;
  }
  const collapseTable = origin.closest<SVGElement>("[data-lineage-collapse-table]");
  if (collapseTable?.dataset.lineageCollapseTable && (collapseTable.dataset.lineageDirection === "up" || collapseTable.dataset.lineageDirection === "down")) {
    lineageFeature.collapseTable(collapseTable.dataset.lineageCollapseTable, collapseTable.dataset.lineageDirection);
    return;
  }
  const lineageNode = origin.closest<SVGElement>("[data-lineage-node]");
  if (lineageNode?.dataset.lineageNode) {
    void lineageFeature.selectNode(lineageNode.dataset.lineageNode).catch(showError);
    return;
  }
  const dialog = origin instanceof HTMLDialogElement ? origin : origin.closest<HTMLDialogElement>("dialog");
  if (dialog && origin === dialog) {
    activeModal = "";
    render();
    return;
  }
  const target = origin.closest<HTMLButtonElement>("button");
  if (!target || target.disabled) return;

  if (target.dataset.lineageTableChoice && (target.dataset.lineagePicker === "source" || target.dataset.lineagePicker === "target")) {
    lineageFeature.chooseTable(target.dataset.lineagePicker, target.dataset.lineageTableChoice);
    return;
  }

  if (target.dataset.view) {
    setState({ activeView: target.dataset.view as AppView, mobileNavOpen: false }, "push");
    if (target.dataset.view === "audit" && isSystemAdmin()) {
      void runAction("audit-initial", target, async () => {
        adminController.resetAuditCursor();
        await adminController.loadAudit({ reset: true });
        scheduleRender();
      });
    }
    if (target.dataset.view === "lineage" || target.dataset.view === "sync") void lineageFeature.load().catch(showError);
    return;
  }
  if (target.dataset.openTeam) {
    setState({ activeView: "team", selectedTeamId: target.dataset.openTeam, selectedSessionId: target.dataset.session || "", sessionMemberFilter: "all", mobileNavOpen: false }, "push");
    void runAction(`open-team:${target.dataset.openTeam}`, target, async () => {
      await loadSessions({ reset: true });
      if (state.selectedSessionId) await loadMessages(state.selectedSessionId, { reset: true });
      scheduleTeamRender({ rail: true, chat: true, right: true }, 0);
    });
    return;
  }
  if (target.dataset.backTeams !== undefined) return setState({ activeView: "teams" }, "push");
  if (target.dataset.session) {
    state.selectedSessionId = target.dataset.session;
    state.teamRailOpen = false;
    syncLocation("push");
    render();
    void runAction(`messages:${target.dataset.session}`, target, async () => { await loadMessages(target.dataset.session || "", { reset: true }); scheduleTeamRender({ chat: true, right: true }, 0); });
    return;
  }
  if (target.dataset.sessionGroup) {
    const key = sessionGroupKey(target.dataset.team || state.selectedTeamId, target.dataset.sessionGroup);
    uiMemory.openSessionGroups.set(key, target.dataset.expanded !== "true");
    scheduleTeamRender({ rail: true }, 0);
    return;
  }
  const actionName = target.dataset.action;
  if (actionName === "toggle-sidebar") {
    const collapsed = !state.sidebarCollapsed;
    localStorage.setItem("cc.sidebarCollapsed", String(collapsed));
    return setState({ sidebarCollapsed: collapsed });
  }
  if (actionName === "toggle-mobile-nav") return setState({ mobileNavOpen: !state.mobileNavOpen });
  if (actionName === "toggle-team-rail") return setState({ teamRailOpen: !state.teamRailOpen, rightRailOpen: false });
  if (actionName === "toggle-right-rail") return setState({ rightRailOpen: !state.rightRailOpen, teamRailOpen: false });
  if (actionName === "close-workspace-drawers") return setState({ teamRailOpen: false, rightRailOpen: false });
  if (target.dataset.modal) {
    activeModal = target.dataset.modal;
    modalTeamId = target.dataset.team || state.selectedTeamId;
    render();
    return;
  }
  if (target.dataset.closeModal !== undefined) {
    activeModal = "";
    render();
    return;
  }
  if (target.dataset.editTemplate) {
    adminController.editTemplate(target.dataset.editTemplate);
    render();
    return;
  }
  if (target.dataset.cancelTemplateEdit !== undefined) {
    adminController.cancelTemplateEdit();
    render();
    return;
  }
  if (target.dataset.lineageMode === "table" || target.dataset.lineageMode === "column") {
    lineageFeature.setMode(target.dataset.lineageMode);
    return;
  }
  if (target.dataset.lineageColumn) {
    lineageFeature.chooseColumn(target.dataset.lineageColumn);
    return;
  }
  if (target.dataset.lineageScope === "first" || target.dataset.lineageScope === "deep" || target.dataset.lineageScope === "terminal" || target.dataset.lineageScope === "path") {
    lineageFeature.setScope(target.dataset.lineageScope);
    return;
  }
  if (target.dataset.lineageCanvasMode === "select" || target.dataset.lineageCanvasMode === "pan") {
    lineageFeature.setCanvasMode(target.dataset.lineageCanvasMode);
    return;
  }
  const key = `click:${actionName || target.dataset.permission || target.dataset.deleteSession || target.dataset.deleteTeam || target.dataset.toggleUser || target.dataset.copyMessage || "action"}`;
  void runAction(key, target, async () => {
    if (actionName === "logout") {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      realtime?.close();
      realtime = null;
      setState({ currentUserId: null });
    } else if (actionName === "new-session") await createSession();
    else if (actionName === "batch-archive") await adminController.batchArchive(true);
    else if (actionName === "batch-unarchive") await adminController.batchArchive(false);
    else if (actionName === "load-more-audit") { await adminController.loadAudit(); scheduleRender(); }
    else if (actionName === "clear-audit-filter") await adminController.clearAuditFilters();
    else if (actionName === "toggle-session-visibility") await toggleSessionVisibility();
    else if (actionName === "toggle-session-archive") await toggleSessionArchive();
    else if (actionName === "retry-session") await retrySession(target.dataset.retryMessage);
    else if (actionName === "load-more-sessions") { await loadSessions(); scheduleTeamRender({ rail: true }, 0); }
    else if (actionName === "load-older-messages") { await loadMessages(state.selectedSessionId); scheduleTeamRender({ chat: true }, 0); }
    else if (actionName === "stop-session") {
      const session = sessionById(state.selectedSessionId);
      if (session) await api(`/api/sessions/${session.id}/stop`, { method: "POST", body: "{}" });
    } else if (actionName === "health-check") {
      await api("/api/claude/health-check", { method: "POST", body: "{}" });
      await refresh();
    } else if (actionName === "lineage-sync") await lineageFeature.triggerSync();
    else if (actionName === "lineage-test-connection") await lineageFeature.testConnection();
    else if (actionName === "lineage-source-diagnostic") await lineageFeature.diagnoseSource();
    else if (actionName === "lineage-reprocess") await lineageFeature.reprocess();
    else if (actionName === "lineage-close-detail") lineageFeature.closeDetail();
    else if (actionName === "lineage-swap-path") lineageFeature.swapPath();
    else if (actionName === "lineage-zoom-in") lineageFeature.zoomBy(0.15);
    else if (actionName === "lineage-zoom-out") lineageFeature.zoomBy(-0.15);
    else if (actionName === "lineage-fit") lineageFeature.fit();
    else if (actionName === "lineage-maximize") lineageFeature.toggleMaximize();
    else if (actionName === "lineage-analyze-selection") await lineageFeature.analyzeSelection();
    else if (actionName === "lineage-cancel-analysis") lineageFeature.cancelAnalysis();
    else if (actionName === "lineage-download") lineageFeature.downloadGraph();
    else if (target.dataset.deleteSession) await deleteSession(target.dataset.deleteSession);
    else if (target.dataset.deleteTeam) await deleteTeam(target.dataset.deleteTeam);
    else if (target.dataset.removeMemberTeam && target.dataset.removeMemberUser) await removeMember(target.dataset.removeMemberTeam, target.dataset.removeMemberUser);
    else if (target.dataset.copyMessage) {
      const message = state.messages.find((item) => item.id === target.dataset.copyMessage);
      if (message) { await copyText(message.content || ""); toast("已复制", "success"); }
    } else if (target.dataset.copyCode) { await copyText(decodeURIComponent(target.dataset.copyCode)); toast("已复制", "success"); }
    else if (target.dataset.exportSession) downloadApi(`/api/sessions/${encodeURIComponent(target.dataset.exportSession)}/export?format=${encodeURIComponent(target.dataset.exportFormat || "markdown")}`);
    else if (target.dataset.templateApply) {
      const select = document.querySelector<HTMLSelectElement>(`[data-template-team="${cssEscape(target.dataset.templateApply)}"]`);
      await adminController.applyTemplate(target.dataset.templateApply, select?.value || "");
    }
    else if (target.dataset.deleteTemplate) await adminController.deleteTemplate(target.dataset.deleteTemplate);
    else if (target.dataset.removeApprovalScope && target.dataset.removeApprovalValue) await removeToolApproval(target.dataset.removeApprovalScope, target.dataset.removeApprovalValue);
    else if (target.dataset.permission && target.dataset.decision) await decidePermission(target.dataset.permission, target.dataset.decision);
    else if (target.dataset.toggleUser) {
      await api(`/api/users/${target.dataset.toggleUser}/status`, { method: "PATCH", body: "{}" });
      await refresh();
    }
  });
});

window.addEventListener("popstate", () => {
  applyLocationToState(state);
  render();
  if (state.activeView === "team") void loadSessions({ reset: true }).then(() => state.selectedSessionId ? loadMessages(state.selectedSessionId, { reset: true }) : undefined).then(() => scheduleTeamRender({ rail: true, chat: true, right: true }, 0)).catch(showError);
  if (state.activeView === "lineage" || state.activeView === "sync") void lineageFeature.load().catch(showError);
});

void refresh();

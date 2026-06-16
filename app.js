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
};

const now = () => Date.now();
const fmt = (timestamp) => new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp);
const CHAT_RENDER_LIMIT = 180;

const seedState = () => ({
  currentUserId: null,
  activeView: "teams",
  selectedTeamId: "team_platform",
  selectedSessionId: "session_login",
  sidebarCollapsed: localStorage.getItem("cc.sidebarCollapsed") === "true",
  sessionMemberFilter: "all",
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
});

let state = loadState();
let eventSource = null;
let refreshTimer = null;
let renderTimer = null;
let teamRenderTimer = null;
let messagePatchTimer = null;
const pendingTeamRender = { rail: false, chat: false, right: false };
const pendingMessagePatches = new Set();
const uiMemory = {
  composerDrafts: new Map(),
  openTurnEvents: new Map(),
};

function loadState() {
  return {
    ...seedState(),
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

function setState(patch) {
  state = { ...state, ...patch };
  render();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.message || payload.code || "Request failed");
  return payload;
}

async function refresh() {
  try {
    const data = await api("/api/bootstrap");
    state = { ...state, ...data };
    render();
    connectEvents();
  } catch {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    setState({ currentUserId: null });
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(), 180);
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => render(), 80);
}

function scheduleTeamRender(parts, delay = 120) {
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

function scheduleSessionScopedRender(sessionId, selectedParts, otherParts = { rail: true }, delay = 120) {
  if (state.activeView !== "team") {
    scheduleRender();
    return;
  }
  scheduleTeamRender(sessionId === state.selectedSessionId ? selectedParts : otherParts, delay);
}

function scheduleMessagePatch(messageId, delay = 90) {
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

function upsertById(items, item) {
  if (!item?.id) return items;
  const exists = items.some((existing) => existing.id === item.id);
  return exists ? items.map((existing) => (existing.id === item.id ? item : existing)) : [...items, item];
}

function upsertMember(items, member) {
  if (!member?.teamId || !member?.userId) return items;
  const exists = items.some((item) => item.teamId === member.teamId && item.userId === member.userId);
  return exists ? items.map((item) => (item.teamId === member.teamId && item.userId === member.userId ? member : item)) : [...items, member];
}

function connectEvents() {
  if (eventSource || !state.currentUserId) return;
  eventSource = new EventSource("/api/events");
  eventSource.onmessage = (event) => {
    try {
      applyRealtimeEvent(JSON.parse(event.data));
    } catch {
      scheduleRefresh();
    }
  };
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    setTimeout(() => state.currentUserId && connectEvents(), 1500);
  };
}

function applyRealtimeEvent(event) {
  if (event.type === "session.message.created" && event.message) {
    const exists = state.messages.some((message) => message.id === event.message.id);
    if (!exists) state.messages = [...state.messages, event.message];
    scheduleSessionScopedRender(event.message.sessionId || event.sessionId, { chat: true }, { rail: true }, 90);
    return;
  }

  if (event.type === "session.message.delta") {
    state.messages = state.messages.map((message) => (message.id === event.messageId ? { ...message, content: `${message.content || ""}${event.text || ""}`, createdAt: message.createdAt } : message));
    if (event.sessionId === state.selectedSessionId) scheduleMessagePatch(event.messageId, 90);
    return;
  }

  if (event.type === "session.message.updated" && event.message) {
    state.messages = state.messages.map((message) => (message.id === event.message.id ? event.message : message));
    if ((event.message.sessionId || event.sessionId) === state.selectedSessionId) scheduleMessagePatch(event.message.id, 90);
    else scheduleSessionScopedRender(event.message.sessionId || event.sessionId, { chat: true }, { rail: true }, 90);
    return;
  }

  if (event.type === "session.status.changed") {
    state.sessions = event.session
      ? upsertById(state.sessions, event.session)
      : state.sessions.map((session) => (session.id === event.sessionId ? { ...session, status: event.status, updatedAt: now() } : session));
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

function currentUser() {
  return state.users.find((user) => user.id === state.currentUserId);
}

function teamRole(teamId, userId = state.currentUserId) {
  return state.members.find((member) => member.teamId === teamId && member.userId === userId)?.role;
}

function canWriteTeam(teamId) {
  const role = teamRole(teamId);
  return currentUser()?.role === "admin" || ["owner", "admin", "member"].includes(role);
}

function canManageTeam(teamId) {
  const role = teamRole(teamId);
  return currentUser()?.role === "admin" || ["owner", "admin"].includes(role);
}

function isSystemAdmin() {
  return currentUser()?.role === "admin";
}

function canManageSession(session) {
  return Boolean(session) && (canManageTeam(session.teamId) || session.createdBy === state.currentUserId);
}

function sessionVisibility(session) {
  return session?.visibility === "team" ? "team" : "private";
}

function canApprove(permission) {
  const role = teamRole(sessionById(permission.sessionId)?.teamId);
  if (["owner", "admin"].includes(role) || currentUser()?.role === "admin") return true;
  return role === "member" && permission.requestedByUserId === state.currentUserId;
}

function sessionById(id) {
  return state.sessions.find((session) => session.id === id);
}

function agentById(id) {
  return state.agents.find((agent) => agent.id === id);
}

function userName(id) {
  return state.users.find((user) => user.id === id)?.displayName || "Unknown";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderInlineMarkdown(value) {
  return String(value)
    .split(/(`[^`]*`)/g)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    })
    .join("");
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line) {
  const cells = splitMarkdownRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderMarkdownTable(lines) {
  const header = splitMarkdownRow(lines[0]);
  const rows = lines.slice(2).map(splitMarkdownRow).filter((row) => row.some(Boolean));
  return `
    <div class="markdown-table-wrap">
      <table class="markdown-table">
        <thead><tr>${header.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>
        <tbody>
          ${rows.map((row) => `<tr>${header.map((_, index) => `<td>${renderInlineMarkdown(row[index] || "")}</td>`).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderMarkdownBlocks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) {
      i += 1;
      continue;
    }
    if (lines[i].includes("|") && lines[i + 1] && isMarkdownTableSeparator(lines[i + 1])) {
      const tableLines = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        tableLines.push(lines[i]);
        i += 1;
      }
      blocks.push(renderMarkdownTable(tableLines));
      continue;
    }
    if (/^#{1,4}\s+/.test(lines[i])) {
      const match = lines[i].match(/^(#{1,4})\s+(.+)$/);
      const level = Math.min(match[1].length + 2, 5);
      blocks.push(`<h${level}>${renderInlineMarkdown(match[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^>\s?/.test(lines[i])) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(`<blockquote>${quote.map(renderInlineMarkdown).join("<br>")}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[i])) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const done = /\[[xX]\]/.test(lines[i]);
        const text = lines[i].replace(/^\s*[-*]\s+\[[ xX]\]\s+/, "");
        items.push(`<li><input type="checkbox" disabled ${done ? "checked" : ""}>${renderInlineMarkdown(text)}</li>`);
        i += 1;
      }
      blocks.push(`<ul class="task-list">${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(lines[i])) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(lines[i])) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push(`<ol>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }
    const paragraph = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !(lines[i].includes("|") && lines[i + 1] && isMarkdownTableSeparator(lines[i + 1])) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
  }
  return blocks.join("");
}

function renderMarkdown(text) {
  const chunks = String(text || "").split(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g);
  let html = "";
  for (let index = 0; index < chunks.length; index += 1) {
    if (index % 3 === 0) html += renderMarkdownBlocks(chunks[index]);
    if (index % 3 === 2) html += `<div class="markdown-code-wrap"><button class="code-copy" data-copy-code="${escapeHtml(encodeURIComponent(chunks[index]))}">复制</button><pre class="markdown-code"><code>${escapeHtml(chunks[index])}</code></pre></div>`;
  }
  return html;
}

function badge(text, tone = "") {
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

function titleText(value) {
  return String(value || "新会话").replace(/\s+/g, " ").trim().slice(0, 50) || "新会话";
}

function compactText(value, max = 900) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2);
  const normalized = String(text || "").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function permissionById(id) {
  return state.permissions.find((permission) => permission.id === id);
}

function appRoot(inner) {
  const user = currentUser();
  return `
    <div class="app-shell ${state.sidebarCollapsed ? "sidebar-collapsed" : ""}">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">CC</div>
          <div class="brand-copy">
            <div class="brand-title">Claude Code</div>
            <div class="brand-subtitle">Team Platform</div>
          </div>
          <button class="sidebar-toggle" title="${state.sidebarCollapsed ? "展开导航栏" : "收起导航栏"}" data-action="toggle-sidebar">${icons.panel}</button>
        </div>
        <nav class="nav-group">
          ${renderMainNav(user)}
        </nav>
        <div class="sidebar-footer">
          <div class="user-chip">
            <div class="avatar">${escapeHtml(user?.displayName?.slice(0, 1) || "U")}</div>
            <div>
              <strong>${escapeHtml(user?.displayName || "")}</strong>
              <div class="brand-subtitle">${escapeHtml(user?.role || "")}</div>
            </div>
          </div>
          <button class="nav-button" style="margin-top:12px" title="改密码" data-modal="password">${icons.settings}<span>改密码</span></button>
          <button class="nav-button" style="margin-top:12px" title="退出" data-action="logout">${icons.logout}<span>退出</span></button>
        </div>
      </aside>
      <main class="main">${inner}</main>
    </div>
  `;
}

function renderMainNav(user = currentUser()) {
  return `
    ${navButton("teams", icons.teams, "团队工作台")}
    ${navButton("settings", icons.settings, "Agent 设置")}
    ${user?.role === "admin" ? navButton("users", icons.users, "用户管理") : ""}
    ${navButton("audit", icons.check, "审计日志")}
  `;
}

function renderUserPanel(user = currentUser()) {
  return `
    <div class="sidebar-footer rail-footer">
      <div class="user-chip">
        <div class="avatar">${escapeHtml(user?.displayName?.slice(0, 1) || "U")}</div>
        <div>
          <strong>${escapeHtml(user?.displayName || "")}</strong>
          <div class="brand-subtitle">${escapeHtml(user?.role || "")}</div>
        </div>
      </div>
      <button class="nav-button" style="margin-top:12px" data-action="logout">${icons.logout}<span>退出</span></button>
    </div>
  `;
}

function navButton(view, icon, text) {
  const active = state.activeView === view || (view === "teams" && state.activeView === "team");
  return `<button class="nav-button ${active ? "active" : ""}" title="${escapeHtml(text)}" data-view="${view}">${icon}<span>${text}</span></button>`;
}

function topbar(title, subtitle, actions = "") {
  return `<header class="topbar"><div><h1 class="page-title">${escapeHtml(title)}</h1><div class="page-subtitle">${escapeHtml(subtitle)}</div></div><div class="toolbar">${actions}</div></header>`;
}

function renderLogin(error = "") {
  document.querySelector("#app").innerHTML = `
    <div class="login-page">
      <section class="login-copy">
        <h1>Claude Code Team Platform</h1>
        <p>把服务器上的 Claude Code CLI 封装成团队可共享、可观察、可审批的 Agent 工作台。</p>
      </section>
      <section class="login-panel">
        <form class="login-box" data-form="login">
          <h2>登录工作台</h2>
          <p>管理员账号为 admin，密码来自部署环境变量 ADMIN_PASSWORD。</p>
          <div class="field"><label for="login-username">用户名</label><input class="input" id="login-username" name="username" value="admin" autocomplete="username" /></div>
          <div class="field"><label for="login-password">密码</label><input class="input" id="login-password" name="password" type="password" autocomplete="current-password" /></div>
          ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
          <button class="button primary" style="width:100%" type="submit">登录工作台</button>
          <div class="helper">数据由服务端持久化。首次部署请立刻修改默认管理员密码。</div>
        </form>
      </section>
    </div>
  `;
}

function renderTeams() {
  const user = currentUser();
  const cli = cliStatus();
  const teams = user.role === "admin" ? state.teams : state.teams.filter((team) => teamRole(team.id));
  const actions = isSystemAdmin() ? `<button class="button primary" data-modal="team">${icons.plus}创建团队</button>` : "";
  const visibleTeamIds = new Set(teams.map((team) => team.id));
  const visibleSessions = state.sessions.filter((session) => visibleTeamIds.has(session.teamId));
  const runningCount = visibleSessions.filter((session) => session.status === "running").length;
  const pendingCount = state.permissions.filter((permission) => permission.status === "pending" && visibleSessions.some((session) => session.id === permission.sessionId)).length;
  const recentSessions = visibleSessions
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5);
  const cards = teams
    .map((team) => {
      const members = state.members.filter((member) => member.teamId === team.id);
      const role = teamRole(team.id) || "system admin";
      const running = state.sessions.filter((session) => session.teamId === team.id && session.status === "running").length;
      return `
        <article class="card team-card">
          <div>
            <h3>${escapeHtml(team.name)}</h3>
            <div class="meta">${badge(role, role === "viewer" ? "" : "green")} ${running ? badge(`${running} running`, "blue") : badge("idle")}</div>
          </div>
          <div class="workspace">${escapeHtml(team.workspacePath)}</div>
          <div class="meta"><span>${members.length} 名成员</span><span>最近活动 ${fmt(team.updatedAt)}</span></div>
          <div class="toolbar">
            <button class="button primary" data-open-team="${team.id}">打开工作台</button>
            <button class="button" data-modal="members" data-team="${team.id}">成员</button>
            ${isSystemAdmin() ? `<button class="button danger" data-delete-team="${team.id}">${icons.close}删除</button>` : ""}
          </div>
        </article>
      `;
    })
    .join("");
  return appRoot(`
    ${topbar("团队工作台", "共享工作区、会话、权限请求和 Agent 状态", actions)}
    <section class="content dashboard">
      <div class="dashboard-hero">
        <div>
          <p class="eyebrow">Team Agent Console</p>
          <h2>统一管理 Claude Code 工作区</h2>
          <p>查看团队、运行会话、待审批动作和 CLI 健康状态。进入团队后可以直接发送任务、观察输出和调整工作区。</p>
        </div>
        <div class="health-pill ${cli.available ? "ok" : "down"}">
          ${badge(cli.label, cli.tone)}
          <span>${escapeHtml(cli.detail)}</span>
        </div>
      </div>
      <div class="metric-row">
        ${metricCard("团队", teams.length, "可访问团队")}
        ${metricCard("运行中", runningCount, "正在执行的会话")}
        ${metricCard("待审批", pendingCount, "权限请求")}
        ${metricCard("会话", visibleSessions.length, "历史记录")}
      </div>
      <div class="dashboard-grid">
        <section>
          <div class="section-title"><h3>团队</h3><span>${teams.length} 个工作区</span></div>
          <div class="grid teams">${cards || '<div class="empty">还没有团队</div>'}</div>
        </section>
        <aside class="panel activity-panel">
          <div class="panel-header"><h2 class="panel-title">最近活动</h2>${badge("live", "blue")}</div>
          <div class="side-stack">
            ${recentSessions.map((session) => {
              const team = state.teams.find((item) => item.id === session.teamId);
              return `<button class="activity-item" data-open-team="${session.teamId}" data-session="${session.id}">
                <strong title="${escapeHtml(titleText(session.title))}">${escapeHtml(titleText(session.title))}</strong>
                <span>${escapeHtml(team?.name || "")}</span>
                <div class="meta">${badge(session.status, statusTone(session.status))}<span>${fmt(session.updatedAt)}</span></div>
              </button>`;
            }).join("") || '<p class="empty">暂无会话活动</p>'}
          </div>
        </aside>
      </div>
    </section>
  `);
}

function metricCard(label, value, caption) {
  return `<div class="metric card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div><div class="metric-caption">${escapeHtml(caption)}</div></div>`;
}

function cliStatus() {
  const cfg = state.claudeConfig;
  if (cfg.available) {
    return {
      available: true,
      dot: "ready",
      tone: "blue",
      label: "CLI 可用",
      detail: `${cfg.version || "unknown"} · ${cfg.latencyMs ?? "-"}ms`,
      message: `可用，版本 ${cfg.version || "unknown"}，延迟 ${cfg.latencyMs ?? "-"}ms`,
    };
  }
  return {
    available: false,
    dot: "error",
    tone: "red",
    label: "CLI 未就绪",
    detail: cfg.version || "unknown",
    message: cfg.message || "不可用，请到 Agent 设置检查命令路径",
  };
}

function renderTeamDetail() {
  const team = state.teams.find((item) => item.id === state.selectedTeamId) || state.teams[0];
  if (!team) return renderTeams();
  const sessions = state.sessions.filter((session) => session.teamId === team.id);
  const session = state.sessions.find((item) => item.id === state.selectedSessionId && item.teamId === team.id) || sessions[0];
  if (session && state.selectedSessionId !== session.id) state.selectedSessionId = session.id;
  const role = teamRole(team.id) || (currentUser()?.role === "admin" ? "system admin" : "viewer");
  const actions = `
    <button class="button" data-back-teams>团队列表</button>
    <button class="button" data-modal="members" data-team="${team.id}">成员</button>
    <button class="button" data-modal="workspace" data-team="${team.id}">工作区</button>
    ${isSystemAdmin() ? `<button class="button danger" data-delete-team="${team.id}">${icons.close}删除团队</button>` : ""}
    <button class="button primary" data-action="new-session" ${canWriteTeam(team.id) ? "" : "disabled"}>${icons.plus}新会话</button>
  `;

  return appRoot(`
    ${topbar(team.name, `${team.workspacePath} · 我的角色 ${role}`, actions)}
    <section class="content team-content">
      <div class="team-layout">
        ${renderTeamRail(team, session)}
        ${renderChat(team, session)}
        ${renderRightRail(team, session)}
      </div>
    </section>
  `);
}

function renderTeamRail(team, activeSession) {
  const members = state.members.filter((member) => member.teamId === team.id);
  const running = state.sessions.filter((session) => session.teamId === team.id && session.status === "running").length;
  return `
    <aside class="panel team-rail" id="team-rail">
      <div class="team-summary">
        <div class="section-title"><h3>${escapeHtml(team.name)}</h3>${badge(running ? `${running} running` : "idle", running ? "blue" : "")}</div>
        <p>${escapeHtml(team.workspacePath)}</p>
        <div class="meta"><span>${members.length} 名成员</span><span>${fmt(team.updatedAt)}</span></div>
      </div>
      ${renderSessionList(team, activeSession, true)}
    </aside>
  `;
}

function renderSessionList(team, activeSession, embedded = false) {
  const allSessions = state.sessions.filter((session) => session.teamId === team.id);
  const filter = state.sessionMemberFilter || "all";
  const sessions = filter === "all" ? allSessions : allSessions.filter((session) => session.createdBy === filter);
  const memberOptions = state.members
    .filter((member) => member.teamId === team.id)
    .map((member) => {
      const count = allSessions.filter((session) => session.createdBy === member.userId).length;
      return { userId: member.userId, label: `${userName(member.userId)} (${count})` };
    })
    .filter((option) => option.label);
  return `
    <section class="${embedded ? "session-section" : "panel"}">
      <div class="panel-header"><h2 class="panel-title">会话</h2>${badge(`${sessions.length}/${allSessions.length}`)}</div>
      <div class="session-filter">
        <label for="session-member-filter">成员</label>
        <select class="select compact-select" id="session-member-filter" data-session-member-filter>
          <option value="all" ${filter === "all" ? "selected" : ""}>全部成员</option>
          ${memberOptions.map((option) => `<option value="${escapeHtml(option.userId)}" ${filter === option.userId ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
        </select>
      </div>
      <div class="session-list">
        ${sessions
          .map((session) => `
            <div class="session-row">
              <button class="session-item ${session.id === activeSession?.id ? "active" : ""}" data-session="${session.id}">
                <strong class="truncate-title" title="${escapeHtml(titleText(session.title))}">${escapeHtml(titleText(session.title))}</strong>
                <div class="meta">${badge(session.status, statusTone(session.status))}${badge(sessionVisibility(session) === "team" ? "团队可见" : "私有", sessionVisibility(session) === "team" ? "green" : "")}</div>
                <div class="meta"><span>${escapeHtml(userName(session.createdBy))}</span><span>${fmt(session.updatedAt)}</span></div>
              </button>
              <button class="icon-button session-delete" title="删除会话" data-delete-session="${session.id}">${icons.close}</button>
            </div>
          `)
          .join("") || '<div class="empty">没有匹配的会话</div>'}
      </div>
    </section>
  `;
}

function renderChat(team, session) {
  if (!session) {
    return `<section class="panel chat-panel" id="chat-panel"><div class="empty">创建一个 Claude Code 会话开始协作</div></section>`;
  }
  const allMessages = state.messages.filter((message) => message.sessionId === session.id);
  const messages = allMessages.slice(-CHAT_RENDER_LIMIT);
  const turns = buildMessageTurns(messages);
  const isRunning = session.status === "running";
  const canSend = canWriteTeam(team.id) && session.status !== "waiting_permission";
  const canStop = ["running", "waiting_permission"].includes(session.status);
  const placeholder = composerPlaceholder(team, session);
  const visibility = sessionVisibility(session);
  const draft = uiMemory.composerDrafts.get(session.id) || "";
  return `
    <section class="panel chat-panel" id="chat-panel">
      <div class="panel-header chat-header">
        <div class="title-stack chat-title-stack">
          <h2 class="panel-title truncate-title" title="${escapeHtml(titleText(session.title))}">${escapeHtml(titleText(session.title))}</h2>
          <div class="meta"><span>创建人 ${escapeHtml(userName(session.createdBy))}</span>${badge(visibility === "team" ? "团队可见" : "私有", visibility === "team" ? "green" : "")}</div>
        </div>
        <div class="toolbar chat-actions">
          <button class="button" data-action="toggle-session-visibility" ${canManageSession(session) ? "" : "disabled"}>${visibility === "team" ? "设为私有" : "共享给团队"}</button>
          ${badge(session.status, statusTone(session.status))}
          <button class="icon-button" title="停止会话" data-action="stop-session" ${canStop ? "" : "disabled"}>${icons.stop}</button>
        </div>
      </div>
      <div class="chat-stream" id="chat-stream">
        ${allMessages.length > messages.length ? `<div class="history-notice">已隐藏更早的 ${allMessages.length - messages.length} 条本地记录，保持页面流畅。</div>` : ""}
        ${turns.map(renderTurn).join("")}
      </div>
      <form class="composer" data-form="message">
        <textarea class="textarea" name="content" placeholder="${escapeHtml(placeholder)}" data-session-draft="${session.id}" ${canSend ? "" : "disabled"}>${escapeHtml(draft)}</textarea>
        <div class="composer-actions">
          ${
            isRunning
              ? `<button class="button primary" type="submit" name="mode" value="guide" ${canSend ? "" : "disabled"}>${icons.send}追加引导</button><button class="button" type="submit" name="mode" value="interrupt" ${canSend ? "" : "disabled"}>${icons.stop}打断并发送</button>`
              : `<button class="button primary" type="submit" name="mode" value="send" ${canSend ? "" : "disabled"}>${icons.send}发送</button>`
          }
        </div>
      </form>
    </section>
  `;
}

function buildMessageTurns(messages) {
  const turns = [];
  const byId = new Map();
  const loose = [];
  for (const message of messages) {
    const turnId = message.metadata?.turnId;
    if (message.senderType === "user" && message.metadata?.guidance && turnId && byId.has(turnId)) {
      byId.get(turnId).messages.push(message);
      continue;
    }
    if (message.senderType === "user") {
      const turn = { id: turnId || message.id, user: message, messages: [] };
      turns.push(turn);
      if (turnId) byId.set(turnId, turn);
      continue;
    }
    if (turnId && byId.has(turnId)) {
      byId.get(turnId).messages.push(message);
    } else {
      loose.push(message);
    }
  }
  return [...loose.map((message) => ({ id: message.id, messages: [message] })), ...turns];
}

function renderTurn(turn) {
  const agentMessages = turn.messages.filter((message) => message.senderType === "agent");
  const planMessages = turn.messages.filter((message) => message.metadata?.type === "plan");
  const guidanceMessages = turn.messages.filter((message) => message.senderType === "user" && message.metadata?.guidance);
  const eventMessages = turn.messages.filter((message) => message.senderType !== "agent" && message.senderType !== "user" && message.metadata?.type !== "plan");
  const hasAgentOutput = agentMessages.some((message) => String(message.content || "").trim());
  const hasNoisyEvents = eventMessages.length > 2 || eventMessages.some((message) => ["command", "input", "tool_call", "permission_request"].includes(message.metadata?.type));
  return `
    <section class="turn">
      ${turn.user ? renderMessage(turn.user) : ""}
      ${planMessages.map(renderPlanMessage).join("")}
      ${agentMessages.map(renderMessage).join("")}
      ${guidanceMessages.map(renderMessage).join("")}
      ${eventMessages.length ? renderTurnEvents(eventMessages, hasAgentOutput || hasNoisyEvents) : ""}
    </section>
  `;
}

function renderPlanMessage(message) {
  const items = Array.isArray(message.metadata?.items) ? message.metadata.items : [];
  if (!items.length) return "";
  const visible = items.filter((item) => item.status !== "deleted");
  const done = visible.filter((item) => item.status === "completed").length;
  const running = visible.find((item) => item.status === "in_progress");
  const complete = visible.length > 0 && done === visible.length;
  const body = visible.map((item, index) => {
    const status = item.status || "pending";
    const marker = status === "completed" ? icons.check : status === "in_progress" ? '<span class="plan-spinner" aria-hidden="true"></span>' : '<span class="plan-dot" aria-hidden="true"></span>';
    const label = status === "completed" ? "已完成" : status === "in_progress" ? "进行中" : "等待";
    return `
      <li class="${escapeHtml(status)}">
        <span class="plan-marker">${marker}</span>
        <div><strong>${escapeHtml(item.content || `步骤 ${index + 1}`)}</strong>${item.activeForm && status === "in_progress" ? `<p>${escapeHtml(item.activeForm)}</p>` : ""}</div>
        <em>${label}</em>
      </li>
    `;
  }).join("");
  const content = `<ol class="plan-list">${body}</ol>`;
  if (complete) {
    return `<details class="plan-card" data-message-id="${escapeHtml(message.id)}"><summary>${icons.check}<span>执行计划已完成</span><strong>${done}/${visible.length}</strong></summary>${content}</details>`;
  }
  return `
    <section class="plan-card active" data-message-id="${escapeHtml(message.id)}">
      <div class="plan-head">
        <div><strong>执行计划</strong>${running ? `<span>正在执行：${escapeHtml(running.activeForm || running.content)}</span>` : ""}</div>
        ${badge(`${done}/${visible.length}`, "blue")}
      </div>
      ${content}
    </section>
  `;
}

function renderTurnEvents(messages, collapsed) {
  const content = messages.map(renderTimelineEvent).join("");
  if (!collapsed) return `<div class="turn-events">${content}</div>`;
  const key = turnEventKey(messages);
  const isOpen = uiMemory.openTurnEvents.get(key);
  return `<details class="turn-events collapsed" data-turn-events="${escapeHtml(key)}" ${isOpen ? "open" : ""}><summary>${icons.terminal}<span>本轮运行记录</span><strong>${messages.length}</strong></summary>${content}</details>`;
}

function turnEventKey(messages) {
  const first = messages[0];
  const turnId = first?.metadata?.turnId || first?.id || "loose";
  return `${first?.sessionId || "session"}:${turnId}`;
}

function composerPlaceholder(team, session) {
  if (!canWriteTeam(team.id)) return "viewer 角色只能查看会话";
  if (session.status === "idle") return "向 Claude Code 发送任务";
  if (session.status === "running") return "Claude Code 正在执行，可以追加引导，不会开启新会话";
  if (session.status === "waiting_permission") return "当前任务等待审批";
  return "继续发送下一轮消息，会自动恢复 Claude Code 会话上下文";
}

function renderMessage(message) {
  if (message.metadata?.type === "plan") return renderPlanMessage(message);
  if (message.senderType === "tool" || message.senderType === "system") return renderTimelineEvent(message);
  if (message.senderType === "agent" && !String(message.content || "").trim()) {
    return "";
  }
  const sender =
    message.senderType === "user"
      ? userName(message.senderId)
      : message.senderType === "agent"
        ? agentById(message.senderId)?.name || "Agent"
        : message.senderType;
  const rich = message.senderType === "agent";
  const guidance = message.senderType === "user" && message.metadata?.guidance;
  const content = rich ? renderMarkdown(message.content) : escapeHtml(message.content);
  return `
    <article class="message ${message.senderType} ${guidance ? "guidance" : ""}" data-message-id="${escapeHtml(message.id)}">
      <div class="message-meta">
        <span>${escapeHtml(guidance ? "追加引导" : sender)}</span><span>${fmt(message.createdAt)}</span>${guidance && message.metadata?.interrupt ? badge("打断", "amber") : ""}
        <span class="message-actions">
          <button class="text-button" data-copy-message="${message.id}">复制</button>
          ${message.senderType === "user" && !guidance ? `<button class="text-button" data-action="retry-session" data-retry-message="${message.id}">重试</button>` : ""}
        </span>
      </div>
      <div class="bubble ${rich ? "markdown" : ""}">${content}</div>
    </article>
  `;
}

function renderTimelineEvent(message) {
  const event = timelineEventMeta(message);
  return `
    <article class="timeline-event ${event.tone}" data-message-id="${escapeHtml(message.id)}">
      <span class="event-icon">${event.spinner ? '<span class="event-spinner" aria-hidden="true"></span>' : event.icon}</span>
      <div class="event-body">
        <div class="event-head"><strong>${escapeHtml(event.title)}</strong><span>${fmt(message.updatedAt || message.createdAt)}</span></div>
        ${event.detail ? `<pre class="event-detail">${escapeHtml(event.detail)}</pre>` : ""}
      </div>
    </article>
  `;
}

function timelineEventMeta(message) {
  const type = message.metadata?.type || (message.senderType === "system" ? "system" : "tool");
  if (type === "command") return { title: message.metadata?.claudeSessionId ? "已恢复 Claude Code 会话" : "已启动 Claude Code 会话", detail: message.content, icon: icons.terminal, tone: "tool" };
  if (type === "input") return { title: "已发送到 Claude Code", detail: message.content, icon: icons.terminal, tone: "tool" };
  if (type === "tool_call") {
    const running = message.metadata?.status === "running";
    return { title: `${running ? "正在调用" : "已调用"} ${message.metadata?.name || "工具"}`, detail: message.content, icon: icons.terminal, tone: running ? "pending" : "done", spinner: running };
  }
  if (type === "plan") return { title: "执行计划", detail: message.content, icon: icons.check, tone: message.metadata?.status === "done" ? "done" : "pending", spinner: message.metadata?.status !== "done" };
  if (type === "permission_request") {
    const permission = permissionById(message.metadata?.permissionId);
    const label = `${message.metadata?.serverName ? `${message.metadata.serverName} / ` : ""}${message.metadata?.toolName || ""}`.trim();
    const detail = permission ? [permission.summary, permission.reason].filter(Boolean).join("\n") : message.content;
    if (permission?.status === "approved") return { title: `已授权 ${label}`, detail, icon: icons.check, tone: "done" };
    if (permission?.status === "rejected") return { title: `已拒绝 ${label}`, detail, icon: icons.close, tone: "error" };
    return { title: `等待授权 ${label}`, detail, icon: icons.info, tone: "pending", spinner: true };
  }
  if (type === "heartbeat" || type === "thinking") {
    const done = message.metadata?.status === "done";
    const durationMs = Number(message.metadata?.durationMs || 0);
    const waitedSeconds = Number(message.metadata?.waitedSeconds || 0);
    const seconds = Math.max(1, Math.round(durationMs ? durationMs / 1000 : waitedSeconds || 1));
    return {
      title: done ? `思考完成 · ${seconds}s` : "正在思考",
      detail: message.content,
      icon: icons.activity,
      tone: done ? "done" : "pending",
      spinner: !done,
    };
  }
  if (type === "exit") {
    const ok = message.metadata?.code === 0;
    return { title: ok ? "任务完成" : "任务失败", detail: message.content, icon: ok ? icons.check : icons.close, tone: ok ? "done" : "error" };
  }
  if (message.senderType === "system") return { title: "系统提示", detail: message.content, icon: icons.info, tone: "system" };
  return { title: "工具事件", detail: message.content, icon: icons.terminal, tone: "tool" };
}

function renderRightRail(team, session) {
  const cli = cliStatus();
  const agents = state.agents.filter((agent) => agent.teamId === team.id);
  const permissions = session ? state.permissions.filter((permission) => permission.sessionId === session.id) : [];
  const pendingPermissions = permissions.filter((permission) => permission.status === "pending");
  const decidedPermissions = permissions.filter((permission) => permission.status !== "pending").slice(-6).reverse();
  const files = session ? state.fileChanges.filter((file) => file.sessionId === session.id) : [];
  return `
    <aside class="panel" id="right-rail">
      <div class="panel-header"><h2 class="panel-title">运行侧栏</h2>${badge(cli.label, cli.tone)}</div>
      <div class="side-stack">
        <div class="side-card">
          <h4>Claude Code CLI</h4>
          <p>${escapeHtml(cli.message)}</p>
        </div>
        <div class="side-card">
          <h4>Agent 状态</h4>
          ${agents.map((agent) => {
            const status = effectiveAgentStatus(agent, session);
            return `<div class="agent-row"><div><strong>${escapeHtml(agent.name)}</strong><p>${escapeHtml(agent.command)} · ${escapeHtml(status.label)}</p></div><span title="${escapeHtml(status.label)}" class="status-dot ${status.className}"></span></div>`;
          }).join("")}
        </div>
        <div class="side-card">
          <h4>权限请求</h4>
          ${pendingPermissions.map(renderPermission).join("") || "<p>当前没有待处理权限。MCP 工具请求会在这里出现，可选择允许一次、总是允许工具或总是允许 server。</p>"}
          ${
            decidedPermissions.length
              ? `<details class="permission-history"><summary>已处理记录 ${badge(decidedPermissions.length)}</summary>${decidedPermissions.map(renderPermission).join("")}</details>`
              : ""
          }
        </div>
        ${renderToolApprovalPolicy(session)}
        <div class="side-card">
          <h4>文件变更</h4>
          ${files.map((file) => `<div class="file-row"><span>${badge(file.changeType, file.changeType === "deleted" ? "red" : "green")}</span><div><strong>${escapeHtml(file.path)}</strong><p>${fmt(file.createdAt)}</p></div></div>`).join("") || "<p>暂无文件变更。</p>"}
        </div>
      </div>
    </aside>
  `;
}

function renderToolApprovalPolicy(session) {
  if (!session) return "";
  const approvals = session.toolApprovals || {};
  const tools = [...(approvals.alwaysTools || [])];
  const servers = [...(approvals.alwaysServers || [])];
  const onceTools = [...(approvals.onceTools || [])];
  const rows = [
    ...servers.map((server) => ({ scope: "server", value: server, label: `server: ${server}`, tone: "blue" })),
    ...tools.map((tool) => ({ scope: "tool", value: tool, label: `tool: ${tool}`, tone: "green" })),
    ...onceTools.map((tool) => ({ scope: "tool", value: tool, label: `本轮: ${tool}`, tone: "amber" })),
  ];
  return `
    <div class="side-card">
      <h4>权限记忆</h4>
      ${
        rows.length
          ? rows.map((row) => `
            <div class="approval-row">
              <div>${badge(row.scope, row.tone)}<strong>${escapeHtml(row.label)}</strong></div>
              <button class="icon-button" title="撤销" data-remove-approval-scope="${row.scope}" data-remove-approval-value="${escapeHtml(row.value)}">${icons.close}</button>
            </div>
          `).join("")
          : "<p>暂无已记住的工具授权。选择“总是允许工具/server”后会显示在这里。</p>"
      }
    </div>
  `;
}

function effectiveAgentStatus(agent, session) {
  if (session?.agentId === agent.id) {
    if (session.status === "running") return { label: "运行中", className: "running" };
    if (session.status === "waiting_permission") return { label: "等待审批", className: "waiting" };
    if (session.status === "failed" || session.status === "stopped") return { label: "异常/已停止", className: "error" };
    if (session.status === "completed" || session.status === "idle") return state.claudeConfig.available ? { label: "空闲可用", className: "ready" } : { label: "未就绪", className: "" };
  }
  if (agent.status === "running") return { label: "运行中", className: "running" };
  if (agent.status === "waiting") return { label: "等待审批", className: "waiting" };
  if (state.claudeConfig.available) return { label: "空闲可用", className: "ready" };
  return { label: "未就绪", className: "" };
}

function renderPermission(permission) {
  const canAct = permission.status === "pending" && canApprove(permission);
  if (permission.type === "mcp_tool") return renderMcpPermission(permission, canAct);
  return `
    <div class="permission-card">
      <div class="meta">${badge(permission.type, "amber")} ${badge(permission.risk, permission.risk === "high" ? "red" : "amber")}</div>
      <h4>${escapeHtml(permission.summary)}</h4>
      ${renderPermissionInput(permission)}
      <div class="meta">过期 ${fmt(permission.expiresAt)} · ${escapeHtml(permission.status)}</div>
      <div class="toolbar">
        <button class="button primary" data-permission="${permission.id}" data-decision="approved" ${canAct ? "" : "disabled"}>${icons.check}批准</button>
        <button class="button danger" data-permission="${permission.id}" data-decision="rejected" ${canAct ? "" : "disabled"}>${icons.close}拒绝</button>
      </div>
    </div>
  `;
}

function pendingSelectedPermission() {
  return state.permissions.find((permission) => permission.sessionId === state.selectedSessionId && permission.status === "pending" && canApprove(permission));
}

function renderPermissionOverlay() {
  return "";
}

function renderMcpPermission(permission, canAct) {
  return `
    <div class="permission-card">
      <div class="meta">${badge("MCP 工具", "amber")} ${permission.serverName ? badge(permission.serverName, "blue") : ""}</div>
      <h4>${escapeHtml(permission.summary)}</h4>
      <p>${escapeHtml(permission.reason || "Claude Code 请求使用该工具。")}</p>
      ${renderPermissionInput(permission)}
      <div class="meta">过期 ${fmt(permission.expiresAt)} · ${escapeHtml(permission.status)}</div>
      <div class="permission-actions">
        <button class="button primary" data-permission="${permission.id}" data-decision="allow_once" ${canAct ? "" : "disabled"}>允许一次</button>
        <button class="button" data-permission="${permission.id}" data-decision="allow_always_tool" ${canAct ? "" : "disabled"}>总是允许工具</button>
        <button class="button" data-permission="${permission.id}" data-decision="allow_always_server" ${canAct && permission.serverName ? "" : "disabled"}>总是允许 server</button>
        <button class="button danger" data-permission="${permission.id}" data-decision="rejected" ${canAct ? "" : "disabled"}>${icons.close}拒绝</button>
      </div>
    </div>
  `;
}

function renderPermissionInput(permission) {
  const input = permission.toolInput && typeof permission.toolInput === "object" ? permission.toolInput : {};
  const primary = [];
  const secondary = [];
  const used = new Set();
  const addField = (key, label, tone = "") => {
    if (input[key] === undefined || input[key] === null || input[key] === "") return;
    primary.push({ key, label, value: input[key], tone });
    used.add(key);
  };

  if (Array.isArray(input.questions)) {
    primary.push({ key: "questions", label: "问题", value: renderQuestionSummary(input.questions), html: true });
    used.add("questions");
  }
  addField("sql", "SQL", "code");
  addField("query", "查询");
  addField("command", "命令", "code");
  addField("path", "路径");
  addField("file_path", "文件");
  addField("pattern", "匹配模式");
  addField("url", "URL");
  addField("description", "说明");

  Object.entries(input).forEach(([key, value]) => {
    if (used.has(key)) return;
    secondary.push({ key, label: key, value });
  });

  if (!primary.length && permission.payload) {
    primary.push({ key: "payload", label: "请求内容", value: permission.payload });
  }

  return `
    <div class="permission-fields">
      ${primary.map(renderPermissionField).join("")}
      ${
        secondary.length
          ? `<details class="permission-extra"><summary>查看次要参数</summary>${secondary.map(renderPermissionField).join("")}</details>`
          : ""
      }
    </div>
  `;
}

function renderPermissionField(field) {
  const value = field.html ? field.value : escapeHtml(compactText(field.value));
  const valueHtml = field.tone === "code" ? `<pre class="permission-code">${value}</pre>` : `<div class="permission-value">${value}</div>`;
  return `
    <div class="permission-field">
      <div class="permission-label">${escapeHtml(field.label)}</div>
      ${valueHtml}
    </div>
  `;
}

function renderQuestionSummary(questions) {
  return questions
    .map((question, index) => {
      const options = Array.isArray(question.options)
        ? question.options.map((option) => `<li><strong>${escapeHtml(option.label || "")}</strong>${option.description ? `<span>${escapeHtml(option.description)}</span>` : ""}</li>`).join("")
        : "";
      return `
        <div class="question-summary">
          <strong>${escapeHtml(question.header || `问题 ${index + 1}`)}</strong>
          <p>${escapeHtml(question.question || "")}</p>
          ${options ? `<ul>${options}</ul>` : ""}
        </div>
      `;
    })
    .join("");
}

function renderSettings() {
  const cfg = state.claudeConfig;
  const info = state.serverInfo || {};
  const inventory = state.toolInventory || { tools: [], servers: [] };
  const compactWindow = Math.floor(Number(cfg.modelContextTokens || 1000000) * Number(cfg.autoCompactRatio || 0.62));
  const actions = `<button class="button primary" data-action="health-check">${icons.check}运行健康检查</button>`;
  return appRoot(`
    ${topbar("Agent 设置", "配置 Claude Code CLI、工作区 allowlist 和运行策略", actions)}
    <section class="content settings-layout">
      <div class="grid">
        <div class="card" style="padding:18px">
          <div class="health-grid">
            <div class="metric"><div class="metric-label">可用性</div><div class="metric-value">${cfg.available ? "Available" : "Down"}</div></div>
            <div class="metric"><div class="metric-label">版本</div><div class="metric-value">${escapeHtml(cfg.version)}</div></div>
            <div class="metric"><div class="metric-label">登录态</div><div class="metric-value">${cfg.authenticated ? "OK" : "Missing"}</div></div>
            <div class="metric"><div class="metric-label">延迟</div><div class="metric-value">${cfg.latencyMs}ms</div></div>
          </div>
        </div>
        <form class="card" style="padding:18px" data-form="config">
          <div class="grid two">
            <div class="field"><label>CLI 命令</label><input class="input" name="command" value="${escapeHtml(cfg.command)}" /></div>
            <div class="field"><label>启动参数</label><input class="input" name="args" value="${escapeHtml(cfg.args)}" /></div>
          </div>
          <div class="field"><label>Workspace allowlist 根目录</label><input class="input" name="workspaceRoot" value="${escapeHtml(cfg.workspaceRoot)}" /></div>
          <div class="grid two">
            <div class="field"><label>模型上下文窗口 tokens</label><input class="input" name="modelContextTokens" type="number" min="1000" step="1000" value="${escapeHtml(cfg.modelContextTokens || 1000000)}" /></div>
            <div class="field"><label>自动压缩阈值</label><input class="input" name="autoCompactRatio" type="number" min="0.1" max="0.9" step="0.01" value="${escapeHtml(cfg.autoCompactRatio || 0.62)}" /></div>
          </div>
          <label class="toggle-row"><input type="checkbox" name="autoCompactEnabled" ${cfg.autoCompactEnabled === false ? "" : "checked"} />启用 Claude Code SDK 原生 auto compact，当前约 ${compactWindow.toLocaleString()} tokens 触发</label>
          <div class="field">
            <label>MCP 工具 allowlist</label>
            <textarea class="textarea" name="mcpToolAllowlist" placeholder="每行一个工具名，例如 mcp__data_connector__run_mc_query">${escapeHtml((cfg.mcpToolAllowlist || []).join("\n"))}</textarea>
            <div class="helper">这里仅用于 WebUI 预授权和审批识别，不会替代宿主机 Claude Code 的 MCP 配置。留空时仍以 Claude Code 运行时暴露的工具为准。</div>
          </div>
          <button class="button primary" type="submit">保存配置</button>
        </form>
        <div class="card" style="padding:18px">
          <h3 class="section-heading">运行信息</h3>
          <div class="info-grid">
            <div><span>WebUI</span><strong>${escapeHtml(info.appVersion || "unknown")}</strong></div>
            <div><span>Node</span><strong>${escapeHtml(info.nodeVersion || "unknown")}</strong></div>
            <div><span>Agent SDK</span><strong>${escapeHtml(info.sdkPackage || "unknown")}</strong></div>
            <div><span>启动时间</span><strong>${info.startedAt ? fmt(info.startedAt) : "unknown"}</strong></div>
            <div><span>数据目录</span><strong>${escapeHtml(info.dataDir || "")}</strong></div>
            <div><span>Workspace Root</span><strong>${escapeHtml(info.workspaceRoot || "")}</strong></div>
          </div>
        </div>
      </div>
      <aside class="panel">
        <div class="panel-header"><h2 class="panel-title">能力状态</h2>${badge("server adapter", "blue")}</div>
        <div class="side-stack">
          <div class="side-card"><h4>Health Check</h4><p>${escapeHtml(cfg.message || "运行健康检查后会显示 Claude Code CLI 状态。")}</p></div>
          <div class="side-card"><h4>MCP 工具清单</h4>${renderToolInventory(inventory)}</div>
          <div class="side-card"><h4>Streaming</h4><p>统一为 message_delta / message_done 事件。</p></div>
          <div class="side-card"><h4>Permission Prompts</h4><p>文件写入、命令执行和越界访问会进入审批队列。</p></div>
          <div class="side-card"><h4>Process Isolation</h4><p>每个会话按 PRD 预留独立 CLI 进程模型。</p></div>
        </div>
      </aside>
    </section>
  `);
}

function renderToolInventory(inventory) {
  const tools = inventory.tools || [];
  const servers = inventory.servers || [];
  if (!tools.length && !servers.length) return "<p>WebUI 尚未缓存 MCP 工具清单。这不代表宿主机 Claude Code 没有 MCP；实际可用工具以 Claude Code 运行时为准，首次使用或审批后会显示在这里。</p>";
  return `
    <div class="inventory-list">
      ${servers.map((server) => `<div>${badge("server", "blue")}<code>${escapeHtml(server)}</code></div>`).join("")}
      ${tools.map((tool) => `<div>${badge("tool", "green")}<code>${escapeHtml(tool)}</code></div>`).join("")}
    </div>
  `;
}

function renderUsers() {
  const rows = state.users
    .map((user) => `
      <tr>
        <td><strong>${escapeHtml(user.displayName)}</strong><div class="meta">${escapeHtml(user.email)}</div></td>
        <td>${escapeHtml(user.username)}</td>
        <td>${badge(user.role, user.role === "admin" ? "blue" : "")}</td>
        <td>${badge(user.status, user.status === "active" ? "green" : "red")}</td>
        <td>
          <div class="user-actions">
            <form class="inline-password-form" data-form="admin-password" data-user-id="${user.id}">
              <input class="input compact-input" name="newPassword" type="password" autocomplete="new-password" placeholder="新密码" required />
              <button class="button" type="submit">改密码</button>
            </form>
            <button class="button" data-toggle-user="${user.id}" ${user.id === state.currentUserId ? "disabled" : ""}>${user.status === "active" ? "禁用" : "启用"}</button>
          </div>
        </td>
      </tr>
    `)
    .join("");
  return appRoot(`
    ${topbar("用户管理", "系统管理员创建用户、禁用账号和重置成员访问", "")}
    <section class="content grid">
      <form class="card form-row" style="padding:16px" data-form="user">
        <div class="field"><label>用户名</label><input class="input" name="username" required /></div>
        <div class="field"><label>显示名</label><input class="input" name="displayName" required /></div>
        <div class="field"><label>初始密码</label><input class="input" name="password" type="password" autocomplete="new-password" required /></div>
        <div class="field"><label>角色</label><select class="select" name="role"><option value="member">member</option><option value="admin">admin</option></select></div>
        <button class="button primary" type="submit">${icons.plus}创建用户</button>
      </form>
      <table class="table"><thead><tr><th>用户</th><th>账号</th><th>系统角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>
    </section>
  `);
}

function renderAudit() {
  const rows = state.auditLogs
    .slice()
    .reverse()
    .map((log) => `<div class="audit-row"><strong>${escapeHtml(log.action)}</strong><div class="meta"><span>${escapeHtml(userName(log.userId))}</span><span>${escapeHtml(log.targetType || "")}</span><span>${fmt(log.createdAt)}</span></div></div>`)
    .join("");
  return appRoot(`${topbar("审计日志", "记录登录、成员、权限和 Agent 配置动作", "")}<section class="content"><div class="audit-list">${rows}</div></section>`);
}

function statusTone(status) {
  return status === "running" ? "green" : status === "waiting_permission" ? "amber" : status === "failed" || status === "stopped" ? "red" : "blue";
}

function renderModal(kind, teamId = state.selectedTeamId) {
  if (!kind) return "";
  if (kind === "password") {
    return `
      <div class="modal-backdrop" data-close-modal>
        <form class="modal" data-form="password">
          <div class="modal-head"><h3>修改密码</h3></div>
          <div class="modal-body grid">
            <div class="field"><label>当前密码</label><input class="input" name="currentPassword" type="password" autocomplete="current-password" required /></div>
            <div class="field"><label>新密码</label><input class="input" name="newPassword" type="password" autocomplete="new-password" required /></div>
            <div class="field"><label>确认新密码</label><input class="input" name="confirmPassword" type="password" autocomplete="new-password" required /></div>
            <div class="helper">修改后，除当前浏览器外的其他登录态会失效。</div>
          </div>
          <div class="modal-actions"><button class="button" type="button" data-close-modal>取消</button><button class="button primary" type="submit">保存</button></div>
        </form>
      </div>
    `;
  }
  if (kind === "team") {
    if (!isSystemAdmin()) return "";
    return `
      <div class="modal-backdrop" data-close-modal>
        <form class="modal" data-form="team">
          <div class="modal-head"><h3>创建团队</h3></div>
          <div class="modal-body">
            <div class="field"><label>团队名称</label><input class="input" name="name" required /></div>
            <div class="field"><label>工作区目录</label><input class="input" name="workspacePath" value="${escapeHtml(state.claudeConfig.workspaceRoot)}/" required /></div>
          </div>
          <div class="modal-actions"><button class="button" type="button" data-close-modal>取消</button><button class="button primary" type="submit">创建</button></div>
        </form>
      </div>
    `;
  }
  if (kind === "workspace") return renderWorkspaceModal(teamId);
  const team = state.teams.find((item) => item.id === teamId);
  const memberRows = state.members
    .filter((member) => member.teamId === teamId)
    .map((member) => {
      const user = state.users.find((item) => item.id === member.userId);
      return `
        <div class="member-row compact-member-row">
          <div><strong>${escapeHtml(user?.displayName || "")}</strong><span>${escapeHtml(user?.username || "")}</span></div>
          <div class="member-actions">
            ${badge(member.role, member.role === "viewer" ? "" : "green")}
            ${isSystemAdmin() ? `<button class="icon-button" type="button" title="移除成员" data-remove-member-team="${teamId}" data-remove-member-user="${member.userId}">${icons.close}</button>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
  const options = state.users
    .filter((user) => !state.members.some((member) => member.teamId === teamId && member.userId === user.id))
    .map((user) => `<option value="${user.id}">${escapeHtml(user.displayName)}</option>`)
    .join("");
  return `
    <div class="modal-backdrop" data-close-modal>
      <div class="modal members-modal">
        <div class="modal-head"><h3>${escapeHtml(team?.name || "")} 成员</h3></div>
        <div class="modal-body members-modal-body">
          <div class="member-list">
            ${memberRows || '<div class="empty">还没有成员</div>'}
          </div>
          <form class="form-row" data-form="member" data-team="${teamId}">
            <div class="field"><label>用户</label><select class="select" name="userId">${options}</select></div>
            <div class="field"><label>角色</label><select class="select" name="role"><option value="member">member</option><option value="admin">admin</option><option value="viewer">viewer</option></select></div>
            <button class="button primary" type="submit" ${canManageTeam(teamId) && options ? "" : "disabled"}>${icons.plus}添加</button>
          </form>
        </div>
        <div class="modal-actions"><button class="button" data-close-modal>关闭</button></div>
      </div>
    </div>
  `;
}

function renderWorkspaceModal(teamId) {
  const team = state.teams.find((item) => item.id === teamId);
  return `
    <div class="modal-backdrop" data-close-modal>
      <form class="modal" data-form="workspace" data-team="${teamId}">
        <div class="modal-head"><h3>团队工作区</h3></div>
        <div class="modal-body">
          <div class="field"><label>工作区目录</label><input class="input" name="workspacePath" value="${escapeHtml(team?.workspacePath || state.claudeConfig.workspaceRoot || "")}" required /></div>
          <div class="helper">目录必须位于系统 allowlist 内：${escapeHtml(state.claudeConfig.workspaceRoot || "")}</div>
        </div>
        <div class="modal-actions"><button class="button" type="button" data-close-modal>取消</button><button class="button primary" type="submit" ${canManageTeam(teamId) ? "" : "disabled"}>保存</button></div>
      </form>
    </div>
  `;
}

let activeModal = "";
let modalTeamId = "";

function showError(err) {
  alert(err?.message || "操作失败");
}

function render() {
  const snapshot = captureUiSnapshot();
  if (!state.currentUserId) {
    renderLogin();
    return;
  }
  let html = "";
  if (state.activeView === "settings") html = renderSettings();
  else if (state.activeView === "users") html = renderUsers();
  else if (state.activeView === "audit") html = renderAudit();
  else if (state.activeView === "team") html = renderTeamDetail();
  else html = renderTeams();
  document.querySelector("#app").innerHTML = html + renderModal(activeModal, modalTeamId) + renderPermissionOverlay();
  restoreUiSnapshot(snapshot);
}

function renderTeamParts(parts = {}) {
  if (!state.currentUserId || state.activeView !== "team") {
    render();
    return;
  }
  const team = state.teams.find((item) => item.id === state.selectedTeamId) || state.teams[0];
  if (!team) {
    render();
    return;
  }
  const sessions = state.sessions.filter((session) => session.teamId === team.id);
  const session = state.sessions.find((item) => item.id === state.selectedSessionId && item.teamId === team.id) || sessions[0];
  if (session && state.selectedSessionId !== session.id) state.selectedSessionId = session.id;
  const snapshot = captureUiSnapshot();
  const rail = document.querySelector("#team-rail");
  const chat = document.querySelector("#chat-panel");
  const right = document.querySelector("#right-rail");
  if (parts.rail && rail) rail.outerHTML = renderTeamRail(team, session);
  if (parts.chat && chat) chat.outerHTML = renderChat(team, session);
  if (parts.right && right) right.outerHTML = renderRightRail(team, session);
  if ((parts.rail && !rail) || (parts.chat && !chat) || (parts.right && !right)) {
    render();
    return;
  }
  restoreUiSnapshot(snapshot);
}

function patchVisibleMessage(messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message || state.activeView !== "team" || message.sessionId !== state.selectedSessionId) return false;
  const element = document.querySelector(`[data-message-id="${cssEscape(messageId)}"]`);
  if (!element) return false;
  const snapshot = captureUiSnapshot();
  const html = renderMessage(message).trim();
  if (html) element.outerHTML = html;
  else element.remove();
  restoreUiSnapshot(snapshot);
  return true;
}

function captureUiSnapshot() {
  const active = document.activeElement;
  const activeInfo = active
    ? {
        selector: focusSelector(active),
        start: typeof active.selectionStart === "number" ? active.selectionStart : null,
        end: typeof active.selectionEnd === "number" ? active.selectionEnd : null,
      }
    : null;
  document.querySelectorAll("[data-session-draft]").forEach((field) => {
    uiMemory.composerDrafts.set(field.dataset.sessionDraft, field.value);
  });
  document.querySelectorAll("[data-turn-events]").forEach((details) => {
    uiMemory.openTurnEvents.set(details.dataset.turnEvents, details.open);
  });
  const stream = document.querySelector("#chat-stream");
  const streamDistanceFromBottom = stream ? stream.scrollHeight - stream.scrollTop - stream.clientHeight : 0;
  const scrolls = scrollSnapshot();
  return {
    view: state.activeView,
    sessionId: state.selectedSessionId,
    activeInfo,
    streamWasNearBottom: stream ? streamDistanceFromBottom < 96 : true,
    scrolls,
  };
}

function restoreUiSnapshot(snapshot = {}) {
  restoreScrollSnapshot(snapshot);
  restoreFocus(snapshot.activeInfo);
}

function scrollSnapshot() {
  const selectors = ["#chat-stream", ".session-section .session-list", ".team-layout > .panel:last-child .side-stack", ".sidebar", ".main"];
  const snapshot = {};
  selectors.forEach((selector) => {
    const element = document.querySelector(selector);
    if (!element) return;
    snapshot[selector] = {
      top: element.scrollTop,
      left: element.scrollLeft,
      distanceFromBottom: element.scrollHeight - element.scrollTop - element.clientHeight,
    };
  });
  return snapshot;
}

function restoreScrollSnapshot(snapshot = {}) {
  Object.entries(snapshot.scrolls || {}).forEach(([selector, value]) => {
    const element = document.querySelector(selector);
    if (!element) return;
    if (selector === "#chat-stream" && snapshot.view === state.activeView && snapshot.sessionId === state.selectedSessionId) {
      element.scrollTop = snapshot.streamWasNearBottom ? element.scrollHeight : Math.max(0, element.scrollHeight - element.clientHeight - value.distanceFromBottom);
      element.scrollLeft = value.left || 0;
      return;
    }
    element.scrollTop = value.top || 0;
    element.scrollLeft = value.left || 0;
  });
}

function focusSelector(element) {
  if (!element?.matches) return "";
  if (element.matches("[data-session-draft]")) return `[data-session-draft="${cssEscape(element.dataset.sessionDraft)}"]`;
  if (element.id) return `#${cssEscape(element.id)}`;
  const name = element.getAttribute("name");
  if (name && element.closest("form")?.dataset.form) return `form[data-form="${cssEscape(element.closest("form").dataset.form)}"] [name="${cssEscape(name)}"]`;
  return "";
}

function restoreFocus(activeInfo) {
  if (!activeInfo?.selector) return;
  const element = document.querySelector(activeInfo.selector);
  if (!element || element.disabled) return;
  element.focus({ preventScroll: true });
  if (typeof element.setSelectionRange === "function" && activeInfo.start !== null && activeInfo.end !== null) {
    element.setSelectionRange(activeInfo.start, activeInfo.end);
  }
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(String(value));
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function login(form) {
  const data = new FormData(form);
  const username = String(data.get("username") || "").trim();
  const password = String(data.get("password") || "");
  try {
    await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
    state.activeView = "teams";
    await refresh();
  } catch (err) {
    renderLogin(err.message || "用户名或密码不正确");
  }
}

async function createTeam(form) {
  const data = new FormData(form);
  const payload = {
    name: String(data.get("name")),
    workspacePath: String(data.get("workspacePath")),
  };
  const result = await api("/api/teams", { method: "POST", body: JSON.stringify(payload) });
  activeModal = "";
  state.selectedTeamId = result.team.id;
  state.activeView = "team";
  await refresh();
}

async function createSession() {
  const team = state.teams.find((item) => item.id === state.selectedTeamId);
  const result = await api(`/api/teams/${team.id}/sessions`, { method: "POST", body: "{}" });
  state.selectedSessionId = result.session.id;
  state.sessions = upsertById(state.sessions, result.session);
  scheduleTeamRender({ rail: true, chat: true, right: true }, 0);
}

async function sendMessage(form, submitter = null) {
  const session = sessionById(state.selectedSessionId);
  const content = String(new FormData(form).get("content") || "").trim();
  if (!session || !content) return;
  const mode = submitter?.value || "send";
  await api(`/api/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ content, mode }) });
  uiMemory.composerDrafts.delete(session.id);
  form.reset();
}

async function decidePermission(id, decision) {
  const permission = state.permissions.find((item) => item.id === id);
  if (!permission || !canApprove(permission)) return;
  const action = decision === "rejected" ? "reject" : "approve";
  await api(`/api/permissions/${id}/${action}`, { method: "POST", body: JSON.stringify({ decision }) });
}

async function deleteSession(id) {
  const session = sessionById(id);
  if (!session) return;
  if (!confirm(`删除会话「${session.title}」？此操作会同时删除消息和权限记录。`)) return;
  await api(`/api/sessions/${id}`, { method: "DELETE" });
  if (state.selectedSessionId === id) {
    const next = state.sessions.find((item) => item.teamId === session.teamId && item.id !== id);
    state.selectedSessionId = next?.id || "";
  }
  state.sessions = state.sessions.filter((item) => item.id !== id);
  state.messages = state.messages.filter((message) => message.sessionId !== id);
  state.permissions = state.permissions.filter((permission) => permission.sessionId !== id);
  scheduleTeamRender({ rail: true, chat: true, right: true }, 0);
}

async function deleteTeam(id) {
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

async function removeMember(teamId, userId) {
  if (!isSystemAdmin()) return;
  const user = state.users.find((item) => item.id === userId);
  if (!confirm(`从团队中移除「${user?.displayName || user?.username || userId}」？`)) return;
  await api(`/api/teams/${teamId}/members/${userId}`, { method: "DELETE" });
  state.members = state.members.filter((member) => !(member.teamId === teamId && member.userId === userId));
  render();
}

async function toggleSessionVisibility() {
  const session = sessionById(state.selectedSessionId);
  if (!session || !canManageSession(session)) return;
  const nextVisibility = sessionVisibility(session) === "team" ? "private" : "team";
  const result = await api(`/api/sessions/${session.id}/visibility`, { method: "PATCH", body: JSON.stringify({ visibility: nextVisibility }) });
  state.sessions = upsertById(state.sessions, result.session);
  scheduleTeamRender({ rail: true, chat: true, right: true }, 0);
}

async function removeToolApproval(scope, value) {
  const session = sessionById(state.selectedSessionId);
  if (!session) return;
  const result = await api(`/api/sessions/${session.id}/tool-approvals`, { method: "DELETE", body: JSON.stringify({ scope, value }) });
  state.sessions = upsertById(state.sessions, result.session);
  scheduleTeamRender({ chat: true, right: true }, 0);
}

async function retrySession() {
  const session = sessionById(state.selectedSessionId);
  if (!session) return;
  await api(`/api/sessions/${session.id}/retry`, { method: "POST", body: "{}" });
  await refresh();
}

async function copyText(text) {
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

async function createUser(form) {
  const data = new FormData(form);
  const username = String(data.get("username")).trim();
  const payload = {
    username,
    password: String(data.get("password") || ""),
    displayName: String(data.get("displayName")).trim(),
    email: `${username}@example.com`,
    role: String(data.get("role")),
  };
  await api("/api/users", { method: "POST", body: JSON.stringify(payload) });
  form.reset();
  await refresh();
}

async function changeOwnPassword(form) {
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
  activeModal = "";
  form.reset();
  await refresh();
}

async function resetUserPassword(form) {
  const data = new FormData(form);
  await api(`/api/users/${form.dataset.userId}/password`, {
    method: "PATCH",
    body: JSON.stringify({ newPassword: String(data.get("newPassword") || "") }),
  });
  form.reset();
  await refresh();
}

async function addMember(form) {
  const data = new FormData(form);
  const teamId = form.dataset.team;
  await api(`/api/teams/${teamId}/members`, { method: "POST", body: JSON.stringify({ userId: String(data.get("userId")), role: String(data.get("role")) }) });
  await refresh();
}

async function saveConfig(form) {
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

async function saveWorkspace(form) {
  const teamId = form.dataset.team;
  const data = new FormData(form);
  await api(`/api/teams/${teamId}`, {
    method: "PATCH",
    body: JSON.stringify({ workspacePath: String(data.get("workspacePath")).trim() }),
  });
  activeModal = "";
  await refresh();
}

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  try {
    if (kind === "login") await login(form);
    if (kind === "team") await createTeam(form);
    if (kind === "message") await sendMessage(form, event.submitter);
    if (kind === "user") await createUser(form);
    if (kind === "password") await changeOwnPassword(form);
    if (kind === "admin-password") await resetUserPassword(form);
    if (kind === "member") await addMember(form);
    if (kind === "config") await saveConfig(form);
    if (kind === "workspace") await saveWorkspace(form);
  } catch (err) {
    showError(err);
  }
});

document.addEventListener("input", (event) => {
  const field = event.target.closest?.("[data-session-draft]");
  if (!field) return;
  uiMemory.composerDrafts.set(field.dataset.sessionDraft, field.value);
});

document.addEventListener("toggle", (event) => {
  const details = event.target.closest?.("[data-turn-events]");
  if (!details) return;
  uiMemory.openTurnEvents.set(details.dataset.turnEvents, details.open);
}, true);

document.addEventListener("change", (event) => {
  const filter = event.target.closest?.("[data-session-member-filter]");
  if (!filter) return;
  const value = filter.value || "all";
  const team = state.teams.find((item) => item.id === state.selectedTeamId);
  const sessions = team ? state.sessions.filter((session) => session.teamId === team.id && (value === "all" || session.createdBy === value)) : [];
  const selectedIsVisible = sessions.some((session) => session.id === state.selectedSessionId);
  setState({
    sessionMemberFilter: value,
    selectedSessionId: selectedIsVisible ? state.selectedSessionId : sessions[0]?.id || state.selectedSessionId,
  });
});

document.addEventListener("click", async (event) => {
  try {
    if (event.target.classList?.contains("modal-backdrop")) {
      activeModal = "";
      render();
      return;
    }
    const target = event.target.closest("button");
    if (!target || target.disabled) return;

    if (target.dataset.view) return setState({ activeView: target.dataset.view });
    if (target.dataset.openTeam) return setState({ activeView: "team", selectedTeamId: target.dataset.openTeam, selectedSessionId: target.dataset.session || state.selectedSessionId, sessionMemberFilter: "all" });
    if (target.dataset.backTeams !== undefined) return setState({ activeView: "teams" });
    if (target.dataset.session) return setState({ selectedSessionId: target.dataset.session });
    if (target.dataset.action === "toggle-sidebar") {
      const collapsed = !state.sidebarCollapsed;
      localStorage.setItem("cc.sidebarCollapsed", String(collapsed));
      return setState({ sidebarCollapsed: collapsed });
    }
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
    if (target.dataset.action === "logout") {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      eventSource?.close();
      eventSource = null;
      setState({ currentUserId: null });
      return;
    }
    if (target.dataset.action === "new-session") return await createSession();
    if (target.dataset.deleteSession) return await deleteSession(target.dataset.deleteSession);
    if (target.dataset.deleteTeam) return await deleteTeam(target.dataset.deleteTeam);
    if (target.dataset.removeMemberTeam) return await removeMember(target.dataset.removeMemberTeam, target.dataset.removeMemberUser);
    if (target.dataset.action === "toggle-session-visibility") return await toggleSessionVisibility();
    if (target.dataset.action === "retry-session") return await retrySession();
    if (target.dataset.copyMessage) {
      const message = state.messages.find((item) => item.id === target.dataset.copyMessage);
      if (message) await copyText(message.content || "");
      return;
    }
    if (target.dataset.copyCode) {
      await copyText(decodeURIComponent(target.dataset.copyCode));
      return;
    }
    if (target.dataset.removeApprovalScope) return await removeToolApproval(target.dataset.removeApprovalScope, target.dataset.removeApprovalValue);
    if (target.dataset.action === "stop-session") {
      const session = sessionById(state.selectedSessionId);
      if (session) {
        await api(`/api/sessions/${session.id}/stop`, { method: "POST", body: "{}" });
      }
      return;
    }
    if (target.dataset.action === "health-check") {
      await api("/api/claude/health-check", { method: "POST", body: "{}" });
      await refresh();
      return;
    }
    if (target.dataset.permission) return await decidePermission(target.dataset.permission, target.dataset.decision);
    if (target.dataset.toggleUser) {
      await api(`/api/users/${target.dataset.toggleUser}/status`, { method: "PATCH", body: "{}" });
      await refresh();
    }
  } catch (err) {
    showError(err);
  }
});

refresh();

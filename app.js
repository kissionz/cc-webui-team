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
};

const now = () => Date.now();
const fmt = (timestamp) => new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp);

const seedState = () => ({
  currentUserId: null,
  activeView: "teams",
  selectedTeamId: "team_platform",
  selectedSessionId: "session_login",
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
    enabled: true,
    available: true,
    version: "1.0.74",
    latencyMs: 118,
    authenticated: true,
    lastCheckAt: now() - 1000 * 60 * 16,
  },
});

let state = loadState();
let eventSource = null;
let refreshTimer = null;
let renderTimer = null;

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
    scheduleRender();
    return;
  }

  if (event.type === "session.message.delta") {
    state.messages = state.messages.map((message) => (message.id === event.messageId ? { ...message, content: `${message.content || ""}${event.text || ""}`, createdAt: message.createdAt } : message));
    scheduleRender();
    return;
  }

  if (event.type === "session.message.updated" && event.message) {
    state.messages = state.messages.map((message) => (message.id === event.message.id ? event.message : message));
    scheduleRender();
    return;
  }

  if (event.type === "session.status.changed") {
    state.sessions = state.sessions.map((session) => (session.id === event.sessionId ? { ...session, status: event.status, updatedAt: now() } : session));
    scheduleRender();
    return;
  }

  if (event.type === "session.deleted") {
    state.sessions = state.sessions.filter((session) => session.id !== event.sessionId);
    state.messages = state.messages.filter((message) => message.sessionId !== event.sessionId);
    if (state.selectedSessionId === event.sessionId) state.selectedSessionId = "";
    scheduleRender();
    return;
  }

  scheduleRefresh();
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

function badge(text, tone = "") {
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

function appRoot(inner) {
  const user = currentUser();
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">CC</div>
          <div>
            <div class="brand-title">Claude Code</div>
            <div class="brand-subtitle">Team Platform</div>
          </div>
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
          <button class="nav-button" style="margin-top:12px" data-action="logout">${icons.logout}<span>退出</span></button>
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
  return `<button class="nav-button ${active ? "active" : ""}" data-view="${view}">${icon}<span>${text}</span></button>`;
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
          <div class="field"><label>用户名</label><input class="input" name="username" value="admin" autocomplete="username" /></div>
          <div class="field"><label>密码</label><input class="input" name="password" type="password" autocomplete="current-password" /></div>
          ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
          <button class="button primary" style="width:100%" type="submit">登录</button>
          <div class="helper">数据由服务端持久化。首次部署请立刻修改默认管理员密码。</div>
        </form>
      </section>
    </div>
  `;
}

function renderTeams() {
  const user = currentUser();
  const teams = user.role === "admin" ? state.teams : state.teams.filter((team) => teamRole(team.id));
  const actions = `<button class="button primary" data-modal="team">${icons.plus}创建团队</button>`;
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
        <div class="health-pill ${state.claudeConfig.available ? "ok" : "down"}">
          <span class="status-dot ${state.claudeConfig.available ? "ready" : "error"}"></span>
          <div><strong>${state.claudeConfig.available ? "CLI 可用" : "CLI 未就绪"}</strong><span>${escapeHtml(state.claudeConfig.version || "未检测")}</span></div>
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
                <strong>${escapeHtml(session.title)}</strong>
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
    <button class="button primary" data-action="new-session" ${canWriteTeam(team.id) ? "" : "disabled"}>${icons.plus}新会话</button>
  `;

  return appRoot(`
    ${topbar(team.name, `${team.workspacePath} · 我的角色 ${role}`, actions)}
    <section class="content">
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
    <aside class="panel team-rail">
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
  const sessions = state.sessions.filter((session) => session.teamId === team.id);
  return `
    <section class="${embedded ? "session-section" : "panel"}">
      <div class="panel-header"><h2 class="panel-title">会话</h2>${badge(`${sessions.length}`)}</div>
      <div class="session-list">
        ${sessions
          .map((session) => `
            <div class="session-row">
              <button class="session-item ${session.id === activeSession?.id ? "active" : ""}" data-session="${session.id}">
                <strong>${escapeHtml(session.title)}</strong>
                <div class="meta">${badge(session.status, statusTone(session.status))}<span>${fmt(session.updatedAt)}</span></div>
              </button>
              <button class="icon-button session-delete" title="删除会话" data-delete-session="${session.id}">${icons.close}</button>
            </div>
          `)
          .join("") || '<div class="empty">还没有会话</div>'}
      </div>
    </section>
  `;
}

function renderChat(team, session) {
  if (!session) {
    return `<section class="panel chat-panel"><div class="empty">创建一个 Claude Code 会话开始协作</div></section>`;
  }
  const messages = state.messages.filter((message) => message.sessionId === session.id);
  const turns = buildMessageTurns(messages);
  const canSend = canWriteTeam(team.id) && !["running", "waiting_permission"].includes(session.status);
  const placeholder = composerPlaceholder(team, session);
  return `
    <section class="panel chat-panel">
      <div class="panel-header">
        <h2 class="panel-title">${escapeHtml(session.title)}</h2>
        <div class="toolbar">
          ${badge(session.status, statusTone(session.status))}
          <button class="icon-button" title="停止会话" data-action="stop-session" ${session.status === "running" ? "" : "disabled"}>${icons.stop}</button>
        </div>
      </div>
      <div class="chat-stream" id="chat-stream">
        ${turns.map(renderTurn).join("")}
      </div>
      <form class="composer" data-form="message">
        <textarea class="textarea" name="content" placeholder="${escapeHtml(placeholder)}" ${canSend ? "" : "disabled"}></textarea>
        <button class="button primary" type="submit" ${canSend ? "" : "disabled"}>${icons.send}发送</button>
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
  const eventMessages = turn.messages.filter((message) => message.senderType !== "agent");
  const hasAgentOutput = agentMessages.some((message) => String(message.content || "").trim());
  return `
    <section class="turn">
      ${turn.user ? renderMessage(turn.user) : ""}
      ${agentMessages.map(renderMessage).join("")}
      ${eventMessages.length ? renderTurnEvents(eventMessages, hasAgentOutput) : ""}
    </section>
  `;
}

function renderTurnEvents(messages, collapsed) {
  const content = messages.map(renderTimelineEvent).join("");
  if (!collapsed) return `<div class="turn-events">${content}</div>`;
  return `<details class="turn-events collapsed"><summary>${icons.terminal}<span>本轮运行记录</span><strong>${messages.length}</strong></summary>${content}</details>`;
}

function composerPlaceholder(team, session) {
  if (!canWriteTeam(team.id)) return "viewer 角色只能查看会话";
  if (session.status === "idle") return "向 Claude Code 发送任务";
  if (session.status === "running") return "Claude Code 正在运行，等待输出或停止后再继续";
  if (session.status === "waiting_permission") return "当前任务等待审批";
  return "继续向 Claude Code 发送下一轮任务";
}

function renderMessage(message) {
  if (message.senderType === "tool" || message.senderType === "system") return renderTimelineEvent(message);
  if (message.senderType === "agent" && !String(message.content || "").trim()) {
    return renderTimelineEvent({ ...message, senderType: "tool", metadata: { type: "thinking" }, content: "Claude Code 正在思考，等待首个输出。" });
  }
  const sender =
    message.senderType === "user"
      ? userName(message.senderId)
      : message.senderType === "agent"
        ? agentById(message.senderId)?.name || "Agent"
        : message.senderType;
  return `
    <article class="message ${message.senderType}">
      <div class="message-meta"><span>${escapeHtml(sender)}</span><span>${fmt(message.createdAt)}</span></div>
      <div class="bubble">${escapeHtml(message.content)}</div>
    </article>
  `;
}

function renderTimelineEvent(message) {
  const event = timelineEventMeta(message);
  return `
    <article class="timeline-event ${event.tone}">
      <span class="event-icon">${event.icon}</span>
      <div class="event-body">
        <div class="event-head"><strong>${escapeHtml(event.title)}</strong><span>${fmt(message.updatedAt || message.createdAt)}</span></div>
        ${event.detail ? `<pre class="event-detail">${escapeHtml(event.detail)}</pre>` : ""}
      </div>
    </article>
  `;
}

function timelineEventMeta(message) {
  const type = message.metadata?.type || (message.senderType === "system" ? "system" : "tool");
  if (type === "command") return { title: "已运行 Claude Code", detail: message.content, icon: icons.terminal, tone: "tool" };
  if (type === "heartbeat") return { title: "正在思考", detail: message.content, icon: icons.activity, tone: "pending" };
  if (type === "thinking") return { title: "正在思考", detail: message.content, icon: icons.activity, tone: "pending" };
  if (type === "exit") {
    const ok = message.metadata?.code === 0;
    return { title: ok ? "任务完成" : "任务失败", detail: message.content, icon: ok ? icons.check : icons.close, tone: ok ? "done" : "error" };
  }
  if (message.senderType === "system") return { title: "系统提示", detail: message.content, icon: icons.info, tone: "system" };
  return { title: "工具事件", detail: message.content, icon: icons.terminal, tone: "tool" };
}

function renderRightRail(team, session) {
  const agents = state.agents.filter((agent) => agent.teamId === team.id);
  const permissions = session ? state.permissions.filter((permission) => permission.sessionId === session.id) : [];
  const files = session ? state.fileChanges.filter((file) => file.sessionId === session.id) : [];
  const toolEvents = session ? state.messages.filter((message) => message.sessionId === session.id && message.senderType === "tool").slice(-6).reverse() : [];
  const commandEvents = toolEvents.filter((message) => message.metadata?.type === "command" || /command:/i.test(message.content));
  const heartbeatTicks = toolEvents.find((event) => event.metadata?.type === "heartbeat")?.metadata?.count || 0;
  return `
    <aside class="panel">
      <div class="panel-header"><h2 class="panel-title">运行侧栏</h2>${badge("SSE ready", "blue")}</div>
      <div class="side-stack">
        <div class="side-card">
          <h4>Claude Code CLI</h4>
          <p>${state.claudeConfig.available ? `可用，版本 ${state.claudeConfig.version}，延迟 ${state.claudeConfig.latencyMs}ms` : "不可用，请到 Agent 设置检查命令路径"}</p>
        </div>
        <div class="side-card">
          <h4>Agent 状态</h4>
          ${agents.map((agent) => {
            const status = effectiveAgentStatus(agent, session);
            return `<div class="agent-row"><div><strong>${escapeHtml(agent.name)}</strong><p>${escapeHtml(agent.command)} · ${escapeHtml(status.label)}</p></div><span title="${escapeHtml(status.label)}" class="status-dot ${status.className}"></span></div>`;
          }).join("")}
        </div>
        <div class="side-card">
          <h4>运行事件</h4>
          <p>${commandEvents.length} 次命令启动 · ${heartbeatTicks} 次等待更新</p>
          ${toolEvents.map((event) => `<div class="runtime-event"><strong>${escapeHtml(runtimeEventTitle(event))}</strong><p>${escapeHtml(event.content)}</p><span>${fmt(event.createdAt)}</span></div>`).join("") || "<p>暂无运行事件。</p>"}
        </div>
        <div class="side-card">
          <h4>权限请求</h4>
          ${permissions.map(renderPermission).join("") || "<p>当前会话没有待处理权限。</p>"}
        </div>
        <div class="side-card">
          <h4>文件变更</h4>
          ${files.map((file) => `<div class="file-row"><span>${badge(file.changeType, file.changeType === "deleted" ? "red" : "green")}</span><div><strong>${escapeHtml(file.path)}</strong><p>${fmt(file.createdAt)}</p></div></div>`).join("") || "<p>暂无文件变更。</p>"}
        </div>
      </div>
    </aside>
  `;
}

function runtimeEventTitle(event) {
  const type = event.metadata?.type;
  if (type === "command") return "命令启动";
  if (type === "heartbeat") return "运行心跳";
  if (type === "exit") return "任务状态";
  return "工具事件";
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
  return `
    <div class="side-card">
      <div class="meta">${badge(permission.type, "amber")} ${badge(permission.risk, permission.risk === "high" ? "red" : "amber")}</div>
      <h4>${escapeHtml(permission.summary)}</h4>
      <p class="workspace">${escapeHtml(permission.payload)}</p>
      <div class="meta">过期 ${fmt(permission.expiresAt)} · ${escapeHtml(permission.status)}</div>
      <div class="toolbar">
        <button class="button primary" data-permission="${permission.id}" data-decision="approved" ${canAct ? "" : "disabled"}>${icons.check}批准</button>
        <button class="button danger" data-permission="${permission.id}" data-decision="rejected" ${canAct ? "" : "disabled"}>${icons.close}拒绝</button>
      </div>
    </div>
  `;
}

function renderSettings() {
  const cfg = state.claudeConfig;
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
          <button class="button primary" type="submit">保存配置</button>
        </form>
      </div>
      <aside class="panel">
        <div class="panel-header"><h2 class="panel-title">能力状态</h2>${badge("server adapter", "blue")}</div>
        <div class="side-stack">
          <div class="side-card"><h4>Health Check</h4><p>${escapeHtml(cfg.message || "运行健康检查后会显示 Claude Code CLI 状态。")}</p></div>
          <div class="side-card"><h4>Streaming</h4><p>统一为 message_delta / message_done 事件。</p></div>
          <div class="side-card"><h4>Permission Prompts</h4><p>文件写入、命令执行和越界访问会进入审批队列。</p></div>
          <div class="side-card"><h4>Process Isolation</h4><p>每个会话按 PRD 预留独立 CLI 进程模型。</p></div>
        </div>
      </aside>
    </section>
  `);
}

function renderUsers() {
  const rows = state.users
    .map((user) => `
      <tr>
        <td><strong>${escapeHtml(user.displayName)}</strong><div class="meta">${escapeHtml(user.email)}</div></td>
        <td>${escapeHtml(user.username)}</td>
        <td>${badge(user.role, user.role === "admin" ? "blue" : "")}</td>
        <td>${badge(user.status, user.status === "active" ? "green" : "red")}</td>
        <td><button class="button" data-toggle-user="${user.id}">${user.status === "active" ? "禁用" : "启用"}</button></td>
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
  if (kind === "team") {
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
      return `<div class="member-row"><strong>${escapeHtml(user?.displayName || "")}</strong><div class="meta">${escapeHtml(user?.username || "")} ${badge(member.role, member.role === "viewer" ? "" : "green")}</div></div>`;
    })
    .join("");
  const options = state.users
    .filter((user) => !state.members.some((member) => member.teamId === teamId && member.userId === user.id))
    .map((user) => `<option value="${user.id}">${escapeHtml(user.displayName)}</option>`)
    .join("");
  return `
    <div class="modal-backdrop" data-close-modal>
      <div class="modal">
        <div class="modal-head"><h3>${escapeHtml(team?.name || "")} 成员</h3></div>
        <div class="modal-body grid">
          ${memberRows}
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

function render() {
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
  document.querySelector("#app").innerHTML = html + renderModal(activeModal, modalTeamId);
  const stream = document.querySelector("#chat-stream");
  if (stream) stream.scrollTop = stream.scrollHeight;
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
  await refresh();
}

async function sendMessage(form) {
  const session = sessionById(state.selectedSessionId);
  const content = String(new FormData(form).get("content") || "").trim();
  if (!session || !content) return;
  form.reset();
  await api(`/api/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ content }) });
  await refresh();
}

async function decidePermission(id, decision) {
  const permission = state.permissions.find((item) => item.id === id);
  if (!permission || !canApprove(permission)) return;
  const action = decision === "approved" ? "approve" : "reject";
  await api(`/api/permissions/${id}/${action}`, { method: "POST", body: "{}" });
  await refresh();
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
  await refresh();
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
    if (kind === "message") await sendMessage(form);
    if (kind === "user") await createUser(form);
    if (kind === "member") await addMember(form);
    if (kind === "config") await saveConfig(form);
    if (kind === "workspace") await saveWorkspace(form);
  } catch (err) {
    alert(err.message || "操作失败");
  }
});

document.addEventListener("click", async (event) => {
  if (event.target.classList?.contains("modal-backdrop")) {
    activeModal = "";
    render();
    return;
  }
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.view) setState({ activeView: target.dataset.view });
  if (target.dataset.openTeam) setState({ activeView: "team", selectedTeamId: target.dataset.openTeam });
  if (target.dataset.backTeams !== undefined) setState({ activeView: "teams" });
  if (target.dataset.session) setState({ selectedSessionId: target.dataset.session });
  if (target.dataset.modal) {
    activeModal = target.dataset.modal;
    modalTeamId = target.dataset.team || state.selectedTeamId;
    render();
  }
  if (target.dataset.closeModal !== undefined) {
    activeModal = "";
    render();
  }
  if (target.dataset.action === "logout") {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    eventSource?.close();
    eventSource = null;
    setState({ currentUserId: null });
  }
  if (target.dataset.action === "new-session") await createSession();
  if (target.dataset.deleteSession) await deleteSession(target.dataset.deleteSession);
  if (target.dataset.action === "stop-session") {
    const session = sessionById(state.selectedSessionId);
    if (session) {
      await api(`/api/sessions/${session.id}/stop`, { method: "POST", body: "{}" });
      await refresh();
    }
  }
  if (target.dataset.action === "health-check") {
    await api("/api/claude/health-check", { method: "POST", body: "{}" });
    await refresh();
  }
  if (target.dataset.permission) await decidePermission(target.dataset.permission, target.dataset.decision);
  if (target.dataset.toggleUser) {
    await api(`/api/users/${target.dataset.toggleUser}/status`, { method: "PATCH", body: "{}" });
    await refresh();
  }
});

refresh();

import type {
  Agent, AppState, HtmlValue, Message, MessageTurn, Permission, Session, SessionGroup, SessionStatus, Team,
} from "./types.js";
import { createPermissionViews } from "./permission-views.js";
import { createLiveState } from "./live-state.js";

export interface TeamViewDeps {
  state(): AppState;
  icons: Record<string, string>;
  now(): number;
  fmt(value: number): string;
  appRoot(inner: string): string;
  topbar(title: string, subtitle: string, actions?: string): string;
  currentUser(): { role?: string } | undefined;
  isSystemAdmin(): boolean;
  canManageTeam(teamId: string): boolean;
  canWriteTeam(teamId: string): boolean;
  canManageSession(session?: Session): boolean;
  canAskSession(session?: Session): boolean;
  canApprove(permission: Permission): boolean;
  sessionVisibility(session?: Session): string;
  teamRole(teamId: string): string | undefined;
  agentById(id?: string): Agent | undefined;
  userName(id?: string | null): string;
  escapeHtml(value: HtmlValue): string;
  badge(value: HtmlValue, tone?: string): string;
  titleText(value: HtmlValue): string;
  compactText(value: unknown, max?: number): string;
  renderMarkdown(value: HtmlValue): string;
  sessionById(id?: string): Session | undefined;
  permissionById(id?: string): Permission | undefined;
  groupSessionsByTime(sessions: Session[], referenceTime?: number): SessionGroup[];
  isSessionGroupExpanded(teamId: string, group: SessionGroup, session?: Session): boolean;
  sortSessionsNewestFirst(sessions: Session[]): Session[];
  selectedSessionIds: Set<string>;
  uiMemory: { composerDrafts: Map<string, string>; openTurnEvents: Map<string, boolean>; sessionSelectionMode: boolean };
}

export function createTeamViews(deps: TeamViewDeps) {
  const state = createLiveState(deps.state);
  const { icons, now, fmt, appRoot, topbar, currentUser, isSystemAdmin, canManageTeam, canManageSession, canAskSession,
    sessionVisibility, teamRole, agentById, userName, escapeHtml, badge, titleText, compactText, sessionById,
    permissionById, groupSessionsByTime, isSessionGroupExpanded, sortSessionsNewestFirst, selectedSessionIds,
    uiMemory, renderMarkdown, canWriteTeam, canApprove } = deps;
  const CHAT_RENDER_LIMIT = 180;
  const { renderPermission, renderToolApprovalPolicy, renderPermissionOverlay } = createPermissionViews({
    icons, fmt, badge, escapeHtml, compactText, canApprove, canManageSession,
  });

function harnessLabel(value: HtmlValue): string {
  return String(value ?? "").replace(/Claude Code/gi, "Harness").replace(/\bClaude\b/gi, "Harness");
}

function displayAgentName(agent?: Agent): string {
  return agent?.type === "claude_code" ? "Harness Agent" : harnessLabel(agent?.name || "Agent");
}

function renderTeams(): string {
  const user = currentUser();
  if (!user) return "";
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
            <h3>${escapeHtml(harnessLabel(team.name))}</h3>
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
          <h2>统一管理 Harness 工作区</h2>
          <p>查看团队、运行会话、待审批动作和 CLI 健康状态。进入团队后可以直接发送任务、观察输出和调整工作区。</p>
        </div>
        <div class="health-pill ${cli.available ? "ok" : "down"}">
          ${badge(cli.label, cli.tone)}
          <span>${escapeHtml(harnessLabel(cli.detail))}</span>
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

function metricCard(label: string, value: HtmlValue, caption: string): string {
  return `<div class="metric card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div><div class="metric-caption">${escapeHtml(caption)}</div></div>`;
}

function cliStatus(): { available: boolean; dot: string; tone: string; label: string; detail: string; message: string } {
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

function renderTeamDetail(): string {
  const team = state.teams.find((item) => item.id === state.selectedTeamId) || state.teams[0];
  if (!team) return renderTeams();
  const sessions = sortSessionsNewestFirst(state.sessions.filter((session) => session.teamId === team.id));
  const session = state.sessions.find((item) => item.id === state.selectedSessionId && item.teamId === team.id) || sessions[0];
  if (session && state.selectedSessionId !== session.id) state.selectedSessionId = session.id;
  const role = teamRole(team.id) || (currentUser()?.role === "admin" ? "system admin" : "viewer");
  const actions = `
    <button class="button workspace-panel-toggle session-panel-trigger" data-action="toggle-team-rail" aria-expanded="${state.teamRailOpen}">会话</button>
    <button class="button workspace-panel-toggle runtime-panel-trigger" data-action="toggle-right-rail" aria-expanded="${state.rightRailOpen}">运行</button>
    <button class="button" data-back-teams>团队列表</button>
    <button class="button" data-modal="members" data-team="${team.id}">成员</button>
    <button class="button" data-modal="workspace" data-team="${team.id}">工作区</button>
    ${isSystemAdmin() ? `<button class="button danger" data-delete-team="${team.id}">${icons.close}删除团队</button>` : ""}
    <button class="button primary" data-action="new-session" ${canWriteTeam(team.id) ? "" : "disabled"}>${icons.plus}新会话</button>
  `;

  return appRoot(`
    ${topbar(harnessLabel(team.name), `${team.workspacePath} · 我的角色 ${role}`, actions)}
    <section class="content team-content">
      <div class="team-layout ${state.teamRailOpen ? "team-rail-open" : ""} ${state.rightRailOpen ? "right-rail-open" : ""}">
        <button class="workspace-drawer-scrim" aria-label="关闭侧栏" data-action="close-workspace-drawers"></button>
        ${renderTeamRail(team, session)}
        ${renderChat(team, session)}
        ${renderRightRail(team, session)}
      </div>
    </section>
  `);
}

function renderTeamRail(team: Team, activeSession?: Session): string {
  const members = state.members.filter((member) => member.teamId === team.id);
  const running = state.sessions.filter((session) => session.teamId === team.id && session.status === "running").length;
  return `
    <aside class="panel team-rail" id="team-rail">
      <div class="team-summary">
        <div class="section-title"><h3>${escapeHtml(harnessLabel(team.name))}</h3>${badge(running ? `${running} running` : "idle", running ? "blue" : "")}</div>
        <p>${escapeHtml(team.workspacePath)}</p>
        <div class="meta"><span>${members.length} 名成员</span><span>${fmt(team.updatedAt)}</span></div>
      </div>
      ${renderSessionList(team, activeSession, true)}
    </aside>
  `;
}

function renderSessionList(team: Team, activeSession?: Session, embedded = false): string {
  const allSessions = sortSessionsNewestFirst(state.sessions.filter((session) => session.teamId === team.id));
  const filter = state.sessionMemberFilter || "all";
  const sessions = allSessions.filter((session) => {
    if (filter !== "all" && session.createdBy !== filter) return false;
    if (state.sessionStatusFilter !== "all" && session.status !== state.sessionStatusFilter) return false;
    const archived = Boolean(session.archived || session.archivedAt);
    if (state.sessionArchiveFilter === "active" && archived) return false;
    if (state.sessionArchiveFilter === "archived" && !archived) return false;
    return true;
  });
  const groups = groupSessionsByTime(sessions);
  const memberOptions = state.members
    .filter((member) => member.teamId === team.id)
    .map((member) => {
      const count = allSessions.filter((session) => session.createdBy === member.userId).length;
      return { userId: member.userId, label: `${userName(member.userId)} (${count})` };
    })
    .filter((option) => option.label);
  return `
    <section class="${embedded ? "session-section" : "panel"}">
      <div class="panel-header">
        <h2 class="panel-title">会话</h2>
        <div class="session-header-actions">
          ${isSystemAdmin() ? `<button class="button compact" data-action="toggle-session-selection" aria-pressed="${uiMemory.sessionSelectionMode}">${uiMemory.sessionSelectionMode ? "完成" : "批量管理"}</button>` : ""}
          ${badge(`${sessions.length}/${allSessions.length}`)}
        </div>
      </div>
      <div class="session-filter">
        <div class="session-search-field">
          <label class="visually-hidden" for="session-search">搜索会话</label>
          <input class="input compact-input" id="session-search" type="search" value="${escapeHtml(state.sessionSearch)}" placeholder="搜索标题或消息" autocomplete="off" data-session-search />
        </div>
        <div class="session-filter-row">
          <div><label for="session-member-filter">成员</label><select class="select compact-select" id="session-member-filter" data-session-member-filter>
            <option value="all" ${filter === "all" ? "selected" : ""}>全部成员</option>
            ${memberOptions.map((option) => `<option value="${escapeHtml(option.userId)}" ${filter === option.userId ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
          </select></div>
          <div><label for="session-status-filter">状态</label><select class="select compact-select" id="session-status-filter" data-session-status-filter>
            <option value="all">全部状态</option>
            ${(["running", "compacting", "waiting_permission", "queued", "completed", "failed", "stopped", "interrupted", "idle"] as SessionStatus[]).map((status) => `<option value="${status}" ${state.sessionStatusFilter === status ? "selected" : ""}>${status}</option>`).join("")}
          </select></div>
          <div><label for="session-archive-filter">范围</label><select class="select compact-select" id="session-archive-filter" data-session-archive-filter>
            <option value="active" ${state.sessionArchiveFilter === "active" ? "selected" : ""}>进行中</option>
            <option value="archived" ${state.sessionArchiveFilter === "archived" ? "selected" : ""}>已归档</option>
            <option value="all" ${state.sessionArchiveFilter === "all" ? "selected" : ""}>全部</option>
          </select></div>
        </div>
      </div>
      <div class="session-list">
        ${isSystemAdmin() && uiMemory.sessionSelectionMode ? `<div class="batch-actions" role="group" aria-label="批量会话操作"><span>已选择 ${selectedSessionIds.size} 个会话</span><button class="button compact" data-action="batch-unarchive" ${selectedSessionIds.size ? "" : "disabled"}>恢复选中</button><button class="button compact" data-action="batch-archive" ${selectedSessionIds.size ? "" : "disabled"}>归档选中</button></div>` : ""}
        ${groups.map((group) => renderSessionGroup(team, group, activeSession)).join("") || '<div class="empty">没有匹配的会话</div>'}
        ${state.sessionPagination.loading ? '<div class="session-list-loading" role="status">正在加载会话...</div>' : ""}
        ${state.sessionPagination.nextCursor ? '<button class="button load-more" data-action="load-more-sessions">加载更多</button>' : ""}
      </div>
    </section>
  `;
}

function renderSessionGroup(team: Team, group: SessionGroup, activeSession?: Session): string {
  const expanded = isSessionGroupExpanded(team.id, group, activeSession);
  const contentId = `session-group-${team.id}-${group.id}`;
  return `
    <section class="session-group" data-session-group-section="${group.id}">
      <button
        class="session-group-toggle"
        data-session-group="${group.id}"
        data-team="${team.id}"
        data-expanded="${expanded}"
        aria-expanded="${expanded}"
        aria-controls="${contentId}"
      >
        <span>${escapeHtml(group.label)}</span>
        <span class="session-group-count">${group.sessions.length}</span>
        <span class="session-group-chevron" aria-hidden="true">${icons.chevron}</span>
      </button>
      ${expanded ? `<div class="session-group-content" id="${contentId}">${group.sessions.map((session) => renderSessionRow(session, activeSession)).join("")}</div>` : ""}
    </section>
  `;
}

function renderSessionRow(session: Session, activeSession?: Session): string {
  const archived = Boolean(session.archived || session.archivedAt);
  const batchUnavailable = ["queued", "running", "compacting", "waiting_permission"].includes(session.status);
  const selectable = isSystemAdmin() && uiMemory.sessionSelectionMode;
  const visibility = sessionVisibility(session);
  const statusLabel = sessionStatusLabel(session.status);
  const visibilityLabel = visibility === "team" ? "团队可见" : "私有";
  return `
    <div class="session-row ${selectable ? "has-selection" : ""}">
      ${selectable ? `<label class="session-select" title="${batchUnavailable ? "运行中的会话不能批量归档或恢复" : ""}"><input type="checkbox" data-session-select="${session.id}" ${selectedSessionIds.has(session.id) ? "checked" : ""} ${batchUnavailable ? "disabled" : ""} aria-label="选择会话 ${escapeHtml(titleText(session.title))}" /></label>` : ""}
      <button class="session-item ${session.id === activeSession?.id ? "active" : ""}" data-session="${session.id}" aria-label="${escapeHtml(titleText(session.title))}，${statusLabel}，${visibilityLabel}${archived ? "，已归档" : ""}">
        <strong class="truncate-title" title="${escapeHtml(titleText(session.title))}">${escapeHtml(titleText(session.title))}</strong>
        <span class="session-signals" aria-hidden="true">
          <span class="session-status-dot ${session.status}" title="${statusLabel}"></span>
          ${archived ? `<span class="session-signal archived" title="已归档">${icons.archive}</span>` : ""}
          <span class="session-signal visibility ${visibility}" title="${visibilityLabel}">${visibility === "team" ? icons.users : icons.lock}</span>
        </span>
      </button>
      ${canManageSession(session) ? `<button class="icon-button session-delete" title="删除会话" aria-label="删除会话 ${escapeHtml(titleText(session.title))}" data-delete-session="${session.id}">${icons.close}</button>` : ""}
    </div>
  `;
}

function renderChat(team: Team, session?: Session): string {
  if (!session) {
    return `<section class="panel chat-panel" id="chat-panel"><div class="empty">创建一个 Harness 会话开始协作</div></section>`;
  }
  const allMessages = state.messages.filter((message) => message.sessionId === session.id);
  const messages = allMessages.slice(-CHAT_RENDER_LIMIT);
  const turns = buildMessageTurns(messages);
  const archived = Boolean(session.archived || session.archivedAt);
  const isRunning = session.status === "running" || session.status === "compacting";
  const canSend = canAskSession(session) && !archived && !["queued", "waiting_permission"].includes(session.status);
  const canStop = canManageSession(session) && ["queued", "running", "compacting", "waiting_permission"].includes(session.status);
  const placeholder = composerPlaceholder(team, session);
  const visibility = sessionVisibility(session);
  const draft = uiMemory.composerDrafts.get(session.id) || "";
  const messagePage = state.messagePagination[session.id] || { nextCursor: null, loading: false, initialized: false };
  return `
    <section class="panel chat-panel" id="chat-panel">
      <div class="panel-header chat-header">
        <div class="title-stack chat-title-stack">
          <h2 class="panel-title truncate-title" title="${escapeHtml(titleText(session.title))}">${escapeHtml(titleText(session.title))}</h2>
          <div class="meta"><span>创建人 ${escapeHtml(userName(session.createdBy))}</span>${badge(visibility === "team" ? "团队可见" : "私有", visibility === "team" ? "green" : "")}</div>
        </div>
        <div class="toolbar chat-actions">
          <button class="button" data-action="toggle-session-visibility" ${canManageSession(session) ? "" : "disabled"}>${visibility === "team" ? "设为私有" : "共享给团队"}</button>
          <button class="button" data-action="toggle-session-archive" ${canManageSession(session) ? "" : "disabled"}>${archived ? "取消归档" : "归档"}</button>
          ${badge(session.status, statusTone(session.status))}
          <button class="icon-button stop-session" title="停止会话" aria-label="停止会话" data-action="stop-session" ${canStop ? "" : "disabled"}>${icons.stop}</button>
          <button class="button" data-export-session="${session.id}" data-export-format="markdown">导出会话</button>
        </div>
      </div>
      <div class="chat-stream" id="chat-stream">
        ${messagePage.nextCursor ? `<button class="history-notice history-load" data-action="load-older-messages" ${messagePage.loading ? "disabled" : ""}>${messagePage.loading ? "正在加载..." : "加载更早消息"}</button>` : ""}
        ${allMessages.length > messages.length ? `<div class="history-notice">当前仅渲染最近 ${CHAT_RENDER_LIMIT} 条消息，继续向上加载可查看历史。</div>` : ""}
        ${turns.map(renderTurn).join("")}
      </div>
      <form class="composer" data-form="message">
        <textarea class="textarea" name="content" placeholder="${escapeHtml(placeholder)}" data-session-draft="${session.id}" maxlength="200000" required ${canSend ? "" : "disabled"}>${escapeHtml(draft)}</textarea>
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

function buildMessageTurns(messages: Message[]): MessageTurn[] {
  const turns: MessageTurn[] = [];
  const byId = new Map<string, MessageTurn>();
  const loose: Message[] = [];
  for (const message of messages) {
    const turnId = message.metadata?.turnId;
    if (message.senderType === "user" && message.metadata?.guidance && turnId && byId.has(turnId)) {
      byId.get(turnId)?.messages.push(message);
      continue;
    }
    if (message.senderType === "user") {
      const turn = { id: turnId || message.id, user: message, messages: [] };
      turns.push(turn);
      if (turnId) byId.set(turnId, turn);
      continue;
    }
    if (turnId && byId.has(turnId)) {
      byId.get(turnId)?.messages.push(message);
    } else {
      loose.push(message);
    }
  }
  return [...loose.map((message) => ({ id: message.id, messages: [message] })), ...turns];
}

function renderTurn(turn: MessageTurn): string {
  const agentMessages = turn.messages.filter((message) => message.senderType === "agent");
  const planMessages = turn.messages.filter((message) => message.metadata?.type === "plan");
  const guidanceMessages = turn.messages.filter((message) => message.senderType === "user" && message.metadata?.guidance);
  const eventMessages = turn.messages.filter((message) => message.senderType !== "agent" && message.senderType !== "user" && message.metadata?.type !== "plan");
  const hasAgentOutput = agentMessages.some((message) => String(message.content || "").trim());
  const hasNoisyEvents = eventMessages.length > 2 || eventMessages.some((message) => ["command", "input", "tool_call", "permission_request"].includes(message.metadata?.type || ""));
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

function renderPlanMessage(message: Message): string {
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

function renderTurnEvents(messages: Message[], collapsed: boolean): string {
  const content = messages.map(renderTimelineEvent).join("");
  if (!collapsed) return `<div class="turn-events">${content}</div>`;
  const key = turnEventKey(messages);
  const isOpen = uiMemory.openTurnEvents.get(key);
  return `<details class="turn-events collapsed" data-turn-events="${escapeHtml(key)}" ${isOpen ? "open" : ""}><summary>${icons.terminal}<span>本轮运行记录</span><strong>${messages.length}</strong></summary>${content}</details>`;
}

function turnEventKey(messages: Message[]): string {
  const first = messages[0];
  const turnId = first?.metadata?.turnId || first?.id || "loose";
  return `${first?.sessionId || "session"}:${turnId}`;
}

function composerPlaceholder(team: Team, session: Session): string {
  if (!canWriteTeam(team.id)) return "viewer 角色只能查看会话";
  if (!canAskSession(session)) return "共享会话只读，只有会话创建者可以继续提问";
  if (session.status === "idle") return "向 Harness 发送任务";
  if (session.status === "running") return "Harness 正在执行，可以追加引导，不会开启新会话";
  if (session.status === "waiting_permission") return "当前任务等待审批";
  return "继续发送下一轮消息，会自动恢复 Harness 会话上下文";
}

function renderMessage(message: Message): string {
  if (message.metadata?.type === "plan") return renderPlanMessage(message);
  if (message.senderType === "tool" || message.senderType === "system") return renderTimelineEvent(message);
  if (message.senderType === "agent" && !String(message.content || "").trim()) {
    return "";
  }
  const sender =
    message.senderType === "user"
      ? userName(message.senderId)
      : message.senderType === "agent"
        ? displayAgentName(agentById(message.senderId || undefined))
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
          ${message.senderType === "user" && !guidance && canAskSession(sessionById(message.sessionId)) && !Boolean(sessionById(message.sessionId)?.archived || sessionById(message.sessionId)?.archivedAt) ? `<button class="text-button" data-action="retry-session" data-retry-message="${message.id}">重试</button>` : ""}
        </span>
      </div>
      <div class="bubble ${rich ? "markdown" : ""}">${content}</div>
    </article>
  `;
}

function renderTimelineEvent(message: Message): string {
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

function timelineEventMeta(message: Message): { title: string; detail: HtmlValue; icon: string; tone: string; spinner?: boolean } {
  const type = message.metadata?.type || (message.senderType === "system" ? "system" : "tool");
  if (type === "command") return { title: message.metadata?.claudeSessionId ? "已恢复 Harness 会话" : "已启动 Harness 会话", detail: harnessLabel(message.content), icon: icons.terminal, tone: "tool" };
  if (type === "input") return { title: "已发送到 Harness", detail: message.content, icon: icons.terminal, tone: "tool" };
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

function renderRightRail(team: Team, session?: Session): string {
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
          <h4>Harness Runtime</h4>
          <p>${escapeHtml(harnessLabel(cli.message))}</p>
        </div>
        <div class="side-card">
          <h4>Agent 状态</h4>
          ${agents.map((agent) => {
            const status = effectiveAgentStatus(agent, session);
            return `<div class="agent-row"><div><strong>${escapeHtml(displayAgentName(agent))}</strong><p>Harness Runtime · ${escapeHtml(status.label)}</p></div><span title="${escapeHtml(status.label)}" class="status-dot ${status.className}"></span></div>`;
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

function effectiveAgentStatus(agent: Agent, session?: Session): { label: string; className: string } {
  if (session?.agentId === agent.id) {
    if (session.status === "running") return { label: "运行中", className: "running" };
    if (session.status === "compacting") return { label: "压缩上下文", className: "running" };
    if (session.status === "waiting_permission") return { label: "等待审批", className: "waiting" };
    if (session.status === "failed" || session.status === "stopped") return { label: "异常/已停止", className: "error" };
    if (session.status === "completed" || session.status === "idle") return state.claudeConfig.available ? { label: "空闲可用", className: "ready" } : { label: "未就绪", className: "" };
  }
  if (agent.status === "running") return { label: "运行中", className: "running" };
  if (agent.status === "waiting") return { label: "等待审批", className: "waiting" };
  if (state.claudeConfig.available) return { label: "空闲可用", className: "ready" };
  return { label: "未就绪", className: "" };
}

function statusTone(status: SessionStatus): string {
  return status === "running" || status === "compacting" ? "green" : status === "waiting_permission" ? "amber" : status === "failed" || status === "stopped" ? "red" : "blue";
}

function sessionStatusLabel(status: SessionStatus): string {
  const labels: Record<SessionStatus, string> = {
    idle: "空闲",
    queued: "排队中",
    running: "运行中",
    compacting: "压缩上下文",
    waiting_permission: "等待审批",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止",
    interrupted: "已中断",
  };
  return labels[status];
}

function renderModal(kind: string, teamId = state.selectedTeamId): string {
  if (!kind) return "";
  if (kind === "password") {
    return `
      <dialog class="modal" data-modal-dialog aria-labelledby="password-dialog-title">
        <form class="modal-form" data-form="password">
          <div class="modal-head"><h3 id="password-dialog-title">修改密码</h3></div>
          <div class="modal-body grid">
            <div class="field"><label for="password-current">当前密码</label><input class="input" id="password-current" name="currentPassword" type="password" autocomplete="current-password" required /></div>
            <div class="field"><label for="password-new">新密码</label><input class="input" id="password-new" name="newPassword" type="password" autocomplete="new-password" required /></div>
            <div class="field"><label for="password-confirm">确认新密码</label><input class="input" id="password-confirm" name="confirmPassword" type="password" autocomplete="new-password" required /></div>
            <div class="helper">修改后，除当前浏览器外的其他登录态会失效。</div>
          </div>
          <div class="modal-actions"><button class="button" type="button" data-close-modal>取消</button><button class="button primary" type="submit">保存</button></div>
        </form>
      </dialog>
    `;
  }
  if (kind === "team") {
    if (!isSystemAdmin()) return "";
    return `
      <dialog class="modal" data-modal-dialog aria-labelledby="team-dialog-title">
        <form class="modal-form" data-form="team">
          <div class="modal-head"><h3 id="team-dialog-title">创建团队</h3></div>
          <div class="modal-body">
            <div class="field"><label for="team-name">团队名称</label><input class="input" id="team-name" name="name" required /></div>
            <div class="field"><label for="team-workspace">工作区目录</label><input class="input" id="team-workspace" name="workspacePath" value="${escapeHtml(state.claudeConfig.workspaceRoot)}/" required /></div>
          </div>
          <div class="modal-actions"><button class="button" type="button" data-close-modal>取消</button><button class="button primary" type="submit">创建</button></div>
        </form>
      </dialog>
    `;
  }
  if (kind === "user") {
    if (!isSystemAdmin()) return "";
    return `
      <dialog class="modal" data-modal-dialog aria-labelledby="user-dialog-title">
        <form class="modal-form" data-form="user">
          <div class="modal-head"><div><h3 id="user-dialog-title">创建用户</h3><p class="helper">填写账号信息并分配初始系统角色。</p></div></div>
          <div class="modal-body grid">
            <div class="grid two"><div class="field"><label for="new-user-name">用户名</label><input class="input" id="new-user-name" name="username" autocomplete="off" required /></div><div class="field"><label for="new-user-display">显示名</label><input class="input" id="new-user-display" name="displayName" required /></div></div>
            <div class="field"><label for="new-user-email">邮箱（可选）</label><input class="input" id="new-user-email" name="email" type="email" autocomplete="off" /></div>
            <div class="grid two"><div class="field"><label for="new-user-password">初始密码</label><input class="input" id="new-user-password" name="password" type="password" minlength="12" autocomplete="new-password" required /></div><div class="field"><label for="new-user-role">系统角色</label><select class="select" id="new-user-role" name="role"><option value="member">Member</option><option value="admin">Admin</option></select></div></div>
          </div>
          <div class="modal-actions"><button class="button" type="button" data-close-modal>取消</button><button class="button primary" type="submit">创建用户</button></div>
        </form>
      </dialog>
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
            ${canManageTeam(teamId) ? `<button class="icon-button" type="button" title="移除成员" data-remove-member-team="${teamId}" data-remove-member-user="${member.userId}">${icons.close}</button>` : ""}
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
    <dialog class="modal members-modal" data-modal-dialog aria-labelledby="members-dialog-title">
        <div class="modal-head"><h3 id="members-dialog-title">${escapeHtml(team?.name || "")} 成员</h3></div>
        <div class="modal-body members-modal-body">
          <div class="member-list">
            ${memberRows || '<div class="empty">还没有成员</div>'}
          </div>
          <form class="form-row" data-form="member" data-team="${teamId}">
            <div class="field"><label for="member-user">用户</label><select class="select" id="member-user" name="userId">${options}</select></div>
            <div class="field"><label for="member-role">角色</label><select class="select" id="member-role" name="role"><option value="member">member</option><option value="admin">admin</option><option value="viewer">viewer</option></select></div>
            <button class="button primary" type="submit" ${canManageTeam(teamId) && options ? "" : "disabled"}>${icons.plus}添加</button>
          </form>
        </div>
        <div class="modal-actions"><button class="button" data-close-modal>关闭</button></div>
    </dialog>
  `;
}

function renderWorkspaceModal(teamId: string): string {
  const team = state.teams.find((item) => item.id === teamId);
  return `
    <dialog class="modal" data-modal-dialog aria-labelledby="workspace-dialog-title">
      <form class="modal-form" data-form="workspace" data-team="${teamId}">
        <div class="modal-head"><h3 id="workspace-dialog-title">团队工作区</h3></div>
        <div class="modal-body">
          <div class="field"><label for="workspace-path">工作区目录</label><input class="input" id="workspace-path" name="workspacePath" value="${escapeHtml(team?.workspacePath || state.claudeConfig.workspaceRoot || "")}" required /></div>
          <div class="helper">目录必须位于系统 allowlist 内：${escapeHtml(state.claudeConfig.workspaceRoot || "")}</div>
        </div>
        <div class="modal-actions"><button class="button" type="button" data-close-modal>取消</button><button class="button primary" type="submit" ${canManageTeam(teamId) ? "" : "disabled"}>保存</button></div>
      </form>
    </dialog>
  `;
}
  return {
    metricCard, renderTeams, renderTeamDetail, renderTeamRail, renderChat, renderRightRail,
    renderMessage, renderPermissionOverlay, renderModal,
  };
}

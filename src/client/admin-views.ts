import type { AdminMetrics, AppState, AuditFilters, AuditLog, HtmlValue, TeamTemplate, ToolInventory } from "./types.js";

export interface AdminViewDeps {
  state(): AppState;
  metrics(): AdminMetrics | null;
  templates(): TeamTemplate[];
  editingTemplate(): TeamTemplate | null;
  isAdmin(): boolean;
  loading(): boolean;
  auditFilters(): AuditFilters;
  auditCursor(): string | null;
  auditLoading(): boolean;
  escape(value: HtmlValue): string;
  fmt(value: number): string;
  badge(value: HtmlValue, tone?: string): string;
  metric(label: string, value: HtmlValue, caption: string): string;
  userName(id?: string | null): string;
  appRoot(inner: string): string;
  topbar(title: string, subtitle: string, actions?: string): string;
  icons: { check: string; plus: string };
  auditQuery(format?: "json" | "csv"): string;
  renderDataSync(): string;
  fallback(): string;
}

function bytes(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "未提供";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function numeric(value: number | null | undefined, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value}${suffix}` : "未提供";
}

function toolInventory(inventory: ToolInventory, deps: AdminViewDeps): string {
  if (!inventory.tools?.length && !inventory.servers?.length) return "<p>WebUI 尚未缓存 MCP 工具清单，实际可用工具以 Harness 运行时为准。</p>";
  return `<div class="inventory-list">${(inventory.servers || []).map((server) => `<div>${deps.badge("server", "blue")}<code>${deps.escape(server)}</code></div>`).join("")}${(inventory.tools || []).map((tool) => `<div>${deps.badge("tool", "green")}<code>${deps.escape(tool)}</code></div>`).join("")}</div>`;
}

function observability(deps: AdminViewDeps): string {
  const metrics = deps.metrics();
  if (!metrics) return `<div class="card card-padding-lg admin-observability"><div class="section-title"><h3>运行概览</h3>${deps.loading() ? deps.badge("正在读取", "blue") : deps.badge("未提供", "amber")}</div><p class="helper">指标来自服务端实时快照，服务未返回数据时不会用估算值替代。</p></div>`;
  const totalTokens = (metrics.runtime?.inputTokens ?? 0) + (metrics.runtime?.outputTokens ?? 0);
  const backupCaption = metrics.backup?.lastCompletedAt ? `最近 ${deps.fmt(metrics.backup.lastCompletedAt)}` : metrics.backup?.enabled ? "等待首次备份" : "自动备份未启用";
  return `<section class="card card-padding-lg admin-observability" aria-label="运行概览"><div class="section-title"><h3>运行概览</h3>${metrics.sampledAt ? `<span class="meta">更新于 ${deps.fmt(metrics.sampledAt)}</span>` : deps.badge("实时快照", "blue")}</div><div class="metric-row admin-metrics">${deps.metric("排队", numeric(metrics.runtime?.queued ?? metrics.sessions?.queued), "等待执行的任务")}${deps.metric("运行", numeric(metrics.runtime?.running ?? metrics.sessions?.running), "正在执行的任务")}${deps.metric("失败", numeric(metrics.sessions?.failed), "已记录失败会话")}${deps.metric("平均耗时", numeric(metrics.runtime?.averageTurnDurationMs, " ms"), "SDK 已完成任务")}${deps.metric("Tokens", numeric(totalTokens), `输入 ${numeric(metrics.runtime?.inputTokens)} / 输出 ${numeric(metrics.runtime?.outputTokens)}`)}${deps.metric("成本", numeric(metrics.runtime?.totalCostUsd, " USD"), "进程启动后 SDK 统计")}${deps.metric("SSE", numeric(metrics.sse?.clients), `连接 ${metrics.sse?.connected === false ? "不可用" : "客户端"}`)}${deps.metric("事件缓存", numeric(metrics.sse?.eventsBuffered), "可回放事件")}${deps.metric("数据库", bytes(metrics.database?.sizeBytes), `WAL ${bytes(metrics.database?.walBytes)}`)}${deps.metric("备份", bytes(metrics.backup?.lastBackupBytes ?? undefined), backupCaption)}</div></section>`;
}

function templates(deps: AdminViewDeps): string {
  const state = deps.state();
  const options = state.teams.map((team) => `<option value="${deps.escape(team.id)}">${deps.escape(String(team.name).replace(/Claude Code/gi, "Harness").replace(/\bClaude\b/gi, "Harness"))}</option>`).join("");
  const list = deps.templates();
  const draft = deps.editingTemplate();
  const editor = `<details class="template-editor" ${draft ? "open" : ""}><summary>${draft ? "编辑团队模板" : "新建团队模板"}</summary><form class="template-form" data-form="team-template"><input type="hidden" name="id" value="${deps.escape(draft?.id || "")}" /><div class="field"><label for="template-name">名称</label><input class="input" id="template-name" name="name" maxlength="80" value="${deps.escape(draft?.name || "")}" required /></div><div class="field"><label for="template-description">说明</label><input class="input" id="template-description" name="description" maxlength="500" value="${deps.escape(draft?.description || "")}" /></div><div class="field"><label for="template-workspace-mode">工作区模式</label><select class="select" id="template-workspace-mode" name="workspaceMode"><option value="shared" ${draft?.workspaceMode !== "isolated" ? "selected" : ""}>共享</option><option value="isolated" ${draft?.workspaceMode === "isolated" ? "selected" : ""}>隔离</option></select></div><div class="grid two"><div class="field"><label for="template-context">上下文 tokens</label><input class="input" id="template-context" name="modelContextTokens" type="number" min="1000" max="10000000" step="1000" value="${deps.escape(draft?.modelContextTokens || 1000000)}" required /></div><div class="field"><label for="template-compact">自动压缩阈值</label><input class="input" id="template-compact" name="autoCompactRatio" type="number" min="0.1" max="0.9" step="0.01" value="${deps.escape(draft?.autoCompactRatio || 0.62)}" required /></div></div><label class="toggle-row"><input type="checkbox" name="autoCompactEnabled" ${draft?.autoCompactEnabled === false ? "" : "checked"} />启用自动压缩</label><div class="field"><label for="template-mcp">MCP 工具 allowlist</label><textarea class="textarea" id="template-mcp" name="mcpToolAllowlist" placeholder="每行一个工具名">${deps.escape((draft?.mcpToolAllowlist || []).join("\n"))}</textarea></div><div class="template-actions"><button class="button primary" type="submit">保存模板</button>${draft ? '<button class="button" type="button" data-cancel-template-edit>取消编辑</button>' : ""}</div></form></details>`;
  return `<div class="side-card template-manager"><h4>团队模板</h4>${editor}${list.length ? `<div class="template-list">${list.map((template) => `<div class="template-row"><div class="template-row-heading"><strong>${deps.escape(template.name)}</strong><div class="template-row-actions"><button class="button" type="button" data-edit-template="${deps.escape(template.id)}">编辑</button><button class="icon-button" type="button" title="删除模板" aria-label="删除模板 ${deps.escape(template.name)}" data-delete-template="${deps.escape(template.id)}">×</button></div></div><p>${deps.escape(template.description || "未提供说明")}</p><div class="template-apply"><label class="visually-hidden" for="template-team-${deps.escape(template.id)}">选择应用团队</label><select class="select compact-select" id="template-team-${deps.escape(template.id)}" data-template-team="${deps.escape(template.id)}">${options}</select><button class="button" data-template-apply="${deps.escape(template.id)}">应用</button></div></div>`).join("")}</div>` : `<p>${deps.loading() ? "正在读取模板…" : "暂时没有可用模板。"}</p>`}</div>`;
}

export function createAdminViews(deps: AdminViewDeps) {
  type SystemView = "settings" | "sync" | "users" | "audit" | "permissions";
  const sections: Array<[SystemView, string, string]> = [
    ["settings", "Agent 设置", "Harness 运行策略"],
    ["sync", "数据同步", "MaxCompute 数据源与调度"],
    ["users", "用户管理", "账号、角色与状态"],
    ["permissions", "权限设置", "角色可见目录"],
    ["audit", "审计日志", "系统操作追溯"],
  ];

  function systemPage(view: SystemView, title: string, subtitle: string, body: string, actions = ""): string {
    if (!deps.isAdmin()) return deps.fallback();
    const navigation = sections.map(([key, label, description]) => `<button type="button" class="system-subnav-item ${view === key ? "active" : ""}" data-view="${key}"><span>${deps.escape(label)}</span><small>${deps.escape(description)}</small></button>`).join("");
    return deps.appRoot(`${deps.topbar(title, subtitle, actions)}<div class="system-settings-shell"><nav class="system-subnav" aria-label="系统设置目录"><div class="system-subnav-heading"><span>系统设置</span><small>Configuration</small></div>${navigation}</nav><div class="system-settings-main">${body}</div></div>`);
  }

  function settings(): string {
    const { claudeConfig: cfg, serverInfo: info, toolInventory: inventory } = deps.state();
    const compactWindow = Math.floor(Number(cfg.modelContextTokens || 1_000_000) * Number(cfg.autoCompactRatio || 0.62));
    const body = `<section class="content settings-layout"><div class="grid">${observability(deps)}<form class="card card-padding-lg" data-form="config"><div class="section-title"><div><h3>运行配置</h3><p class="helper">配置 Harness 命令、工作空间边界与上下文策略。</p></div>${deps.badge(cfg.available ? "可用" : "不可用", cfg.available ? "green" : "red")}</div><div class="grid two"><div class="field"><label for="config-command">CLI 命令</label><input class="input" id="config-command" name="command" value="${deps.escape(cfg.command)}" /></div><div class="field"><label for="config-args">启动参数</label><input class="input" id="config-args" name="args" value="${deps.escape(cfg.args)}" /></div></div><div class="field"><label for="config-workspace">Workspace allowlist 根目录</label><input class="input" id="config-workspace" name="workspaceRoot" value="${deps.escape(cfg.workspaceRoot)}" /></div><div class="grid two"><div class="field"><label for="config-context">模型上下文窗口 tokens</label><input class="input" id="config-context" name="modelContextTokens" type="number" min="1000" step="1000" value="${deps.escape(cfg.modelContextTokens)}" /></div><div class="field"><label for="config-compact">自动压缩阈值</label><input class="input" id="config-compact" name="autoCompactRatio" type="number" min="0.1" max="0.9" step="0.01" value="${deps.escape(cfg.autoCompactRatio)}" /></div></div><label class="toggle-row"><input type="checkbox" name="autoCompactEnabled" ${cfg.autoCompactEnabled === false ? "" : "checked"} />启用 SDK 原生 auto compact（约 ${compactWindow.toLocaleString()} tokens 触发）</label><div class="field"><label for="config-mcp">MCP 工具 allowlist</label><textarea class="textarea" id="config-mcp" name="mcpToolAllowlist">${deps.escape((cfg.mcpToolAllowlist || []).join("\n"))}</textarea></div><button class="button primary" type="submit">保存 Agent 设置</button></form><div class="card card-padding-lg"><h3 class="section-heading">运行信息</h3><div class="info-grid"><div><span>WebUI</span><strong>${deps.escape(info.appVersion || "unknown")}</strong></div><div><span>Node</span><strong>${deps.escape(info.nodeVersion || "unknown")}</strong></div><div><span>Agent SDK</span><strong>Harness SDK</strong></div><div><span>启动时间</span><strong>${info.startedAt ? deps.fmt(info.startedAt) : "unknown"}</strong></div><div><span>数据目录</span><strong>${deps.escape(info.dataDir || "")}</strong></div><div><span>Workspace Root</span><strong>${deps.escape(info.workspaceRoot || "")}</strong></div></div></div></div><aside class="panel"><div class="panel-header"><h2 class="panel-title">能力状态</h2>${deps.badge("server adapter", "blue")}</div><div class="side-stack"><div class="side-card"><h4>Health Check</h4><p>${deps.escape(cfg.message || "运行健康检查后显示 Harness 状态。")}</p></div><div class="side-card"><h4>MCP 工具清单</h4>${toolInventory(inventory, deps)}</div>${templates(deps)}</div></aside></section>`;
    return systemPage("settings", "Agent 设置", "配置 Harness、工作区边界和运行策略", body, `<button class="button primary" data-action="health-check">${deps.icons.check}运行健康检查</button>`);
  }

  function sync(): string {
    return systemPage("sync", "数据同步", "配置 MaxCompute 数据源、验证连接并管理每日抽数", deps.renderDataSync());
  }

  function users(): string {
    const state = deps.state();
    const rows = state.users.map((user) => `<article class="user-row"><div class="user-identity"><span class="avatar">${deps.escape(user.displayName.slice(0, 1) || "U")}</span><div><strong>${deps.escape(user.displayName)}</strong><small>${deps.escape(user.email || "未填写邮箱")}</small></div></div><div class="user-account"><span>账号</span><strong>${deps.escape(user.username)}</strong></div><label class="user-role"><span>系统角色</span><select class="select" data-user-role="${deps.escape(user.id)}" ${user.id === state.currentUserId ? "disabled" : ""}><option value="member" ${user.role === "member" ? "selected" : ""}>Member</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option></select></label><div class="user-status">${deps.badge(user.status === "active" ? "已启用" : "已停用", user.status === "active" ? "green" : "red")}</div><div class="user-row-actions"><form class="inline-password-form" data-form="admin-password" data-user-id="${deps.escape(user.id)}"><label class="visually-hidden" for="admin-password-${deps.escape(user.id)}">${deps.escape(user.displayName)} 的新密码</label><input class="input compact-input" id="admin-password-${deps.escape(user.id)}" name="newPassword" type="password" autocomplete="new-password" placeholder="输入新密码" required /><button class="button" type="submit">重置密码</button></form><button class="button" data-toggle-user="${deps.escape(user.id)}" ${user.id === state.currentUserId ? "disabled" : ""}>${user.status === "active" ? "停用" : "启用"}</button></div></article>`).join("");
    const body = `<section class="content user-management"><div class="user-list-header"><div><strong>${state.users.length} 个系统用户</strong><p class="helper">角色调整会注销该用户现有登录态，使新权限立即生效。</p></div></div><div class="user-list">${rows || '<div class="empty">暂无用户</div>'}</div></section>`;
    return systemPage("users", "用户管理", "在一处管理账号状态、系统角色与密码", body, `<button class="button primary" data-modal="user">${deps.icons.plus}创建用户</button>`);
  }

  function permissions(): string {
    const member = new Set(deps.state().roleDirectoryPermissions.member || ["teams"]);
    const body = `<section class="content permission-settings"><div class="card card-padding-lg"><div class="section-title"><div><h3>角色目录权限</h3><p class="helper">控制不同系统角色登录后可见和可访问的一级功能目录。</p></div></div><div class="role-permission-table"><div class="role-permission-head"><span>角色</span><span>团队工作台</span><span>数据血缘</span><span>系统设置</span></div><div class="role-permission-row"><div><strong>Admin</strong><small>系统管理员</small></div><label><input type="checkbox" checked disabled /><span>可见</span></label><label><input type="checkbox" checked disabled /><span>可见</span></label><label><input type="checkbox" checked disabled /><span>可见</span></label></div><form class="role-permission-row" data-form="directory-permissions"><div><strong>Member</strong><small>普通成员</small></div><label><input type="checkbox" name="teams" checked disabled /><span>可见</span></label><label><input type="checkbox" name="lineage" ${member.has("lineage") ? "checked" : ""} /><span>可见</span></label><label title="系统设置仅允许管理员访问"><input type="checkbox" disabled /><span>不可见</span></label><div class="permission-save"><button class="button primary" type="submit">保存权限</button></div></form></div><div class="security-note"><strong>后端同步校验</strong><p>这里不仅隐藏菜单。数据血缘 API 会按角色目录权限再次校验；系统设置接口始终要求 Admin 角色。</p></div></div></section>`;
    return systemPage("permissions", "权限设置", "配置角色可以看到和访问的功能目录", body);
  }

  function audit(): string {
    const state = deps.state(); const filters = deps.auditFilters();
    const rows = state.auditLogs.map((log: AuditLog) => `<div class="audit-row"><strong>${deps.escape(log.action)}</strong><div class="meta"><span>${deps.escape(deps.userName(log.userId))}</span><span>${deps.escape(log.targetType || "")}</span><span>${deps.escape(log.targetId || "")}</span><span>${deps.fmt(log.createdAt)}</span></div></div>`).join("");
    const body = `<section class="content audit-content"><form class="card audit-filter" data-form="audit-filter"><div class="field"><label for="audit-user">操作者 ID</label><input class="input" id="audit-user" name="userId" value="${deps.escape(filters.userId)}" placeholder="全部" /></div><div class="field"><label for="audit-action">动作</label><input class="input" id="audit-action" name="action" value="${deps.escape(filters.action)}" placeholder="例如 session.created" /></div><div class="field"><label for="audit-target-type">目标类型</label><input class="input" id="audit-target-type" name="targetType" value="${deps.escape(filters.targetType)}" placeholder="例如 session" /></div><div class="field"><label for="audit-target-id">目标 ID</label><input class="input" id="audit-target-id" name="targetId" value="${deps.escape(filters.targetId)}" placeholder="全部" /></div><button class="button primary" type="submit">筛选日志</button><button class="button" type="button" data-action="clear-audit-filter">清除筛选</button></form><div class="audit-list" aria-live="polite">${rows || `<div class="empty">${deps.auditLoading() ? "正在读取审计日志…" : "没有符合条件的审计记录。"}</div>`}</div>${deps.auditCursor() ? `<button class="button load-more" data-action="load-more-audit" ${deps.auditLoading() ? "disabled" : ""}>${deps.auditLoading() ? "正在加载…" : "加载更多日志"}</button>` : ""}</section>`;
    const exports = `<a class="button" href="/api/audit-logs/export?${deps.auditQuery("csv")}" download>导出 CSV</a><a class="button" href="/api/audit-logs/export?${deps.auditQuery("json")}" download>导出 JSON</a>`;
    return systemPage("audit", "审计日志", "按操作者、动作和目标追溯工作台事件", body, exports);
  }

  return { settings, sync, users, permissions, audit };
}

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
  if (!inventory.tools?.length && !inventory.servers?.length) return "<p>WebUI 尚未缓存 MCP 工具清单，实际可用工具以 Claude Code 运行时为准。</p>";
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
  const options = state.teams.map((team) => `<option value="${deps.escape(team.id)}">${deps.escape(team.name)}</option>`).join("");
  const list = deps.templates();
  const draft = deps.editingTemplate();
  const editor = `<details class="template-editor" ${draft ? "open" : ""}><summary>${draft ? "编辑团队模板" : "新建团队模板"}</summary><form class="template-form" data-form="team-template"><input type="hidden" name="id" value="${deps.escape(draft?.id || "")}" /><div class="field"><label for="template-name">名称</label><input class="input" id="template-name" name="name" maxlength="80" value="${deps.escape(draft?.name || "")}" required /></div><div class="field"><label for="template-description">说明</label><input class="input" id="template-description" name="description" maxlength="500" value="${deps.escape(draft?.description || "")}" /></div><div class="field"><label for="template-workspace-mode">工作区模式</label><select class="select" id="template-workspace-mode" name="workspaceMode"><option value="shared" ${draft?.workspaceMode !== "isolated" ? "selected" : ""}>共享</option><option value="isolated" ${draft?.workspaceMode === "isolated" ? "selected" : ""}>隔离</option></select></div><div class="grid two"><div class="field"><label for="template-context">上下文 tokens</label><input class="input" id="template-context" name="modelContextTokens" type="number" min="1000" max="10000000" step="1000" value="${deps.escape(draft?.modelContextTokens || 1000000)}" required /></div><div class="field"><label for="template-compact">自动压缩阈值</label><input class="input" id="template-compact" name="autoCompactRatio" type="number" min="0.1" max="0.9" step="0.01" value="${deps.escape(draft?.autoCompactRatio || 0.62)}" required /></div></div><label class="toggle-row"><input type="checkbox" name="autoCompactEnabled" ${draft?.autoCompactEnabled === false ? "" : "checked"} />启用自动压缩</label><div class="field"><label for="template-mcp">MCP 工具 allowlist</label><textarea class="textarea" id="template-mcp" name="mcpToolAllowlist" placeholder="每行一个工具名">${deps.escape((draft?.mcpToolAllowlist || []).join("\n"))}</textarea></div><div class="template-actions"><button class="button primary" type="submit">保存模板</button>${draft ? '<button class="button" type="button" data-cancel-template-edit>取消编辑</button>' : ""}</div></form></details>`;
  return `<div class="side-card template-manager"><h4>团队模板</h4>${editor}${list.length ? `<div class="template-list">${list.map((template) => `<div class="template-row"><div class="template-row-heading"><strong>${deps.escape(template.name)}</strong><div class="template-row-actions"><button class="button" type="button" data-edit-template="${deps.escape(template.id)}">编辑</button><button class="icon-button" type="button" title="删除模板" aria-label="删除模板 ${deps.escape(template.name)}" data-delete-template="${deps.escape(template.id)}">×</button></div></div><p>${deps.escape(template.description || "未提供说明")}</p><div class="template-apply"><label class="visually-hidden" for="template-team-${deps.escape(template.id)}">选择应用团队</label><select class="select compact-select" id="template-team-${deps.escape(template.id)}" data-template-team="${deps.escape(template.id)}">${options}</select><button class="button" data-template-apply="${deps.escape(template.id)}">应用</button></div></div>`).join("")}</div>` : `<p>${deps.loading() ? "正在读取模板…" : "暂时没有可用模板。"}</p>`}</div>`;
}

export function createAdminViews(deps: AdminViewDeps) {
  function settings(): string {
    if (!deps.isAdmin()) return deps.fallback();
    const { claudeConfig: cfg, serverInfo: info, toolInventory: inventory } = deps.state();
    const compactWindow = Math.floor(Number(cfg.modelContextTokens || 1_000_000) * Number(cfg.autoCompactRatio || 0.62));
    const actions = `<button class="button primary" data-action="health-check">${deps.icons.check}运行健康检查</button>`;
    return deps.appRoot(`${deps.topbar("Agent 设置", "配置 Claude Code CLI、工作区 allowlist 和运行策略", actions)}<section class="content settings-layout"><div class="grid">${observability(deps)}<div class="card card-padding-lg"><div class="health-grid"><div class="metric"><div class="metric-label">可用性</div><div class="metric-value">${cfg.available ? "Available" : "Down"}</div></div><div class="metric"><div class="metric-label">版本</div><div class="metric-value">${deps.escape(cfg.version)}</div></div><div class="metric"><div class="metric-label">登录态</div><div class="metric-value">${cfg.authenticated ? "OK" : "Missing"}</div></div><div class="metric"><div class="metric-label">延迟</div><div class="metric-value">${cfg.latencyMs ?? "-"}ms</div></div></div></div><form class="card card-padding-lg" data-form="config"><div class="grid two"><div class="field"><label for="config-command">CLI 命令</label><input class="input" id="config-command" name="command" value="${deps.escape(cfg.command)}" /></div><div class="field"><label for="config-args">启动参数</label><input class="input" id="config-args" name="args" value="${deps.escape(cfg.args)}" /></div></div><div class="field"><label for="config-workspace">Workspace allowlist 根目录</label><input class="input" id="config-workspace" name="workspaceRoot" value="${deps.escape(cfg.workspaceRoot)}" /></div><div class="grid two"><div class="field"><label for="config-context">模型上下文窗口 tokens</label><input class="input" id="config-context" name="modelContextTokens" type="number" min="1000" step="1000" value="${deps.escape(cfg.modelContextTokens)}" /></div><div class="field"><label for="config-compact">自动压缩阈值</label><input class="input" id="config-compact" name="autoCompactRatio" type="number" min="0.1" max="0.9" step="0.01" value="${deps.escape(cfg.autoCompactRatio)}" /></div></div><label class="toggle-row"><input type="checkbox" name="autoCompactEnabled" ${cfg.autoCompactEnabled === false ? "" : "checked"} />启用 Claude Code SDK 原生 auto compact，当前约 ${compactWindow.toLocaleString()} tokens 触发</label><div class="field"><label for="config-mcp">MCP 工具 allowlist</label><textarea class="textarea" id="config-mcp" name="mcpToolAllowlist">${deps.escape((cfg.mcpToolAllowlist || []).join("\n"))}</textarea><div class="helper">仅用于 WebUI 预授权和审批识别，不会替代宿主机 Claude Code 的 MCP 配置。</div></div><button class="button primary" type="submit">保存配置</button></form><div class="card card-padding-lg"><h3 class="section-heading">运行信息</h3><div class="info-grid"><div><span>WebUI</span><strong>${deps.escape(info.appVersion || "unknown")}</strong></div><div><span>Node</span><strong>${deps.escape(info.nodeVersion || "unknown")}</strong></div><div><span>Agent SDK</span><strong>${deps.escape(info.sdkPackage || "unknown")}</strong></div><div><span>启动时间</span><strong>${info.startedAt ? deps.fmt(info.startedAt) : "unknown"}</strong></div><div><span>数据目录</span><strong>${deps.escape(info.dataDir || "")}</strong></div><div><span>Workspace Root</span><strong>${deps.escape(info.workspaceRoot || "")}</strong></div></div></div></div><aside class="panel"><div class="panel-header"><h2 class="panel-title">能力状态</h2>${deps.badge("server adapter", "blue")}</div><div class="side-stack"><div class="side-card"><h4>Health Check</h4><p>${deps.escape(cfg.message || "运行健康检查后会显示 Claude Code CLI 状态。")}</p></div><div class="side-card"><h4>MCP 工具清单</h4>${toolInventory(inventory, deps)}</div>${templates(deps)}</div></aside></section>`);
  }

  function users(): string {
    const state = deps.state();
    const rows = state.users.map((user) => `<tr><td><strong>${deps.escape(user.displayName)}</strong><div class="meta">${deps.escape(user.email)}</div></td><td>${deps.escape(user.username)}</td><td>${deps.badge(user.role, user.role === "admin" ? "blue" : "")}</td><td>${deps.badge(user.status, user.status === "active" ? "green" : "red")}</td><td><div class="user-actions"><form class="inline-password-form" data-form="admin-password" data-user-id="${user.id}"><label class="visually-hidden" for="admin-password-${deps.escape(user.id)}">${deps.escape(user.displayName)} 的新密码</label><input class="input compact-input" id="admin-password-${deps.escape(user.id)}" name="newPassword" type="password" autocomplete="new-password" placeholder="新密码" required /><button class="button" type="submit">改密码</button></form><button class="button" data-toggle-user="${user.id}" ${user.id === state.currentUserId ? "disabled" : ""}>${user.status === "active" ? "禁用" : "启用"}</button></div></td></tr>`).join("");
    return deps.appRoot(`${deps.topbar("用户管理", "系统管理员创建用户、禁用账号和重置成员访问")}<section class="content grid"><form class="card form-row card-padding-md" data-form="user"><div class="field"><label for="new-user-name">用户名</label><input class="input" id="new-user-name" name="username" required /></div><div class="field"><label for="new-user-display">显示名</label><input class="input" id="new-user-display" name="displayName" required /></div><div class="field"><label for="new-user-password">初始密码</label><input class="input" id="new-user-password" name="password" type="password" autocomplete="new-password" required /></div><div class="field"><label for="new-user-role">角色</label><select class="select" id="new-user-role" name="role"><option value="member">member</option><option value="admin">admin</option></select></div><button class="button primary" type="submit">${deps.icons.plus}创建用户</button></form><table class="table"><thead><tr><th>用户</th><th>账号</th><th>系统角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></section>`);
  }

  function audit(): string {
    const state = deps.state(); const filters = deps.auditFilters();
    const rows = state.auditLogs.map((log: AuditLog) => `<div class="audit-row"><strong>${deps.escape(log.action)}</strong><div class="meta"><span>${deps.escape(deps.userName(log.userId))}</span><span>${deps.escape(log.targetType || "")}</span><span>${deps.escape(log.targetId || "")}</span><span>${deps.fmt(log.createdAt)}</span></div></div>`).join("");
    const exports = deps.isAdmin() ? `<a class="button" href="/api/audit-logs/export?${deps.auditQuery("csv")}" download>导出 CSV</a><a class="button" href="/api/audit-logs/export?${deps.auditQuery("json")}" download>导出 JSON</a>` : "";
    return deps.appRoot(`${deps.topbar("审计日志", "按操作者、动作和目标追溯工作台事件", exports)}<section class="content audit-content"><form class="card audit-filter" data-form="audit-filter"><div class="field"><label for="audit-user">操作者 ID</label><input class="input" id="audit-user" name="userId" value="${deps.escape(filters.userId)}" placeholder="全部" /></div><div class="field"><label for="audit-action">动作</label><input class="input" id="audit-action" name="action" value="${deps.escape(filters.action)}" placeholder="例如 session.created" /></div><div class="field"><label for="audit-target-type">目标类型</label><input class="input" id="audit-target-type" name="targetType" value="${deps.escape(filters.targetType)}" placeholder="例如 session" /></div><div class="field"><label for="audit-target-id">目标 ID</label><input class="input" id="audit-target-id" name="targetId" value="${deps.escape(filters.targetId)}" placeholder="全部" /></div><button class="button primary" type="submit">筛选日志</button><button class="button" type="button" data-action="clear-audit-filter">清除筛选</button></form><div class="audit-list" aria-live="polite">${rows || `<div class="empty">${deps.auditLoading() ? "正在读取审计日志…" : "没有符合条件的审计记录。"}</div>`}</div>${deps.auditCursor() ? `<button class="button load-more" data-action="load-more-audit" ${deps.auditLoading() ? "disabled" : ""}>${deps.auditLoading() ? "正在加载…" : "加载更多日志"}</button>` : ""}</section>`);
  }
  return { settings, users, audit };
}

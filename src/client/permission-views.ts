import type { HtmlValue, Permission, PermissionField, PermissionQuestion, Session } from "./types.js";

export interface PermissionViewDeps {
  icons: Record<string, string>;
  fmt(value: number): string;
  badge(value: HtmlValue, tone?: string): string;
  escapeHtml(value: HtmlValue): string;
  compactText(value: unknown, max?: number): string;
  canApprove(permission: Permission): boolean;
  canManageSession(session?: Session): boolean;
}

export function createPermissionViews(deps: PermissionViewDeps) {
  const { icons, fmt, badge, escapeHtml, compactText, canApprove, canManageSession } = deps;

function renderToolApprovalPolicy(session?: Session): string {
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
              ${canManageSession(session) ? `<button class="icon-button" title="撤销" data-remove-approval-scope="${row.scope}" data-remove-approval-value="${escapeHtml(row.value)}">${icons.close}</button>` : ""}
            </div>
          `).join("")
          : "<p>暂无已记住的工具授权。选择“总是允许工具/server”后会显示在这里。</p>"
      }
    </div>
  `;
}

function renderPermission(permission: Permission): string {
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

function renderPermissionOverlay(): string {
  return "";
}

function renderMcpPermission(permission: Permission, canAct: boolean): string {
  return `
    <div class="permission-card">
      <div class="meta">${badge("MCP 工具", "amber")} ${permission.serverName ? badge(permission.serverName, "blue") : ""}</div>
      <h4>${escapeHtml(permission.summary)}</h4>
      <p>${escapeHtml(permission.reason || "Harness 请求使用该工具。")}</p>
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

function renderPermissionInput(permission: Permission): string {
  const input = permission.toolInput && typeof permission.toolInput === "object" ? permission.toolInput : {};
  const primary: PermissionField[] = [];
  const secondary: PermissionField[] = [];
  const used = new Set<string>();
  const addField = (key: string, label: string, tone = ""): void => {
    if (input[key] === undefined || input[key] === null || input[key] === "") return;
    primary.push({ key, label, value: input[key], tone });
    used.add(key);
  };

  if (Array.isArray(input.questions)) {
    primary.push({ key: "questions", label: "问题", value: renderQuestionSummary(input.questions as PermissionQuestion[]), html: true });
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

function renderPermissionField(field: PermissionField): string {
  const value = field.html ? field.value : escapeHtml(compactText(field.value));
  const valueHtml = field.tone === "code" ? `<pre class="permission-code">${value}</pre>` : `<div class="permission-value">${value}</div>`;
  return `
    <div class="permission-field">
      <div class="permission-label">${escapeHtml(field.label)}</div>
      ${valueHtml}
    </div>
  `;
}

function renderQuestionSummary(questions: PermissionQuestion[]): string {
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
  return { renderPermission, renderToolApprovalPolicy, renderPermissionOverlay };
}

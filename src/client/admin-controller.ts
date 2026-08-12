import type { AdminMetrics, AppState, AuditFilters, AuditLog, Session, TeamTemplate } from "./types.js";
import { api } from "./api.js";

export interface AdminControllerDeps {
  state(): AppState;
  isAdmin(): boolean;
  selectedSessionIds: Set<string>;
  refresh(): Promise<void>;
  scheduleRender(): void;
  scheduleTeamRender(parts: { rail?: boolean; chat?: boolean; right?: boolean }, delay?: number): void;
  toast(message: string, tone?: "success" | "error" | "info"): void;
}

export function createAdminController(deps: AdminControllerDeps) {
  let metrics: AdminMetrics | null = null;
  let templates: TeamTemplate[] = [];
  let filters: AuditFilters = {};
  let cursor: string | null = null;
  let auditLoading = false;
  let loading = false;
  let editingId: string | null = null;
  const state = new Proxy({} as AppState, { get: (_target, key: keyof AppState) => deps.state()[key] });

  async function refreshData(): Promise<void> {
    if (!deps.isAdmin() || loading) return;
    loading = true;
    try {
      const [nextMetrics, result] = await Promise.all([
        api<AdminMetrics>("/api/admin/metrics"),
        api<{ templates: TeamTemplate[] }>("/api/admin/team-templates"),
      ]);
      metrics = nextMetrics;
      templates = result.templates || [];
      if (state.activeView === "settings") deps.scheduleRender();
    } catch (error) {
      if (state.activeView === "settings") deps.toast(error instanceof Error ? error.message : "管理指标暂时不可用", "info");
    } finally { loading = false; }
  }

  async function loadAudit({ reset = false }: { reset?: boolean } = {}): Promise<void> {
    if (auditLoading) return;
    auditLoading = true;
    try {
      const params = new URLSearchParams({ limit: "80" });
      if (!reset && cursor) params.set("cursor", cursor);
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      const result = await api<{ auditLogs: AuditLog[]; nextCursor?: string | null }>(`/api/audit-logs?${params}`);
      state.auditLogs = reset ? result.auditLogs : [...state.auditLogs, ...result.auditLogs];
      cursor = result.nextCursor || null;
    } finally { auditLoading = false; }
  }

  function auditQuery(format?: "json" | "csv"): string {
    const params = new URLSearchParams();
    if (format) params.set("format", format);
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    return params.toString();
  }

  async function filterAudit(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form);
    filters = Object.fromEntries(["userId", "action", "targetType", "targetId"]
      .map((key) => [key, String(data.get(key) || "").trim()]).filter(([, value]) => Boolean(value))) as AuditFilters;
    cursor = null;
    await loadAudit({ reset: true });
    deps.scheduleRender();
  }

  async function clearAuditFilters(): Promise<void> {
    filters = {}; cursor = null;
    await loadAudit({ reset: true });
    deps.scheduleRender();
  }

  async function batchArchive(archived: boolean): Promise<void> {
    if (!deps.isAdmin() || !deps.selectedSessionIds.size) return;
    const result = await api<{ sessions: Session[]; updatedCount: number; skipped?: { id: string }[] }>("/api/admin/sessions/archive-batch", {
      method: "POST", body: JSON.stringify({ sessionIds: [...deps.selectedSessionIds], archived }),
    });
    state.sessions = state.sessions.map((session) => result.sessions.find((updated) => updated.id === session.id) || session);
    deps.selectedSessionIds.clear();
    deps.toast(`已${archived ? "归档" : "恢复"} ${result.updatedCount} 个会话${result.skipped?.length ? `，${result.skipped.length} 项未变更` : ""}`, "success");
    deps.scheduleTeamRender({ rail: true, chat: true, right: true }, 0);
  }

  async function applyTemplate(templateId: string, teamId: string): Promise<void> {
    if (!deps.isAdmin() || !templateId || !teamId) return;
    await api(`/api/admin/team-templates/${encodeURIComponent(templateId)}/apply`, { method: "POST", body: JSON.stringify({ teamId }) });
    deps.toast("团队模板已应用", "success");
    await deps.refresh();
  }

  async function saveTemplate(form: HTMLFormElement): Promise<void> {
    if (!deps.isAdmin()) return;
    const data = new FormData(form);
    const result = await api<{ template: TeamTemplate }>("/api/admin/team-templates", { method: "POST", body: JSON.stringify({
      ...(String(data.get("id") || "") ? { id: String(data.get("id")) } : {}),
      name: String(data.get("name") || "").trim(), description: String(data.get("description") || "").trim(),
      workspaceMode: String(data.get("workspaceMode") || "shared"),
      modelContextTokens: Number(data.get("modelContextTokens") || 1_000_000),
      autoCompactRatio: Number(data.get("autoCompactRatio") || 0.62),
      autoCompactEnabled: data.get("autoCompactEnabled") === "on",
      mcpToolAllowlist: String(data.get("mcpToolAllowlist") || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean),
    }) });
    templates = [...templates.filter((item) => item.id !== result.template.id), result.template];
    editingId = null; form.reset(); deps.toast("团队模板已保存", "success"); deps.scheduleRender();
  }

  async function deleteTemplate(templateId: string): Promise<void> {
    const template = templates.find((item) => item.id === templateId);
    if (!deps.isAdmin() || !template || !confirm(`删除团队模板「${template.name}」？`)) return;
    await api(`/api/admin/team-templates/${encodeURIComponent(templateId)}`, { method: "DELETE" });
    templates = templates.filter((item) => item.id !== templateId);
    if (editingId === templateId) editingId = null;
    deps.toast("团队模板已删除", "success"); deps.scheduleRender();
  }

  return {
    refreshData, loadAudit, auditQuery, filterAudit, clearAuditFilters, batchArchive, applyTemplate, saveTemplate, deleteTemplate,
    metrics: () => metrics, templates: () => templates, filters: () => filters, cursor: () => cursor, auditLoading: () => auditLoading,
    loading: () => loading, editingTemplate: () => templates.find((template) => template.id === editingId) || null,
    editTemplate: (id: string) => { editingId = id; }, cancelTemplateEdit: () => { editingId = null; },
    resetAuditCursor: () => { cursor = null; },
  };
}

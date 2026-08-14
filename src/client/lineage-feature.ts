import { ApiError, api } from "./api.js";
import type {
  AppState, ColumnLineageResult, HtmlValue, LineageColumn, LineageGraph, LineageSyncRun,
  LineageTable, MaxComputeConfigView,
} from "./types.js";

interface LineageStatus { config: MaxComputeConfigView | null; running: boolean; runs: LineageSyncRun[] }
interface LineageDetail { table: LineageTable; columns: LineageColumn[]; relations: { upstream: number; downstream: number } }
interface ConnectionDiagnostic { stdout: string; stderr: string; parsed: Array<{ name: string; status: string; region: string }> }
interface SourceDiagnostic {
  dataDate: string;
  totalJobs: number;
  lineageReadyJobs: number;
  groups: Array<{ project: string; taskType: string; status: string; jobs: number; withInputs: number; withOutputs: number; lineageReady: number }>;
  samples: Array<{ project: string; taskName: string; taskType: string; instanceId: string; status: string; inputTables: string; outputTables: string; parsedInputs: string[]; parsedOutputs: string[] }>;
  warnings: string[];
  storage: { processedJobs: number; totalEdges: number };
  recoveryRecommended: boolean;
}

export interface LineageFeatureDeps {
  state(): AppState;
  isAdmin(): boolean;
  appRoot(inner: string): string;
  topbar(title: string, subtitle: string, actions?: string): string;
  escape(value: HtmlValue): string;
  fmt(timestamp: number): string;
  toast(message: string, tone?: "success" | "error" | "info"): void;
  scheduleRender(): void;
}

export function createLineageFeature(deps: LineageFeatureDeps) {
  let status: LineageStatus | null = null;
  let suggestions: LineageTable[] = [];
  let graph: LineageGraph | null = null;
  let detail: LineageDetail | null = null;
  let columnResult: ColumnLineageResult | null = null;
  let mode: "table" | "column" = "table";
  let queryText = "";
  let targetText = "";
  let columnText = "";
  let graphLoading = false;
  let analysisLoading = false;
  let connectionDiagnostic: ConnectionDiagnostic | null = null;
  let sourceDiagnostic: SourceDiagnostic | null = null;
  let searchTimer: number | undefined;
  let zoom = 1;

  async function load(): Promise<void> {
    status = await api<LineageStatus>("/api/lineage/status");
    deps.scheduleRender();
  }

  function render(): string {
    const syncBadge = syncStatus(status);
    const actions = `<div class="lineage-top-actions">${syncBadge}${deps.isAdmin() ? '<button class="button" type="button" data-action="lineage-sync">立即同步</button>' : ""}</div>`;
    return deps.appRoot(`${deps.topbar("数据血缘", "查询表级依赖，或让 Claude Code 从工作区实时分析字段加工逻辑", actions)}
      <section class="content lineage-page">
        <div class="lineage-workbench">
          ${renderQueryBar()}
          <div class="lineage-stage ${detail || columnResult ? "has-inspector" : ""}">
            <section class="lineage-canvas" aria-label="血缘关系图">
              ${renderCanvas()}
            </section>
            ${renderInspector()}
          </div>
        </div>
      </section>`);
  }

  function renderQueryBar(): string {
    const configProject = status?.config?.project || "";
    const selectedTeam = deps.state().selectedTeamId || deps.state().teams[0]?.id || "";
    const tableOptions = suggestions.map((table) => `<option value="${deps.escape(table.id)}">${deps.escape(table.comment || table.ownerName || table.type)}</option>`).join("");
    const columnOptions = detail?.columns.map((column) => `<option value="${deps.escape(column.name)}">${deps.escape(column.dataType)}${column.comment ? ` · ${deps.escape(column.comment)}` : ""}</option>`).join("") || "";
    const modeButtons = `<div class="segmented" role="group" aria-label="查询类型"><button type="button" class="segment ${mode === "table" ? "active" : ""}" data-lineage-mode="table">表血缘</button><button type="button" class="segment ${mode === "column" ? "active" : ""}" data-lineage-mode="column">字段血缘</button></div>`;
    return `<form class="lineage-querybar" data-form="lineage-query">
      <div class="lineage-query-main">
        <div class="lineage-mode-row">${modeButtons}<span class="lineage-source-note">${mode === "table" ? "系统库 · 每日同步" : "Claude Code · 实时只读分析"}</span></div>
        <div class="lineage-controls">
          <label class="lineage-field lineage-table-field"><span>查询表</span><input class="input" name="table" list="lineage-table-options" value="${deps.escape(queryText)}" placeholder="${deps.escape(configProject ? `${configProject}.table_name` : "输入 project.table 搜索")}" data-lineage-table-search autocomplete="off" required /></label>
          <datalist id="lineage-table-options">${tableOptions}</datalist>
          ${mode === "table" ? renderTableControls() : `<label class="lineage-field"><span>字段</span><input class="input" name="column" list="lineage-column-options" value="${deps.escape(columnText)}" placeholder="输入字段名" required /></label><datalist id="lineage-column-options">${columnOptions}</datalist><label class="lineage-field"><span>工作区</span><select class="select" name="teamId">${deps.state().teams.map((team) => `<option value="${deps.escape(team.id)}" ${team.id === selectedTeam ? "selected" : ""}>${deps.escape(team.name)}</option>`).join("")}</select></label>`}
          <button class="button primary lineage-submit" type="submit" ${graphLoading || analysisLoading ? "disabled" : ""}>${analysisLoading ? "正在分析…" : graphLoading ? "正在查询…" : mode === "table" ? "查询血缘" : "分析字段"}</button>
        </div>
      </div>
    </form>`;
  }

  function renderTableControls(): string {
    const scope = graph?.scope || "first";
    const direction = graph?.direction || "both";
    return `<label class="lineage-field"><span>血缘范围</span><select class="select" name="scope"><option value="first" ${scope === "first" ? "selected" : ""}>第一层</option><option value="deep" ${scope === "deep" ? "selected" : ""}>逐层展开</option><option value="terminal" ${scope === "terminal" ? "selected" : ""}>仅最终血缘</option><option value="path" ${scope === "path" ? "selected" : ""}>两表路径</option></select></label>
      <label class="lineage-field"><span>展开方向</span><select class="select" name="direction"><option value="both" ${direction === "both" ? "selected" : ""}>上下游</option><option value="up" ${direction === "up" ? "selected" : ""}>向上展开</option><option value="down" ${direction === "down" ? "selected" : ""}>向下展开</option></select></label>
      <label class="lineage-field lineage-target-field"><span>目标表（路径查询）</span><input class="input" name="target" list="lineage-table-options" value="${deps.escape(targetText)}" placeholder="选择路径终点" /></label>`;
  }

  function renderDataSync(): string {
    const config = status?.config;
    if (!config) return `<section class="content"><div class="card card-padding-lg"><p class="helper">正在读取 MaxCompute 数据同步配置…</p></div></section>`;
    const lastRun = status?.runs[0];
    const lastSuccessfulRun = status?.runs.find((run) => run.status === "success");
    const credentialState = config.credentialConfigured
      ? `<span class="sync-pill success"><i></i>已保存 ${deps.escape(config.accessKeyIdMasked || "AccessKey")}</span>`
      : `<span class="sync-pill neutral"><i></i>尚未配置凭据</span>`;
    const discovered = config.discoveredProjects || [];
    const selected = new Set(config.collectionProjects?.length ? config.collectionProjects : discovered.map((project) => project.name));
    const projectChoices = discovered.length
      ? discovered.map((project) => `<label class="sync-project-option ${config.collectionMode === "all" ? "readonly" : ""}"><input type="checkbox" name="collectionProjects" value="${deps.escape(project.name)}" ${config.collectionMode === "all" || selected.has(project.name) ? "checked" : ""} ${config.collectionMode === "all" ? "disabled" : ""} /><span><strong>${deps.escape(project.name)}</strong><small>${deps.escape([project.region, project.status].filter(Boolean).join(" · ") || "可访问")}</small></span></label>`).join("")
      : '<p class="empty-inline">保存连接后点击“发现项目”，系统会读取当前 AK 可见的项目。</p>';
    const diagnostic = connectionDiagnostic ? `<details class="sync-diagnostic" open><summary>最近一次采集预览</summary><div><div class="diagnostic-summary"><span>${connectionDiagnostic.parsed.length} 个项目已解析</span><small>仅显示连接验证的 CATALOGS 查询，不包含 AccessKey</small></div><pre>${deps.escape(connectionDiagnostic.stdout || connectionDiagnostic.stderr || "命令执行成功，但客户端未返回控制台文本。")}</pre><details><summary>查看解析后的 JSON</summary><pre>${deps.escape(JSON.stringify(connectionDiagnostic.parsed, null, 2))}</pre></details></div></details>` : "";
    const sourceDiagnosticPanel = sourceDiagnostic ? renderSourceDiagnostic(sourceDiagnostic) : "";
    const syncResult = lastSuccessfulRun
      ? `<section class="sync-result" aria-label="同步结果"><div class="sync-result-heading"><div><h4>同步结果</h4><small>数据日 ${deps.escape(lastSuccessfulRun.dataDate)} · ${lastSuccessfulRun.completedAt ? deps.fmt(lastSuccessfulRun.completedAt) : deps.fmt(lastSuccessfulRun.startedAt)}</small></div><span class="sync-pill success"><i></i>已完成</span></div><dl class="sync-result-metrics"><div><dt>项目</dt><dd>${lastSuccessfulRun.projectsProcessed}</dd></div><div><dt>表</dt><dd>${lastSuccessfulRun.tablesProcessed}</dd></div><div><dt>血缘关系</dt><dd>${lastSuccessfulRun.edgesProcessed}</dd></div></dl></section>`
      : `<section class="sync-result empty" aria-label="同步结果"><div><h4>同步结果</h4><small>首次同步完成后显示项目、表和血缘关系数量。</small></div></section>`;
    return `<section class="content data-sync-page">
      <div class="sync-overview">
        <article class="card sync-summary-card"><span>连接状态</span><strong>${credentialState}</strong><small>${discovered.length ? `已发现 ${discovered.length} 个可访问项目` : (config.endpoint ? deps.escape(config.endpoint) : "请配置服务 Endpoint")}</small></article>
        <article class="card sync-summary-card"><span>自动调度</span><strong>${config.enabled ? `每天 ${deps.escape(config.scheduleTime)}` : "已关闭"}</strong><small>${config.nextRunAt ? `下次 ${deps.fmt(config.nextRunAt)}` : "保存后计算下次执行时间"}</small></article>
        <article class="card sync-summary-card"><span>最近同步</span><strong>${lastRun ? (lastRun.status === "success" ? "成功" : lastRun.status === "failed" ? "失败" : "运行中") : "尚未执行"}</strong><small>${lastRun ? `${lastRun.projectsProcessed} 个项目 · ${lastRun.tablesProcessed} 张表 · ${lastRun.edgesProcessed} 条关系` : "可保存配置后手动触发"}</small></article>
      </div>
      <div class="sync-settings-grid">
        <form class="card card-padding-lg data-source-form" data-form="lineage-config">
          <div class="section-title"><div><h3>MaxCompute 数据源</h3><p class="helper">AccessKey 加密保存，运行 odpscmd 时仅写入权限为 0600 的临时配置文件，任务结束立即删除。</p></div>${credentialState}</div>
          <div class="grid two"><div class="field"><label for="mc-project">执行项目</label><input class="input" id="mc-project" name="project" value="${deps.escape(config.project)}" placeholder="用于发起 Information Schema 查询" required /><small class="helper">只用于承载查询和计费，不限制采集范围。</small></div><div class="field"><label for="mc-endpoint">Endpoint</label><input class="input" id="mc-endpoint" name="endpoint" type="url" value="${deps.escape(config.endpoint || "")}" placeholder="https://service.cn-shanghai.maxcompute.aliyun.com/api" required /></div></div>
          <div class="grid two"><div class="field"><label for="mc-ak-id">AccessKey ID</label><input class="input" id="mc-ak-id" name="accessKeyId" autocomplete="off" placeholder="${deps.escape(config.accessKeyIdMasked || "留空则保留现有凭据")}" /></div><div class="field"><label for="mc-ak-secret">AccessKey Secret</label><input class="input" id="mc-ak-secret" name="accessKeySecret" type="password" autocomplete="new-password" placeholder="${config.credentialConfigured ? "留空则保留现有凭据" : "请输入 AccessKey Secret"}" /></div></div>
          <fieldset class="sync-project-scope"><legend>采集项目</legend><div class="sync-scope-options"><label><input type="radio" name="collectionMode" value="all" ${config.collectionMode === "all" ? "checked" : ""} />同一元数据中心内全部可见项目</label><label><input type="radio" name="collectionMode" value="selected" ${config.collectionMode === "selected" ? "checked" : ""} />仅采集勾选项目</label></div><div class="sync-project-list">${projectChoices}</div><p class="helper">租户级 Information Schema 会按当前 AK 权限返回项目；不同元数据中心需单独配置数据源。</p></fieldset>
          <div class="sync-schedule-row"><label class="toggle-row"><input type="checkbox" name="enabled" ${config.enabled ? "checked" : ""} />启用每日自动同步</label><div class="field"><label for="mc-schedule">每日执行时间（Asia/Shanghai）</label><input class="input" id="mc-schedule" type="time" name="scheduleTime" value="${deps.escape(config.scheduleTime)}" required /></div></div>
          <details class="advanced-settings"><summary>高级执行设置</summary><div class="grid two"><div class="field"><label for="mc-command">odpscmd 命令</label><input class="input" id="mc-command" name="command" value="${deps.escape(config.command || "odpscmd")}" placeholder="Windows 可填写 C:\\MaxCompute\\bin\\odpscmd.bat" required /><small class="helper">Windows 直接填写 odpscmd.bat 的绝对路径，不要再填写 cmd.exe。</small></div><div class="field"><label for="mc-args">额外启动参数</label><input class="input" id="mc-args" name="args" value="${deps.escape(config.args || "")}" placeholder="通常留空" /><small class="helper">系统会自动传入临时配置、Project 和 SQL 文件。</small></div></div></details>
          ${diagnostic}${sourceDiagnosticPanel}<div class="form-actions"><button class="button primary" type="submit">保存数据源与调度</button><button class="button" type="button" data-action="lineage-test-connection">发现项目并验证连接</button><button class="button" type="button" data-action="lineage-source-diagnostic">诊断血缘来源</button><button class="button" type="button" data-action="lineage-sync" ${status?.running ? "disabled" : ""}>${status?.running ? "正在同步" : "立即同步"}</button></div>
        </form>
        <aside class="card card-padding-lg sync-history"><div class="section-title"><h3>最近执行</h3><span class="meta">数据日期 T-1</span></div>${syncResult}<div class="sync-run-list">${status?.runs.map((run) => `<div class="sync-run-row"><span class="run-dot ${run.status}"></span><div><strong>${run.trigger === "manual" ? "手动同步" : "自动调度"}</strong><small>${deps.fmt(run.startedAt)} · ${run.projectsProcessed} 项目 · ${run.tablesProcessed} 表 · ${run.edgesProcessed} 关系</small></div><span>${run.status === "success" ? "成功" : run.status === "failed" ? "失败" : "运行中"}</span></div>`).join("") || '<p class="empty-inline">暂无执行记录</p>'}</div>${config.lastError ? `<div class="inline-alert error"><strong>最近同步失败</strong><span>${deps.escape(config.lastError)}</span></div>` : ""}<div class="security-note"><strong>凭据安全</strong><p>生产环境建议设置 <code>CREDENTIAL_ENCRYPTION_KEY</code> 并使用独立 RAM 用户、最小权限和定期轮换。页面与接口不会回传 Secret。</p></div></aside>
      </div>
    </section>`;
  }

  function renderSourceDiagnostic(value: SourceDiagnostic): string {
    const groups = value.groups.map((group) => `<tr><td>${deps.escape(group.project)}</td><td>${deps.escape(group.taskType)}</td><td>${deps.escape(group.status)}</td><td>${group.jobs}</td><td>${group.withInputs}</td><td>${group.withOutputs}</td><td>${group.lineageReady}</td></tr>`).join("");
    const warnings = value.warnings.length ? `<ul class="source-diagnostic-warnings">${value.warnings.map((warning) => `<li>${deps.escape(warning)}</li>`).join("")}</ul>` : '<p class="source-diagnostic-ok">来源任务具备生成血缘的输入与输出信息。</p>';
    const recovery = value.recoveryRecommended ? '<div class="source-diagnostic-recovery"><p>来源中存在可生成血缘的任务，但系统库仍为 0 条关系。此前错误解析留下的“已处理”标记很可能阻止了补建。</p><button class="button" type="button" data-action="lineage-reprocess">清除 T-1 旧标记并重新同步</button></div>' : "";
    return `<details class="source-diagnostic" open><summary>血缘来源诊断 · ${deps.escape(value.dataDate)}</summary><div class="source-diagnostic-body"><div class="source-diagnostic-metrics"><span><strong>${value.totalJobs}</strong>来源任务</span><span><strong>${value.lineageReadyJobs}</strong>可建血缘</span><span><strong>${value.storage.processedJobs}</strong>已处理标记</span><span><strong>${value.storage.totalEdges}</strong>系统库关系</span></div>${warnings}${recovery}<div class="source-diagnostic-table-wrap"><table><thead><tr><th>项目</th><th>类型</th><th>状态</th><th>任务</th><th>有输入</th><th>有输出</th><th>可建血缘</th></tr></thead><tbody>${groups || '<tr><td colspan="7">未返回分组数据</td></tr>'}</tbody></table></div><details><summary>查看可提供给开发人员的诊断 JSON</summary><pre>${deps.escape(JSON.stringify(value, null, 2))}</pre></details></div></details>`;
  }

  function renderCanvas(): string {
    const toolbar = `<div class="lineage-canvas-toolbar"><span>${graph ? `${graph.tables.length} 个节点 · ${graph.edges.length} 条关系` : "关系画布"}</span><div><button class="icon-button compact" type="button" title="缩小" aria-label="缩小血缘图" data-action="lineage-zoom-out">−</button><button class="icon-button compact" type="button" title="适应画布" aria-label="适应画布" data-action="lineage-fit">⌗</button><button class="icon-button compact" type="button" title="放大" aria-label="放大血缘图" data-action="lineage-zoom-in">＋</button><button class="button compact" type="button" data-action="lineage-download">导出 SVG</button></div></div>`;
    if (graphLoading || analysisLoading) return `${toolbar}<div class="lineage-skeleton"><span></span><span></span><span></span><p>${analysisLoading ? "Claude Code 正在工作区中定位字段定义与转换逻辑…" : "正在读取系统库中的血缘关系…"}</p></div>`;
    if (mode === "column" && columnResult) return `${toolbar}${renderColumnGraph(columnResult)}`;
    if (graph) return `${toolbar}${graphSvg(graph, zoom, deps.escape)}`;
    return `${toolbar}<div class="lineage-empty"><svg viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="24"/><path d="M24 48H10m76 0H72M48 24V10m0 76V72"/><circle cx="10" cy="48" r="5"/><circle cx="86" cy="48" r="5"/><circle cx="48" cy="10" r="5"/><circle cx="48" cy="86" r="5"/></svg><h2>从一张表开始探索</h2><p>搜索表名后可查看上下游关系；字段模式会实时读取所选工作区，不保存字段加工逻辑。</p></div>`;
  }

  function renderColumnGraph(result: ColumnLineageResult): string {
    if (!result.relations.length) return `<div class="lineage-empty"><h2>没有找到可验证的字段关系</h2><p>${deps.escape(result.summary || "Claude Code 未在工作区中找到足够的代码证据。")}</p></div>`;
    const tables = new Map<string, { table: string; column: string; side: "source" | "target" | "center" }>();
    result.relations.forEach((relation) => {
      const sourceKey = `${relation.sourceTable}.${relation.sourceColumn}`;
      const targetKey = `${relation.targetTable}.${relation.targetColumn}`;
      tables.set(sourceKey, { table: relation.sourceTable, column: relation.sourceColumn, side: targetKey === `${result.table}.${result.column}` ? "source" : "source" });
      tables.set(targetKey, { table: relation.targetTable, column: relation.targetColumn, side: sourceKey === `${result.table}.${result.column}` ? "target" : "target" });
    });
    tables.set(`${result.table}.${result.column}`, { table: result.table, column: result.column, side: "center" });
    const items = [...tables.entries()];
    const sources = items.filter(([, value]) => value.side === "source" && `${value.table}.${value.column}` !== `${result.table}.${result.column}`);
    const targets = items.filter(([, value]) => value.side === "target" && `${value.table}.${value.column}` !== `${result.table}.${result.column}`);
    const height = Math.max(380, Math.max(sources.length, targets.length, 1) * 100 + 100);
    const centerY = height / 2;
    const node = (key: string, value: { table: string; column: string }, x: number, y: number, active = false) => `<g class="lineage-svg-node column-node ${active ? "root" : ""}" transform="translate(${x} ${y})"><rect width="210" height="66" rx="8"/><text class="node-name" x="14" y="27">${deps.escape(shortName(value.table, 25))}</text><text class="node-meta" x="14" y="49">${deps.escape(value.column)}</text><title>${deps.escape(key)}</title></g>`;
    const positions = new Map<string, { x: number; y: number }>();
    sources.forEach(([key], index) => positions.set(key, { x: 50, y: spread(index, sources.length, height) }));
    targets.forEach(([key], index) => positions.set(key, { x: 710, y: spread(index, targets.length, height) }));
    positions.set(`${result.table}.${result.column}`, { x: 380, y: centerY - 33 });
    const paths = result.relations.map((relation) => {
      const from = positions.get(`${relation.sourceTable}.${relation.sourceColumn}`);
      const to = positions.get(`${relation.targetTable}.${relation.targetColumn}`);
      if (!from || !to) return "";
      return `<path class="lineage-edge" d="M${from.x + 210} ${from.y + 33} C${from.x + 270} ${from.y + 33},${to.x - 60} ${to.y + 33},${to.x} ${to.y + 33}" marker-end="url(#lineage-arrow)"/><text class="edge-label" x="${(from.x + to.x + 210) / 2}" y="${(from.y + to.y) / 2 + 23}">${deps.escape(shortName(relation.transformation, 24))}</text>`;
    }).join("");
    const nodes = items.map(([key, value]) => { const pos = positions.get(key); return pos ? node(key, value, pos.x, pos.y, value.side === "center") : ""; }).join("");
    return `<div class="lineage-svg-wrap"><svg class="lineage-graph" id="lineage-graph-svg" viewBox="0 0 970 ${height}" role="img" aria-label="${deps.escape(result.table)} 的字段血缘图"><defs><marker id="lineage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker></defs>${paths}${nodes}</svg></div>`;
  }

  function renderInspector(): string {
    if (!detail && !columnResult) return "";
    if (mode === "column" && columnResult) return `<aside class="lineage-inspector"><div class="inspector-header"><div><span class="inspector-kicker">字段加工逻辑</span><h2>${deps.escape(columnResult.column)}</h2><p>${deps.escape(columnResult.table)}</p></div><button class="icon-button" type="button" aria-label="关闭详情" data-action="lineage-close-detail">×</button></div><div class="inspector-scroll">${columnResult.summary ? `<section class="inspector-section"><h3>分析总结</h3><p class="lineage-summary">${deps.escape(columnResult.summary)}</p></section>` : ""}${renderRelations(columnResult)}${renderEvidence(columnResult)}${columnResult.warnings.length ? `<section class="inspector-section"><h3>注意事项</h3><ul class="warning-list">${columnResult.warnings.map((warning) => `<li>${deps.escape(warning)}</li>`).join("")}</ul></section>` : ""}</div></aside>`;
    if (!detail) return "";
    const table = detail.table;
    return `<aside class="lineage-inspector"><div class="inspector-header"><div><span class="inspector-kicker">${deps.escape(table.type)}</span><h2>${deps.escape(table.name)}</h2><p>${deps.escape(table.project)}</p></div><button class="icon-button" type="button" aria-label="关闭详情" data-action="lineage-close-detail">×</button></div><div class="inspector-scroll"><section class="inspector-section"><p class="lineage-summary">${deps.escape(table.comment || "暂无表说明")}</p><div class="lineage-relation-count"><span><strong>${detail.relations.upstream}</strong>上游</span><span><strong>${detail.relations.downstream}</strong>下游</span></div></section>${metadataGrid(table)}<section class="inspector-section"><div class="section-title"><h3>字段</h3><span>${detail.columns.length} 个</span></div><div class="lineage-column-list">${detail.columns.map((column) => `<button type="button" data-lineage-column="${deps.escape(column.name)}"><span><strong>${deps.escape(column.name)}</strong><small>${deps.escape(column.comment || (column.partitionKey ? "分区字段" : ""))}</small></span><code>${deps.escape(column.dataType)}</code></button>`).join("") || '<p class="empty-inline">暂未同步字段元数据</p>'}</div></section></div></aside>`;
  }

  function metadataGrid(table: LineageTable): string {
    const items = [
      ["Owner", table.ownerName || "未知"], ["最近调度", dateText(table.lastScheduleTime)], ["最近访问", dateText(table.lastAccessTime)],
      ["最近更新", dateText(table.lastModifiedTime)], ["调度节点", table.scheduleNodeName || table.lastTaskName || "未知"],
      ["调度责任人", table.scheduleOnDuty || table.scheduleOwner || "未知"], ["数据大小", bytes(table.dataLength)],
      ["分区", table.isPartitioned ? `${table.partitionCount} 个` : "非分区表"], ["访问次数", table.accessCount.toLocaleString()],
      ["访问数据量", bytes(table.accessBytes)], ["存储格式", table.tableFormat || table.storageTier || "未知"],
      ["生命周期", table.lifecycle ? `${table.lifecycle} 天` : "未设置"],
    ];
    return `<section class="inspector-section"><h3>表信息</h3><dl class="metadata-grid">${items.map(([label, value]) => `<div><dt>${deps.escape(label)}</dt><dd>${deps.escape(value)}</dd></div>`).join("")}</dl></section>`;
  }

  function renderRelations(result: ColumnLineageResult): string {
    return `<section class="inspector-section"><div class="section-title"><h3>字段关系</h3><span>${result.relations.length} 条</span></div><div class="column-relations">${result.relations.map((relation) => `<div><div class="relation-path"><code>${deps.escape(relation.sourceTable)}.${deps.escape(relation.sourceColumn)}</code><span>→</span><code>${deps.escape(relation.targetTable)}.${deps.escape(relation.targetColumn)}</code></div><p>${deps.escape(relation.transformation)}</p><span class="confidence ${relation.confidence}">${relation.confidence === "high" ? "高置信" : relation.confidence === "medium" ? "中置信" : "低置信"}</span></div>`).join("")}</div></section>`;
  }

  function renderEvidence(result: ColumnLineageResult): string {
    return `<section class="inspector-section"><div class="section-title"><h3>代码证据</h3><span>${result.evidence.length} 处</span></div><div class="code-evidence">${result.evidence.map((item, index) => `<details ${index === 0 ? "open" : ""}><summary><span>${deps.escape(item.path)}</span><small>L${item.startLine}–${item.endLine}</small></summary><p>${deps.escape(item.explanation)}</p><pre><code>${deps.escape(item.snippet)}</code></pre></details>`).join("") || '<p class="empty-inline">没有可验证的代码片段</p>'}</div></section>`;
  }

  async function submitQuery(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form);
    const rawTable = String(data.get("table") || "").trim();
    const project = status?.config?.project || "";
    const table = rawTable.includes(".") || !project ? rawTable : `${project}.${rawTable}`;
    queryText = table;
    if (mode === "column") {
      columnText = String(data.get("column") || "").trim();
      analysisLoading = true; columnResult = null; graph = null; deps.scheduleRender();
      try {
        const payload = { teamId: String(data.get("teamId") || ""), table, column: columnText };
        const response = await api<{ result: ColumnLineageResult }>("/api/lineage/columns/analyze", { method: "POST", body: JSON.stringify(payload) });
        columnResult = response.result;
        await loadDetail(table, false);
      } finally { analysisLoading = false; deps.scheduleRender(); }
      return;
    }
    graphLoading = true; columnResult = null; deps.scheduleRender();
    try {
      const scope = String(data.get("scope") || "first");
      const direction = String(data.get("direction") || "both");
      targetText = String(data.get("target") || "").trim();
      if (scope === "path" && !targetText) throw new Error("路径查询需要选择目标表。");
      const params = new URLSearchParams({ table, scope, direction, depth: "6", limit: "160" });
      if (targetText) params.set("target", targetText.includes(".") || !project ? targetText : `${project}.${targetText}`);
      graph = await api<LineageGraph>(`/api/lineage/graph?${params}`);
      zoom = 1;
      await loadDetail(table, false);
    } finally { graphLoading = false; deps.scheduleRender(); }
  }

  async function saveConfig(form: HTMLFormElement, announce = true): Promise<void> {
    const data = new FormData(form);
    const response = await api<{ config: MaxComputeConfigView }>("/api/lineage/config", { method: "PATCH", body: JSON.stringify({ enabled: data.get("enabled") === "on", project: String(data.get("project") || ""), collectionMode: String(data.get("collectionMode") || "all"), collectionProjects: data.getAll("collectionProjects").map(String), endpoint: String(data.get("endpoint") || ""), accessKeyId: String(data.get("accessKeyId") || ""), accessKeySecret: String(data.get("accessKeySecret") || ""), scheduleTime: String(data.get("scheduleTime") || ""), command: String(data.get("command") || ""), args: String(data.get("args") || "") }) });
    status = { ...(status ?? { running: false, runs: [] }), config: response.config };
    if (announce) deps.toast("同步设置已保存", "success");
    deps.scheduleRender();
  }

  async function testConnection(): Promise<void> {
    const form = document.querySelector<HTMLFormElement>('[data-form="lineage-config"]');
    if (form) await saveConfig(form, false);
    try {
      const result = await api<{ connected: boolean; latencyMs: number; projects: Array<{ name: string; status: string; region: string }>; diagnostic: ConnectionDiagnostic }>("/api/lineage/connection-test", { method: "POST", body: "{}" });
      connectionDiagnostic = result.diagnostic;
      deps.toast(`连接成功，发现 ${result.projects.length} 个项目（${result.latencyMs} ms）`, "success");
      await load();
      deps.scheduleRender();
    } catch (error) {
      if (error instanceof ApiError && isConnectionDiagnostic(error.details)) {
        connectionDiagnostic = error.details.diagnostic;
        deps.scheduleRender();
      }
      throw error;
    }
  }

  async function triggerSync(): Promise<void> {
    await api("/api/lineage/sync", { method: "POST", body: "{}" });
    deps.toast("血缘同步已启动", "success");
    await load();
    pollStatus();
  }

  async function diagnoseSource(): Promise<void> {
    const form = document.querySelector<HTMLFormElement>('[data-form="lineage-config"]');
    if (form) await saveConfig(form, false);
    const response = await api<{ diagnostic: SourceDiagnostic }>("/api/lineage/source-diagnostic", { method: "POST", body: "{}" });
    sourceDiagnostic = response.diagnostic;
    deps.toast(`诊断完成：${sourceDiagnostic.totalJobs} 个来源任务，${sourceDiagnostic.lineageReadyJobs} 个可生成血缘`, sourceDiagnostic.lineageReadyJobs ? "success" : "info");
    deps.scheduleRender();
  }

  async function reprocess(): Promise<void> {
    const response = await api<{ resetJobs: number }>("/api/lineage/reprocess", { method: "POST", body: "{}" });
    deps.toast(`已清除 ${response.resetJobs} 个旧标记并启动重新同步`, "success");
    sourceDiagnostic = null;
    await load();
    pollStatus();
  }

  function search(value: string): void {
    queryText = value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      if (value.trim().length < 2) { suggestions = []; return; }
      void api<{ tables: LineageTable[] }>(`/api/lineage/tables?q=${encodeURIComponent(value.trim())}&limit=30`).then((response) => { suggestions = response.tables; deps.scheduleRender(); }).catch(() => undefined);
    }, 220);
  }

  async function selectNode(id: string): Promise<void> { await loadDetail(id, true); }

  async function loadDetail(id: string, rerender: boolean): Promise<void> {
    try { detail = await api<LineageDetail>(`/api/lineage/tables/${encodeURIComponent(id)}`); }
    catch { detail = null; }
    if (rerender) deps.scheduleRender();
  }

  function setMode(value: "table" | "column"): void { mode = value; graph = null; columnResult = null; deps.scheduleRender(); }
  function setCollectionMode(value: "all" | "selected"): void {
    document.querySelectorAll<HTMLInputElement>('[name="collectionProjects"]').forEach((input) => {
      input.disabled = value === "all";
      if (value === "all") input.checked = true;
      input.closest(".sync-project-option")?.classList.toggle("readonly", value === "all");
    });
  }
  function closeDetail(): void { detail = null; columnResult = null; deps.scheduleRender(); }
  function chooseColumn(column: string): void { mode = "column"; columnText = column; deps.scheduleRender(); window.setTimeout(() => { document.querySelector<HTMLInputElement>('[name="column"]')?.focus(); }, 0); }
  function zoomBy(delta: number): void { zoom = Math.max(0.55, Math.min(1.8, zoom + delta)); deps.scheduleRender(); }
  function fit(): void { zoom = 1; deps.scheduleRender(); }

  function downloadGraph(): void {
    const svg = document.querySelector<SVGSVGElement>("#lineage-graph-svg");
    if (!svg) { deps.toast("当前没有可导出的血缘图", "info"); return; }
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = `.lineage-edge{fill:none;stroke:#91a3bd;stroke-width:1.5}.lineage-svg-node rect{fill:#fff;stroke:#b9c8dc;stroke-width:1.25}.lineage-svg-node.root rect{fill:#eef5ff;stroke:#1677ff;stroke-width:2}.node-name{font:600 14px system-ui;fill:#172033}.node-meta{font:12px system-ui;fill:#68778d}.edge-label{font:11px system-ui;fill:#68778d;text-anchor:middle}marker path{fill:#91a3bd}`;
    copy.prepend(style);
    const blob = new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml;charset=utf-8" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `lineage-${(graph?.rootId || columnResult?.table || "graph").replaceAll(".", "-")}.svg`; link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  }

  function pollStatus(): void {
    let attempts = 0;
    const tick = () => { void api<LineageStatus>("/api/lineage/status").then((next) => { status = next; deps.scheduleRender(); attempts += 1; if (next.running && attempts < 240) window.setTimeout(tick, 1_500); }).catch(() => undefined); };
    window.setTimeout(tick, 1_000);
  }

  function dateText(value?: number | null): string { return value ? deps.fmt(value) : "暂无"; }

  return { render, renderDataSync, load, submitQuery, saveConfig, testConnection, triggerSync, diagnoseSource, reprocess, search, selectNode, setMode, setCollectionMode, closeDetail, chooseColumn, zoomBy, fit, downloadGraph };
}

function isConnectionDiagnostic(value: unknown): value is { diagnostic: ConnectionDiagnostic } {
  if (!value || typeof value !== "object" || !("diagnostic" in value)) return false;
  const diagnostic = (value as { diagnostic?: unknown }).diagnostic;
  return Boolean(diagnostic && typeof diagnostic === "object" && "stdout" in diagnostic && "stderr" in diagnostic && "parsed" in diagnostic);
}

function syncStatus(status: LineageStatus | null): string {
  if (!status?.config) return '<span class="sync-pill neutral"><i></i>等待配置</span>';
  if (status.running || status.config.lastStatus === "running") return '<span class="sync-pill running"><i></i>正在同步</span>';
  if (status.config.lastStatus === "failed") return '<span class="sync-pill failed"><i></i>同步失败</span>';
  if (status.config.lastStatus === "success") return '<span class="sync-pill success"><i></i>数据已同步</span>';
  return `<span class="sync-pill neutral"><i></i>${status.config.enabled ? "等待首次同步" : "自动同步已关闭"}</span>`;
}

function graphSvg(graph: LineageGraph, zoom: number, escape: (value: HtmlValue) => string): string {
  const layout = graphLayout(graph);
  const viewWidth = layout.width / zoom;
  const viewHeight = layout.height / zoom;
  const viewX = (layout.width - viewWidth) / 2;
  const viewY = (layout.height - viewHeight) / 2;
  const paths = graph.edges.map((edge) => {
    const from = layout.positions.get(edge.sourceTableId); const to = layout.positions.get(edge.targetTableId);
    if (!from || !to) return "";
    const label = edge.collapsed ? `折叠 ${edge.collapsed} 层` : edge.lastNodeName || "";
    return `<path class="lineage-edge" d="M${from.x + 210} ${from.y + 35} C${from.x + 255} ${from.y + 35},${to.x - 45} ${to.y + 35},${to.x} ${to.y + 35}" marker-end="url(#lineage-arrow)"/>${label ? `<text class="edge-label" x="${(from.x + to.x + 210) / 2}" y="${(from.y + to.y) / 2 + 24}">${escape(shortName(label, 22))}</text>` : ""}`;
  }).join("");
  const nodes = graph.tables.map((table) => {
    const pos = layout.positions.get(table.id); if (!pos) return "";
    const root = table.id === graph.rootId;
    const tone = table.type.includes("VIEW") ? "view" : "table";
    return `<g class="lineage-svg-node ${tone} ${root ? "root" : ""}" transform="translate(${pos.x} ${pos.y})" tabindex="0" role="button" data-lineage-node="${escape(table.id)}"><rect width="210" height="70" rx="8"/><rect class="node-icon-bg" x="12" y="18" width="32" height="32" rx="6"/><text class="node-icon" x="28" y="39">${tone === "view" ? "V" : "T"}</text><text class="node-name" x="54" y="29">${escape(shortName(table.name, 23))}</text><text class="node-meta" x="54" y="50">${escape(shortName(table.project, 26))}</text><title>${escape(table.id)}${table.comment ? ` · ${escape(table.comment)}` : ""}</title></g>`;
  }).join("");
  return `<div class="lineage-svg-wrap"><svg class="lineage-graph" id="lineage-graph-svg" viewBox="${viewX} ${viewY} ${viewWidth} ${viewHeight}" role="img" aria-label="${escape(graph.rootId)} 的表血缘图"><defs><marker id="lineage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker></defs>${paths}${nodes}</svg>${graph.truncated ? '<div class="graph-notice">节点数量较多，当前结果已截断。可缩小展开范围后重新查询。</div>' : ""}</div>`;
}

function graphLayout(graph: LineageGraph): { positions: Map<string, { x: number; y: number }>; width: number; height: number } {
  const levels = new Map<string, number>([[graph.rootId, 0]]);
  for (let pass = 0; pass < graph.tables.length + 2; pass += 1) {
    for (const edge of graph.edges) {
      const source = levels.get(edge.sourceTableId); const target = levels.get(edge.targetTableId);
      if (source !== undefined && target === undefined) levels.set(edge.targetTableId, source + 1);
      else if (target !== undefined && source === undefined) levels.set(edge.sourceTableId, target - 1);
    }
  }
  graph.tables.forEach((table) => { if (!levels.has(table.id)) levels.set(table.id, 0); });
  const minLevel = Math.min(...levels.values()); const maxLevel = Math.max(...levels.values());
  const groups = new Map<number, string[]>();
  for (const [id, level] of levels) { const group = groups.get(level) ?? []; group.push(id); groups.set(level, group); }
  groups.forEach((group) => group.sort());
  const maxRows = Math.max(...[...groups.values()].map((group) => group.length), 1);
  const height = Math.max(420, maxRows * 94 + 100); const width = Math.max(760, (maxLevel - minLevel + 1) * 270 + 100);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, ids] of groups) ids.forEach((id, index) => positions.set(id, { x: 50 + (level - minLevel) * 270, y: spread(index, ids.length, height) }));
  return { positions, width, height };
}

function spread(index: number, count: number, height: number): number { return count <= 1 ? height / 2 - 35 : 50 + index * ((height - 120) / (count - 1)); }
function shortName(value: string, maximum: number): string { return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value; }
function bytes(value?: number | null): string { if (value === null || value === undefined || !Number.isFinite(value)) return "暂无"; const units = ["B", "KB", "MB", "GB", "TB", "PB"]; let size = Math.max(0, value); let index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; } return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`; }

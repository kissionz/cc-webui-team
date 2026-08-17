import { ApiError, api } from "./api.js";
import type {
  AppState, ColumnLineageResult, ColumnSelectionAnalysisResult, DataWorksColumnGraph, HtmlValue,
  LineageColumn, LineageGraph, LineageSyncRun, LineageTable, MaxComputeConfigView,
} from "./types.js";

interface LineageStatus { config: MaxComputeConfigView | null; running: boolean; runs: LineageSyncRun[] }
interface LineageDetail { table: LineageTable; columns: LineageColumn[]; relations: { upstream: number; downstream: number } }
type ExpansionDirection = "up" | "down";
interface DirectionalExpansion<T> { nodeId: string; direction: ExpansionDirection; graph: T }
interface ConnectionDiagnostic { stdout: string; stderr: string; parsed: Array<{ name: string; status: string; region: string }> }
interface SourceDiagnostic {
  dataDate: string;
  totalJobs: number;
  lineageReadyJobs: number;
  groups: Array<{ project: string; taskType: string; status: string; jobs: number; withInputs: number; withOutputs: number; lineageReady: number }>;
  samples: Array<{ project: string; taskName: string; taskType: string; instanceId: string; status: string; inputTables: string; outputTables: string; parsedInputs: string[]; parsedOutputs: string[] }>;
  warnings: string[];
  storage: { processedJobs: number; stagedJobs: number; parsedJobs: number; invalidJobs: number; observations: number; totalEdges: number };
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
  let sourceSuggestions: LineageTable[] = [];
  let targetSuggestions: LineageTable[] = [];
  let graph: LineageGraph | null = null;
  let baseTableGraph: LineageGraph | null = null;
  let detail: LineageDetail | null = null;
  let columnGraph: DataWorksColumnGraph | null = null;
  let baseColumnGraph: DataWorksColumnGraph | null = null;
  let selectionAnalysis: ColumnSelectionAnalysisResult | null = null;
  const selectedColumns = new Set<string>();
  let mode: "table" | "column" = "table";
  let tableScope: "first" | "deep" | "terminal" | "path" = "first";
  let tableDirection: "up" | "down" | "both" = "both";
  let canvasMode: "select" | "pan" = "select";
  let maximized = false;
  let spacePressed = false;
  let canvasView: { x: number; y: number; width: number; height: number } | null = null;
  let drag: { kind: "pan" | "box" | "node"; startX: number; startY: number; lastX: number; lastY: number; nodeId?: string; additive: boolean; view?: { x: number; y: number; width: number; height: number } } | null = null;
  let analysisTeamId = "";
  let analysisController: AbortController | null = null;
  let queryText = "";
  let targetText = "";
  let columnText = "";
  let graphLoading = false;
  let analysisLoading = false;
  let analysisElapsedSeconds = 0;
  let analysisTimer: number | undefined;
  let connectionDiagnostic: ConnectionDiagnostic | null = null;
  let sourceDiagnostic: SourceDiagnostic | null = null;
  let searchTimer: number | undefined;
  let activeTablePicker: "source" | "target" | null = null;
  const loadedColumnDirections = new Set<string>();
  const loadedTableDirections = new Set<string>();
  const expandingDirections = new Set<string>();
  const columnExpansions = new Map<string, DirectionalExpansion<DataWorksColumnGraph>>();
  const tableExpansions = new Map<string, DirectionalExpansion<LineageGraph>>();

  async function load(): Promise<void> {
    status = await api<LineageStatus>("/api/lineage/status");
    deps.scheduleRender();
  }

  function render(): string {
    const syncBadge = syncStatus(status);
    const actions = `<div class="lineage-top-actions">${syncBadge}</div>`;
    return deps.appRoot(`${deps.topbar("数据血缘", "查询表级依赖，或让 Harness 从工作区实时分析字段加工逻辑", actions)}
      <section class="content lineage-page">
        <div class="lineage-workbench ${maximized ? "maximized" : ""}">
          ${renderQueryBar()}
          <div class="lineage-stage ${(mode === "table" ? detail : selectionAnalysis || analysisLoading) ? "has-inspector" : ""}">
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
    const columnOptions = detail?.columns.map((column) => `<option value="${deps.escape(column.name)}" label="${deps.escape([column.comment, column.dataType].filter(Boolean).join(" · "))}"></option>`).join("") || "";
    const modeButtons = `<div class="segmented" role="group" aria-label="查询类型"><button type="button" class="segment ${mode === "table" ? "active" : ""}" data-lineage-mode="table">表血缘</button><button type="button" class="segment ${mode === "column" ? "active" : ""}" data-lineage-mode="column">字段血缘</button></div>`;
    const sourcePicker = renderTablePicker("source", mode === "table" && tableScope === "path" ? "表 A" : "查询表", queryText, configProject ? `${configProject}.table_name` : "输入 project.table 搜索");
    const queryControls = mode === "column"
      ? `<div class="lineage-controls column-query-controls">${sourcePicker}<label class="lineage-field"><span>字段</span><input class="input" name="column" list="lineage-column-options" value="${deps.escape(columnText)}" placeholder="输入字段名" required /></label><datalist id="lineage-column-options">${columnOptions}</datalist><label class="lineage-field"><span>工作区</span><select class="select" name="teamId">${deps.state().teams.map((team) => `<option value="${deps.escape(team.id)}" ${team.id === selectedTeam ? "selected" : ""}>${deps.escape(String(team.name).replace(/Claude Code/gi, "Harness").replace(/\bClaude\b/gi, "Harness"))}</option>`).join("")}</select></label><button class="button primary lineage-submit" type="submit" ${graphLoading ? "disabled" : ""}>${graphLoading ? "正在查询…" : "查看字段血缘"}</button></div>`
      : `${renderTableControls()}${tableScope === "path" ? `<div class="lineage-path-query"><div class="lineage-path-endpoint"><span class="endpoint-label">起点或终点</span>${sourcePicker}</div><button class="lineage-path-swap" type="button" data-action="lineage-swap-path" aria-label="交换两张表" title="交换两张表">⇄</button><div class="lineage-path-endpoint"><span class="endpoint-label">另一个端点</span>${renderTablePicker("target", "表 B", targetText, "输入另一张表")}</div><button class="button primary lineage-submit" type="submit" ${graphLoading ? "disabled" : ""}>${graphLoading ? "正在查询…" : "查询两表路径"}</button></div>` : `<div class="lineage-standard-query">${sourcePicker}<button class="button primary lineage-submit" type="submit" ${graphLoading ? "disabled" : ""}>${graphLoading ? "正在查询…" : "查询血缘"}</button></div>`}`;
    return `<form class="lineage-querybar" data-form="lineage-query">
      <div class="lineage-query-main">
        <div class="lineage-mode-row">${modeButtons}<span class="lineage-source-note">${mode === "table" ? "系统库 · 每日增量同步" : "DataWorks 首层即时返回 · 点击节点继续展开"}</span></div>
        ${queryControls}
      </div>
    </form>`;
  }

  function renderTableControls(): string {
    return `<div class="lineage-table-command-row"><div class="lineage-field lineage-scope-field"><span>血缘范围</span><div class="lineage-scope-buttons" role="group" aria-label="血缘范围"><button type="button" class="${tableScope === "first" ? "active" : ""}" data-lineage-scope="first">一层</button><button type="button" class="${tableScope === "deep" ? "active" : ""}" data-lineage-scope="deep">全部</button><button type="button" class="${tableScope === "terminal" ? "active" : ""}" data-lineage-scope="terminal">最终</button><button type="button" class="${tableScope === "path" ? "active" : ""}" data-lineage-scope="path">查路径</button></div></div>${tableScope === "path" ? '<p class="lineage-path-hint">不区分输入顺序，系统会按真实数据流方向查找。</p>' : `<label class="lineage-field lineage-direction-field"><span>展开方向</span><select class="select" name="direction"><option value="both" ${tableDirection === "both" ? "selected" : ""}>上下游</option><option value="up" ${tableDirection === "up" ? "selected" : ""}>向上展开</option><option value="down" ${tableDirection === "down" ? "selected" : ""}>向下展开</option></select></label>`}</div>`;
  }

  function renderTablePicker(kind: "source" | "target", label: string, value: string, placeholder: string): string {
    const options = kind === "source" ? sourceSuggestions : targetSuggestions;
    const open = activeTablePicker === kind && options.length > 0;
    const menu = open ? `<div class="lineage-table-menu" role="listbox" aria-label="${deps.escape(label)}候选表">${options.map((table) => `<button type="button" role="option" aria-selected="${table.id === value}" data-lineage-table-choice="${deps.escape(table.id)}" data-lineage-picker="${kind}"><i></i><span><strong>${deps.escape(table.id)}</strong><small>${deps.escape([table.type, table.ownerName, table.comment].filter(Boolean).join(" · ") || "已同步表")}</small></span></button>`).join("")}</div>` : "";
    const inputId = `lineage-${kind}-table`;
    return `<div class="lineage-field lineage-table-field"><label for="${inputId}">${deps.escape(label)}</label><span class="lineage-table-picker"><input class="input" id="${inputId}" name="${kind === "source" ? "table" : "target"}" value="${deps.escape(value)}" placeholder="${deps.escape(placeholder)}" data-lineage-table-search="${kind}" autocomplete="off" required aria-autocomplete="list" aria-expanded="${open}" />${menu}</span></div>`;
  }

  function renderDataSync(): string {
    const config = status?.config;
    if (!config) return `<section class="content"><div class="card card-padding-lg"><p class="helper">正在读取 MaxCompute 数据同步配置…</p></div></section>`;
    const featuredRun = status?.runs[0];
    const historyRuns = featuredRun ? status?.runs.filter((run) => run.id !== featuredRun.id) ?? [] : [];
    const credentialState = config.credentialConfigured
      ? `<span class="sync-pill success"><i></i>已保存 ${deps.escape(config.accessKeyIdMasked || "AccessKey")}</span>`
      : `<span class="sync-pill neutral"><i></i>尚未配置凭据</span>`;
    const discovered = config.discoveredProjects || [];
    const selected = new Set(config.collectionProjects?.length ? config.collectionProjects : discovered.map((project) => project.name));
    const projectChoices = discovered.length
      ? discovered.map((project) => `<label class="sync-project-option ${config.collectionMode === "all" ? "readonly" : ""}"><input type="checkbox" name="collectionProjects" value="${deps.escape(project.name)}" ${config.collectionMode === "all" || selected.has(project.name) ? "checked" : ""} ${config.collectionMode === "all" ? "disabled" : ""} /><span><strong>${deps.escape(project.name)}</strong><small>${deps.escape([project.region, project.status].filter(Boolean).join(" · ") || "可访问")}</small></span></label>`).join("")
      : '<p class="empty-inline">保存连接后点击“发现项目”，系统会读取当前 AK 可见的项目。</p>';
    const diagnostic = connectionDiagnostic ? `<details class="sync-diagnostic" open><summary>最近一次连接验证</summary><div><div class="diagnostic-summary"><span>${connectionDiagnostic.parsed.length} 个项目已解析</span><small>PyODPS / InstanceTunnel 运行信息，不包含 AccessKey</small></div><pre>${deps.escape(connectionDiagnostic.stderr || connectionDiagnostic.stdout || "PyODPS 查询成功。")}</pre><details><summary>查看解析后的 JSON</summary><pre>${deps.escape(JSON.stringify(connectionDiagnostic.parsed, null, 2))}</pre></details></div></details>` : "";
    const sourceDiagnosticPanel = sourceDiagnostic ? renderSourceDiagnostic(sourceDiagnostic) : "";
    const syncResult = featuredRun
      ? `<section class="sync-result ${featuredRun.status}" aria-label="同步进度"><div class="sync-result-heading"><div><h4>${featuredRun.status === "running" ? "本次同步进度" : featuredRun.status === "failed" ? "最近同步失败" : "最近同步结果"}</h4><small>数据日 ${deps.escape(featuredRun.dataDate)} · ${featuredRun.status === "running" ? `更新于 ${deps.fmt(featuredRun.progressUpdatedAt)}` : deps.fmt(featuredRun.completedAt || featuredRun.startedAt)}</small></div>${syncRunBadge(featuredRun)}</div>${renderSyncPipeline(featuredRun)}</section>`
      : `<section class="sync-result empty" aria-label="同步进度"><div><h4>同步进度</h4><small>首次同步启动后会显示各处理阶段。</small></div></section>`;
    return `<section class="content data-sync-page">
      <div class="sync-overview">
        <article class="card sync-summary-card"><span>连接状态</span><strong>${credentialState}</strong><small>${discovered.length ? `已发现 ${discovered.length} 个可访问项目` : (config.endpoint ? deps.escape(config.endpoint) : "请配置服务 Endpoint")}</small></article>
        <article class="card sync-summary-card"><span>自动调度</span><strong>${config.enabled ? `每天 ${deps.escape(config.scheduleTime)}` : "已关闭"}</strong><small>${config.nextRunAt ? `下次 ${deps.fmt(config.nextRunAt)}` : "保存后计算下次执行时间"}</small></article>
        <article class="card sync-summary-card"><span>最近同步</span><strong>${featuredRun ? (featuredRun.status === "success" ? "成功" : featuredRun.status === "failed" ? "失败" : "运行中") : "尚未执行"}</strong><small>${featuredRun ? `${featuredRun.projectsProcessed} 个项目 · ${featuredRun.tablesProcessed} 张表 · ${featuredRun.edgesProcessed} 条关系` : "可保存配置后手动触发"}</small></article>
      </div>
      <div class="sync-settings-grid">
        <form class="card card-padding-lg data-source-form" data-form="lineage-config">
          <div class="section-title"><div><h3>MaxCompute 数据源</h3><p class="helper">AccessKey 加密保存，仅通过进程管道临时传给官方 PyODPS SDK，不写入脚本、命令参数或日志。</p></div>${credentialState}</div>
          <div class="grid two"><div class="field"><label for="mc-project">执行项目</label><input class="input" id="mc-project" name="project" value="${deps.escape(config.project)}" placeholder="用于发起 Information Schema 查询" required /><small class="helper">只用于承载查询和计费，不限制采集范围。</small></div><div class="field"><label for="mc-endpoint">Endpoint</label><input class="input" id="mc-endpoint" name="endpoint" type="url" value="${deps.escape(config.endpoint || "")}" placeholder="https://service.cn-shanghai.maxcompute.aliyun.com/api" required /></div></div>
          <div class="grid two"><div class="field"><label for="mc-ak-id">AccessKey ID</label><input class="input" id="mc-ak-id" name="accessKeyId" autocomplete="off" placeholder="${deps.escape(config.accessKeyIdMasked || "留空则保留现有凭据")}" /></div><div class="field"><label for="mc-ak-secret">AccessKey Secret</label><input class="input" id="mc-ak-secret" name="accessKeySecret" type="password" autocomplete="new-password" placeholder="${config.credentialConfigured ? "留空则保留现有凭据" : "请输入 AccessKey Secret"}" /></div></div>
          <fieldset class="sync-project-scope"><legend>采集项目</legend><div class="sync-scope-options"><label><input type="radio" name="collectionMode" value="all" ${config.collectionMode === "all" ? "checked" : ""} />同一元数据中心内全部可见项目</label><label><input type="radio" name="collectionMode" value="selected" ${config.collectionMode === "selected" ? "checked" : ""} />仅采集勾选项目</label></div><div class="sync-project-list">${projectChoices}</div><p class="helper">租户级 Information Schema 会按当前 AK 权限返回项目；不同元数据中心需单独配置数据源。</p></fieldset>
          <div class="sync-schedule-row"><label class="toggle-row"><input type="checkbox" name="enabled" ${config.enabled ? "checked" : ""} />启用每日自动同步</label><div class="field"><label for="mc-schedule">每日执行时间（Asia/Shanghai）</label><input class="input" id="mc-schedule" type="time" name="scheduleTime" value="${deps.escape(config.scheduleTime)}" required /></div></div>
          <details class="advanced-settings"><summary>高级执行设置</summary><div class="grid two"><div class="field"><label for="mc-command">Python 3 命令</label><input class="input" id="mc-command" name="command" value="${deps.escape(config.command || "auto")}" placeholder="auto" required /><small class="helper">推荐保持 auto；Windows 会依次尝试 py -3、python，失败时可填写 python.exe 绝对路径。</small></div><div class="field"><label for="mc-args">Python 启动参数</label><input class="input" id="mc-args" name="args" value="${deps.escape(config.args || "")}" placeholder="通常留空" /><small class="helper">Windows 安装：py -3 -m pip install pyodps==0.13.0；其他系统使用 python3。</small></div></div></details>
          ${diagnostic}${sourceDiagnosticPanel}<div class="form-actions"><button class="button primary" type="submit">保存数据源与调度</button><button class="button" type="button" data-action="lineage-test-connection">发现项目并验证连接</button><button class="button" type="button" data-action="lineage-source-diagnostic">诊断血缘来源</button><button class="button" type="button" data-action="lineage-sync" ${status?.running ? "disabled" : ""}>${status?.running ? "正在同步" : "立即同步"}</button></div>
        </form>
        <aside class="card card-padding-lg sync-history"><div class="section-title"><h3>最近执行</h3><span class="meta">数据日期 T-1</span></div>${syncResult}<div class="sync-run-list">${historyRuns.map((run) => `<div class="sync-run-row"><span class="run-dot ${run.status}"></span><div><strong>${run.trigger === "manual" ? "手动同步" : "自动调度"}</strong><small>${deps.fmt(run.startedAt)} · ${run.projectsProcessed} 项目 · ${run.tablesProcessed} 表 · ${run.edgesProcessed} 关系</small></div><span>${run.status === "success" ? "成功" : run.status === "failed" ? "失败" : "运行中"}</span></div>`).join("") || '<p class="empty-inline">暂无更早执行记录</p>'}</div>${config.lastError ? `<div class="inline-alert error"><strong>最近同步失败</strong><span>${deps.escape(config.lastError)}</span></div>` : ""}<div class="security-note"><strong>凭据安全</strong><p>生产环境建议设置 <code>CREDENTIAL_ENCRYPTION_KEY</code> 并使用独立 RAM 用户、最小权限和定期轮换。页面与接口不会回传 Secret。</p></div></aside>
      </div>
    </section>`;
  }

  function renderSyncPipeline(run: LineageSyncRun): string {
    const stageKeys = ["scope", "metadata", "tasks", "lineage"] as const;
    const activeIndex = Math.max(0, stageKeys.indexOf(run.currentStage));
    const stateAt = (index: number): "complete" | "active" | "pending" | "failed" => {
      if (run.status === "success") return "complete";
      if (index < activeIndex) return "complete";
      if (index > activeIndex) return "pending";
      return run.status === "failed" ? "failed" : "active";
    };
    const stages = [
      { label: "项目范围", value: `${run.projectsProcessed} 个项目`, activeValue: run.projectsProcessed ? `${run.projectsProcessed} 个项目` : "正在确认", done: "已确认本次采集范围", active: "正在确认采集项目" },
      { label: "元数据同步", value: `${run.tablesProcessed} 张表`, activeValue: run.tablesProcessed ? `${run.tablesProcessed} 张表` : "正在同步", done: `已同步 ${run.columnsProcessed} 个字段及表信息`, active: "正在同步表、字段、分区与访问统计" },
      { label: "任务历史落库", value: `${run.tasksStaged} 个任务`, activeValue: run.tasksStaged ? `${run.tasksStaged} 个任务` : "正在落库", done: "已写入本次 T-1 任务历史", active: "正在读取任务历史并写入系统库" },
      { label: "血缘增量解析", value: `${run.edgesProcessed} 条关系`, activeValue: run.jobsProcessed ? `${run.jobsProcessed} 个任务已解析` : "正在解析", done: `已增量更新 ${run.edgesProcessed} 条实例关系`, active: "正在从任务历史增量解析血缘" },
    ];
    const progressNow = run.status === "success" ? 4 : activeIndex + 1;
    const bar = `<div class="sync-progress-bar" role="progressbar" aria-label="同步处理进度" aria-valuemin="1" aria-valuemax="4" aria-valuenow="${progressNow}">${stages.map((_, index) => `<span class="${stateAt(index)}"></span>`).join("")}</div>`;
    const items = stages.map((stage, index) => {
      const state = stateAt(index);
      const marker = state === "complete" ? "✓" : state === "failed" ? "!" : String(index + 1);
      const value = state === "pending" ? "等待执行" : state === "failed" ? "执行失败" : state === "active" ? stage.activeValue : stage.value;
      const description = state === "pending" ? "等待上一阶段完成" : state === "failed" ? "同步在此阶段中断，请查看错误信息" : state === "active" ? stage.active : stage.done;
      return `<li class="${state}" ${state === "active" ? 'aria-current="step"' : ""}><span class="sync-stage-index">${marker}</span><div><small>${stage.label}</small><strong>${value}</strong><p>${description}</p></div></li>`;
    }).join("");
    return `${bar}<ol class="sync-pipeline">${items}</ol>`;
  }

  function syncRunBadge(run: LineageSyncRun): string {
    if (run.status === "success") return '<span class="sync-pill success"><i></i>已完成</span>';
    if (run.status === "failed") return '<span class="sync-pill failed"><i></i>同步失败</span>';
    const stages = ["scope", "metadata", "tasks", "lineage"] as const;
    return `<span class="sync-pill running"><i></i>第 ${Math.max(0, stages.indexOf(run.currentStage)) + 1}/4 步</span>`;
  }

  function renderSourceDiagnostic(value: SourceDiagnostic): string {
    const groups = value.groups.map((group) => `<tr><td>${deps.escape(group.project)}</td><td>${deps.escape(group.taskType)}</td><td>${deps.escape(group.status)}</td><td>${group.jobs}</td><td>${group.withInputs}</td><td>${group.withOutputs}</td><td>${group.lineageReady}</td></tr>`).join("");
    const warnings = value.warnings.length ? `<ul class="source-diagnostic-warnings">${value.warnings.map((warning) => `<li>${deps.escape(warning)}</li>`).join("")}</ul>` : '<p class="source-diagnostic-ok">来源任务具备生成血缘的输入与输出信息。</p>';
    const recovery = value.recoveryRecommended ? '<div class="source-diagnostic-recovery"><p>系统库可能包含旧版解析结果。系统会重新解析已落库任务并同步最新 T-1 分区，既有不定期任务血缘不会因当天缺失而被清空。</p><button class="button" type="button" data-action="lineage-reprocess">重新解析已落库任务</button></div>' : "";
    return `<details class="source-diagnostic" open><summary>血缘来源诊断 · ${deps.escape(value.dataDate)}</summary><div class="source-diagnostic-body"><div class="source-diagnostic-metrics"><span><strong>${value.totalJobs}</strong>来源任务</span><span><strong>${value.storage.stagedJobs}</strong>已落任务表</span><span><strong>${value.storage.parsedJobs}</strong>解析成功</span><span><strong>${value.storage.invalidJobs}</strong>解析异常</span><span><strong>${value.storage.observations}</strong>实例关系</span><span><strong>${value.storage.totalEdges}</strong>聚合血缘</span></div>${warnings}${recovery}<div class="source-diagnostic-table-wrap"><table><thead><tr><th>项目</th><th>类型</th><th>状态</th><th>任务</th><th>有输入</th><th>有输出</th><th>可建血缘</th></tr></thead><tbody>${groups || '<tr><td colspan="7">未返回分组数据</td></tr>'}</tbody></table></div><details><summary>查看可提供给开发人员的诊断 JSON</summary><pre>${deps.escape(JSON.stringify(value, null, 2))}</pre></details></div></details>`;
  }

  function renderCanvas(): string {
    const nodeCount = mode === "column" ? columnGraph?.nodes.length : graph?.tables.length;
    const edgeCount = mode === "column" ? columnGraph?.edges.length : graph?.edges.length;
    const modeTools = mode === "column" ? `<div class="canvas-mode-switch" role="group" aria-label="画布工具"><button type="button" class="${canvasMode === "select" ? "active" : ""}" data-lineage-canvas-mode="select">选择</button><button type="button" class="${canvasMode === "pan" ? "active" : ""}" data-lineage-canvas-mode="pan">拖动</button></div><span class="lineage-expand-hint">← 上游 · 下游 →</span>` : "";
    const toolbar = `<div class="lineage-canvas-toolbar"><span>${nodeCount !== undefined ? `${nodeCount} 个节点 · ${edgeCount} 条关系` : "关系画布"}</span><div>${modeTools}<button class="icon-button compact" type="button" title="缩小" aria-label="缩小血缘图" data-action="lineage-zoom-out">−</button><button class="icon-button compact" type="button" title="适应画布" aria-label="适应画布" data-action="lineage-fit">⌗</button><button class="icon-button compact" type="button" title="放大" aria-label="放大血缘图" data-action="lineage-zoom-in">＋</button><button class="icon-button compact" type="button" title="${maximized ? "退出大画布" : "放大画布"}" aria-label="${maximized ? "退出大画布" : "放大画布"}" data-action="lineage-maximize">${maximized ? "↙" : "↗"}</button><button class="button compact" type="button" data-action="lineage-download">导出 SVG</button></div></div>`;
    if (graphLoading) return `${toolbar}<div class="lineage-skeleton"><span></span><span></span><span></span><p>${mode === "column" ? "正在从 DataWorks 加载首层字段关系…" : "正在读取系统库中的血缘关系…"}</p></div>`;
    if (mode === "column" && columnGraph) return `${toolbar}${renderColumnGraph(columnGraph)}`;
    if (graph) return `${toolbar}${graphSvg(graph, canvasView, deps.escape, loadedTableDirections, tableExpansions, expandingDirections)}`;
    return `${toolbar}<div class="lineage-empty"><svg viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="24"/><path d="M24 48H10m76 0H72M48 24V10m0 76V72"/><circle cx="10" cy="48" r="5"/><circle cx="86" cy="48" r="5"/><circle cx="48" cy="10" r="5"/><circle cx="48" cy="86" r="5"/></svg><h2>从一张表开始探索</h2><p>${mode === "column" ? "先从 DataWorks 加载首层字段关系，点击边界节点的 ＋ 逐层探索，再框选字段让 Harness 总结加工逻辑。" : "搜索表名后查看上下游关系，可切换一层、全部、最终血缘或查询两表路径。"}</p></div>`;
  }

  function renderColumnGraph(value: DataWorksColumnGraph): string {
    if (!value.nodes.length) return `<div class="lineage-empty"><h2>DataWorks 没有返回该字段</h2><p>请确认表名、字段名、项目权限和 DataWorks 元数据血缘是否可用。</p></div>`;
    const layout = columnGraphLayout(value);
    const view = canvasView ?? { x: 0, y: 0, width: layout.width, height: layout.height };
    const paths = value.edges.map((edge) => {
      const from = layout.positions.get(edge.sourceId); const to = layout.positions.get(edge.targetId);
      if (!from || !to) return "";
      const active = selectedColumns.has(edge.sourceId) && selectedColumns.has(edge.targetId);
      return `<path class="lineage-edge ${active ? "selected" : ""}" d="M${from.x + 210} ${from.y + 33} C${from.x + 260} ${from.y + 33},${to.x - 50} ${to.y + 33},${to.x} ${to.y + 33}" marker-end="url(#lineage-arrow)"/>`;
    }).join("");
    const nodes = value.nodes.map((node) => {
      const pos = layout.positions.get(node.id); if (!pos) return "";
      const selected = selectedColumns.has(node.id);
      const separator = node.table.lastIndexOf(".");
      const project = separator > 0 ? node.table.slice(0, separator) : "";
      const table = separator > 0 ? node.table.slice(separator + 1) : node.table;
      const meta = project ? `${project} · ${node.column}` : node.column;
      const controls = node.boundary ? directionalControls("column", node.id, `${table}.${node.column}`, pos, loadedColumnDirections, columnExpansions, expandingDirections, deps.escape) : "";
      return `<g class="lineage-svg-node column-node ${node.root ? "root" : ""} ${selected ? "selected" : ""}" transform="translate(${pos.x} ${pos.y})" tabindex="0" role="button" data-lineage-field-node="${deps.escape(node.id)}"><rect width="210" height="66" rx="8"/><text class="node-name" x="14" y="26">${deps.escape(shortSvgName(table, 26))}</text><text class="node-meta" x="14" y="48">${deps.escape(shortSvgName(meta, 29))}</text><title>${deps.escape(`${node.table}.${node.column}`)}</title></g>${controls}`;
    }).join("");
    const action = selectedColumns.size ? `<div class="lineage-selection-action"><div><strong>${selectedColumns.size} 个字段已选</strong><span>最多 20 个，Harness 仅在点击后运行</span></div>${analysisLoading ? '<button class="button" type="button" data-action="lineage-cancel-analysis">取消分析</button>' : '<button class="button primary" type="button" data-action="lineage-analyze-selection">分析字段逻辑</button>'}</div>` : "";
    return `<div class="lineage-svg-wrap ${canvasMode === "pan" ? "pan-mode" : "select-mode"}" data-lineage-canvas><svg class="lineage-graph" id="lineage-graph-svg" data-lineage-layout-width="${layout.width}" data-lineage-layout-height="${layout.height}" viewBox="${view.x} ${view.y} ${view.width} ${view.height}" role="img" aria-label="字段血缘图"><defs><marker id="lineage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker></defs>${paths}${nodes}</svg><div class="lineage-selection-box" data-lineage-selection-box hidden></div>${action}<div class="lineage-canvas-help"><strong>画布操作</strong><span>←＋ 仅展开上游 · ＋→ 仅展开下游 · 对应减号单独收回</span><span>左键拖框 · Space + 拖动 / 中键平移 · 滚轮连续缩放 · Esc 清空</span></div>${value.truncated ? '<div class="graph-notice">当前节点返回数量已达到上限，可从边界节点继续展开。</div>' : ""}</div>`;
  }

  function renderInspector(): string {
    if (mode === "column") {
      if (analysisLoading) return renderAnalysisProgress();
      if (!selectionAnalysis) return "";
      const relationCount = selectionAnalysis.groups.reduce((total, group) => total + group.relations.length, 0);
      const snippets = selectionAnalysis.snippets.length ? `<section class="inspector-section"><div class="section-title"><h3>加工代码片段</h3><span>${selectionAnalysis.snippets.length} 段</span></div><div class="analysis-code-snippets">${selectionAnalysis.snippets.map((snippet) => `<article><header><strong>${deps.escape(snippet.explanation || "加工逻辑证据")}</strong><span>${deps.escape(snippet.language || "text")}</span></header><pre><code>${deps.escape(snippet.snippet)}</code></pre></article>`).join("")}</div></section>` : "";
      return `<aside class="lineage-inspector"><div class="inspector-header"><div><span class="inspector-kicker">Harness 字段加工分析</span><h2>${selectionAnalysis.groups.length} 组链路</h2><p>${relationCount} 条加工关系 · ${selectionAnalysis.snippets.length} 段代码证据</p></div><button class="icon-button" type="button" aria-label="关闭分析" data-action="lineage-close-detail">×</button></div><div class="inspector-scroll"><section class="inspector-section"><h3>分析总结</h3><p class="lineage-summary">${deps.escape(selectionAnalysis.summary || "已完成所选字段的加工逻辑分析。")}</p></section>${selectionAnalysis.groups.map((group) => `<section class="inspector-section analysis-group"><div class="section-title"><h3>${deps.escape(group.title)}</h3><span>${group.relations.length} 条</span></div>${group.fields.length ? `<div class="analysis-fields">${group.fields.map((field) => `<span>${deps.escape(field)}</span>`).join("")}</div>` : ""}<div class="column-relations">${group.relations.map(renderRelationCard).join("") || '<p class="empty-inline">没有可确认的加工关系</p>'}</div></section>`).join("")}${snippets}${selectionAnalysis.warnings.length ? `<section class="inspector-section"><h3>注意事项</h3><ul class="warning-list">${selectionAnalysis.warnings.map((warning) => `<li>${deps.escape(warning)}</li>`).join("")}</ul></section>` : ""}</div></aside>`;
    }
    if (!detail) return "";
    const table = detail.table;
    return `<aside class="lineage-inspector"><div class="inspector-header"><div><span class="inspector-kicker">${deps.escape(table.type)}</span><h2>${deps.escape(table.name)}</h2><p>${deps.escape(table.project)}</p></div><button class="icon-button" type="button" aria-label="关闭详情" data-action="lineage-close-detail">×</button></div><div class="inspector-scroll"><section class="inspector-section"><p class="lineage-summary">${deps.escape(table.comment || "暂无表说明")}</p><div class="lineage-relation-count"><span><strong>${detail.relations.upstream}</strong>上游</span><span><strong>${detail.relations.downstream}</strong>下游</span></div></section>${metadataGrid(table)}<section class="inspector-section"><div class="section-title"><h3>字段</h3><span>${detail.columns.length} 个</span></div><div class="lineage-column-list">${detail.columns.map((column) => `<button type="button" data-lineage-column="${deps.escape(column.name)}"><span><strong>${deps.escape(column.name)}</strong><small>${deps.escape(column.comment || (column.partitionKey ? "分区字段" : ""))}</small></span><code>${deps.escape(column.dataType)}</code></button>`).join("") || '<p class="empty-inline">暂未同步字段元数据</p>'}</div></section></div></aside>`;
  }

  function renderAnalysisProgress(): string {
    const thresholds = [0, 2, 7, 15];
    const activeIndex = analysisElapsedSeconds >= thresholds[3]! ? 3 : analysisElapsedSeconds >= thresholds[2]! ? 2 : analysisElapsedSeconds >= thresholds[1]! ? 1 : 0;
    const steps = [
      ["提交分析请求", `${selectedColumns.size} 个字段已进入分析队列`],
      ["只读检索工作区", "搜索相关 SQL、脚本和调度配置"],
      ["核对字段与代码证据", "校验源字段、目标字段和加工表达式"],
      ["整理加工说明", "生成链路总结和可展示的代码片段"],
    ];
    return `<aside class="lineage-inspector analysis-running" aria-live="polite"><div class="inspector-header"><div><span class="inspector-kicker">Harness 分析中</span><h2>字段加工逻辑</h2><p>已运行 ${analysisElapsedSeconds} 秒</p></div><button class="icon-button" type="button" aria-label="取消分析" data-action="lineage-cancel-analysis">×</button></div><div class="inspector-scroll"><section class="inspector-section"><div class="analysis-live-status"><span class="analysis-orbit" aria-hidden="true"><i></i></span><div><strong>${steps[activeIndex]![0]}</strong><p>${steps[activeIndex]![1]}</p></div></div><ol class="analysis-progress-list">${steps.map((step, index) => `<li class="${index < activeIndex ? "complete" : index === activeIndex ? "active" : "pending"}"><i>${index < activeIndex ? "✓" : index + 1}</i><div><strong>${step[0]}</strong><span>${step[1]}</span></div></li>`).join("")}</ol><p class="analysis-progress-note">这里展示可审计的执行阶段与最终依据，不展示模型内部推理文本。</p></section></div></aside>`;
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

  function renderRelationCard(relation: ColumnLineageResult["relations"][number]): string {
    return `<div><div class="relation-path"><code>${deps.escape(relation.sourceTable)}.${deps.escape(relation.sourceColumn)}</code><span>→</span><code>${deps.escape(relation.targetTable)}.${deps.escape(relation.targetColumn)}</code></div><p>${deps.escape(relation.transformation)}</p><span class="confidence ${relation.confidence}">${relation.confidence === "high" ? "高置信" : relation.confidence === "medium" ? "中置信" : "低置信"}</span></div>`;
  }

  async function submitQuery(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form);
    const rawTable = String(data.get("table") || "").trim();
    const project = status?.config?.project || "";
    const table = rawTable.includes(".") || !project ? rawTable : `${project}.${rawTable}`;
    queryText = table;
    if (mode === "column") {
      const rawColumn = String(data.get("column") || "").trim();
      columnText = detail?.columns.find((item) => item.name.toLocaleLowerCase() === rawColumn.toLocaleLowerCase())?.name ?? rawColumn;
      analysisTeamId = String(data.get("teamId") || "");
      graphLoading = true; columnGraph = null; selectionAnalysis = null; selectedColumns.clear(); graph = null; canvasView = null; deps.scheduleRender();
      try {
        const response = await api<{ graph: DataWorksColumnGraph }>("/api/lineage/columns/graph", { method: "POST", body: JSON.stringify({ table, column: columnText, depth: 1, direction: "both" }) });
        baseColumnGraph = response.graph; columnGraph = response.graph;
        columnExpansions.clear();
        loadedColumnDirections.clear();
        if (columnGraph.rootId) directionsOf(columnGraph.direction).forEach((direction) => loadedColumnDirections.add(expansionKey(columnGraph!.rootId, direction)));
        await loadDetail(table, false);
      } finally { graphLoading = false; deps.scheduleRender(); }
      return;
    }
    graphLoading = true; deps.scheduleRender();
    try {
      const scope = tableScope;
      tableDirection = String(data.get("direction") || "both") as typeof tableDirection;
      const direction = tableDirection;
      targetText = String(data.get("target") || "").trim();
      if (scope === "path" && !targetText) throw new Error("路径查询需要选择目标表。");
      const params = new URLSearchParams({ table, scope, direction, depth: "6", limit: "160" });
      if (targetText) params.set("target", targetText.includes(".") || !project ? targetText : `${project}.${targetText}`);
      graph = await api<LineageGraph>(`/api/lineage/graph?${params}`);
      baseTableGraph = graph; tableExpansions.clear();
      loadedTableDirections.clear();
      if (scope === "first" && graph.rootId) directionsOf(tableDirection).forEach((item) => loadedTableDirections.add(expansionKey(graph!.rootId, item)));
      canvasView = null;
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
    if (!window.confirm("将重新解析系统库中已落地的任务历史，并同步最新 T-1 分区。既有历史血缘不会按天全量清空。是否继续？")) return;
    const response = await api<{ requeued: number }>("/api/lineage/reprocess", { method: "POST", body: "{}" });
    deps.toast(`已重新排队 ${response.requeued} 个任务并启动增量同步`, "success");
    sourceDiagnostic = null;
    await load();
    pollStatus();
  }

  function search(value: string, picker: "source" | "target" = "source"): void {
    if (picker === "source") queryText = value;
    else targetText = value;
    activeTablePicker = picker;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      if (value.trim().length < 2) {
        if (picker === "source") sourceSuggestions = []; else targetSuggestions = [];
        deps.scheduleRender(); return;
      }
      void api<{ tables: LineageTable[] }>(`/api/lineage/tables?q=${encodeURIComponent(value.trim())}&limit=30`).then((response) => {
        if (picker === "source") sourceSuggestions = response.tables; else targetSuggestions = response.tables;
        activeTablePicker = picker; deps.scheduleRender();
      }).catch(() => undefined);
    }, 220);
  }

  function chooseTable(picker: "source" | "target", id: string): void {
    if (picker === "source") queryText = id; else targetText = id;
    const input = document.querySelector<HTMLInputElement>(`[data-lineage-table-search="${picker}"]`);
    if (input) input.value = id;
    activeTablePicker = null;
    deps.scheduleRender();
  }

  function swapPath(): void {
    [queryText, targetText] = [targetText, queryText];
    [sourceSuggestions, targetSuggestions] = [targetSuggestions, sourceSuggestions];
    const sourceInput = document.querySelector<HTMLInputElement>('[data-lineage-table-search="source"]');
    const targetInput = document.querySelector<HTMLInputElement>('[data-lineage-table-search="target"]');
    if (sourceInput) sourceInput.value = queryText;
    if (targetInput) targetInput.value = targetText;
    activeTablePicker = null;
    deps.scheduleRender();
  }

  async function expandColumn(entityId: string, direction: ExpansionDirection): Promise<void> {
    const key = expansionKey(entityId, direction);
    if (!columnGraph || expandingDirections.has(key) || loadedColumnDirections.has(key)) return;
    const node = columnGraph.nodes.find((item) => item.id === entityId);
    if (!node) return;
    expandingDirections.add(key); deps.scheduleRender();
    try {
      const response = await api<{ graph: DataWorksColumnGraph }>("/api/lineage/columns/graph", {
        method: "POST",
        body: JSON.stringify({ table: node.table, column: node.column, entityId, depth: 1, direction }),
      });
      const previousView = displayedCanvasView();
      const previousPosition = columnGraphLayout(columnGraph).positions.get(entityId);
      columnExpansions.set(key, { nodeId: entityId, direction, graph: response.graph });
      loadedColumnDirections.add(key);
      columnGraph = baseColumnGraph ? composeColumnGraph(baseColumnGraph, columnExpansions) : mergeColumnGraphs(columnGraph, response.graph, entityId, direction);
      canvasView = preserveAnchor(previousView, previousPosition, columnGraphLayout(columnGraph).positions.get(entityId));
    } finally {
      expandingDirections.delete(key); deps.scheduleRender();
    }
  }

  function collapseColumn(entityId: string, direction: ExpansionDirection): void {
    const key = expansionKey(entityId, direction);
    if (!baseColumnGraph || !columnExpansions.delete(key)) return;
    const previousView = displayedCanvasView();
    const previousPosition = columnGraph ? columnGraphLayout(columnGraph).positions.get(entityId) : undefined;
    loadedColumnDirections.delete(key);
    columnGraph = composeColumnGraph(baseColumnGraph, columnExpansions);
    pruneColumnExpansions(columnGraph, columnExpansions, loadedColumnDirections);
    columnGraph = composeColumnGraph(baseColumnGraph, columnExpansions);
    selectedColumns.forEach((id) => { if (!columnGraph?.nodes.some((node) => node.id === id)) selectedColumns.delete(id); });
    canvasView = preserveAnchor(previousView, previousPosition, columnGraphLayout(columnGraph).positions.get(entityId));
    deps.scheduleRender();
  }

  async function expandTable(tableId: string, direction: ExpansionDirection): Promise<void> {
    const key = expansionKey(tableId, direction);
    if (!graph || expandingDirections.has(key) || loadedTableDirections.has(key)) return;
    expandingDirections.add(key); deps.scheduleRender();
    try {
      const params = new URLSearchParams({ table: tableId, scope: "first", direction, depth: "1", limit: "160" });
      const patch = await api<LineageGraph>(`/api/lineage/graph?${params}`);
      const previousView = displayedCanvasView();
      const previousPosition = graphLayout(graph).positions.get(tableId);
      tableExpansions.set(key, { nodeId: tableId, direction, graph: patch });
      loadedTableDirections.add(key);
      graph = baseTableGraph ? composeTableGraph(baseTableGraph, tableExpansions) : mergeTableGraphs(graph, patch);
      canvasView = preserveAnchor(previousView, previousPosition, graphLayout(graph).positions.get(tableId));
    } finally {
      expandingDirections.delete(key); deps.scheduleRender();
    }
  }

  function collapseTable(tableId: string, direction: ExpansionDirection): void {
    const key = expansionKey(tableId, direction);
    if (!baseTableGraph || !tableExpansions.delete(key)) return;
    const previousView = displayedCanvasView();
    const previousPosition = graph ? graphLayout(graph).positions.get(tableId) : undefined;
    loadedTableDirections.delete(key);
    graph = composeTableGraph(baseTableGraph, tableExpansions);
    pruneTableExpansions(graph, tableExpansions, loadedTableDirections);
    graph = composeTableGraph(baseTableGraph, tableExpansions);
    canvasView = preserveAnchor(previousView, previousPosition, graphLayout(graph).positions.get(tableId));
    deps.scheduleRender();
  }

  async function selectNode(id: string): Promise<void> { await loadDetail(id, true); }

  async function loadDetail(id: string, rerender: boolean): Promise<void> {
    try { detail = await api<LineageDetail>(`/api/lineage/tables/${encodeURIComponent(id)}`); }
    catch { detail = null; }
    if (mode === "column" && detail && columnText) {
      const exactName = detail.columns.find((item) => item.name.toLocaleLowerCase() === columnText.toLocaleLowerCase());
      const commentMatches = detail.columns.filter((item) => item.comment && item.comment === columnText);
      if (exactName) columnText = exactName.name;
      else if (commentMatches.length === 1) columnText = commentMatches[0]!.name;
    }
    if (rerender) deps.scheduleRender();
  }

  function setMode(value: "table" | "column"): void {
    stopAnalysisTimer(); mode = value; graph = null; baseTableGraph = null; columnGraph = null; baseColumnGraph = null; selectionAnalysis = null; selectedColumns.clear(); loadedColumnDirections.clear(); loadedTableDirections.clear(); expandingDirections.clear(); columnExpansions.clear(); tableExpansions.clear(); canvasView = null; deps.scheduleRender();
  }
  function setScope(value: "first" | "deep" | "terminal" | "path"): void { tableScope = value; deps.scheduleRender(); }
  function setCanvasMode(value: "select" | "pan"): void { canvasMode = value; deps.scheduleRender(); }
  function setCollectionMode(value: "all" | "selected"): void {
    document.querySelectorAll<HTMLInputElement>('[name="collectionProjects"]').forEach((input) => {
      input.disabled = value === "all";
      if (value === "all") input.checked = true;
      input.closest(".sync-project-option")?.classList.toggle("readonly", value === "all");
    });
  }
  function closeDetail(): void {
    if (mode === "column") { if (analysisLoading) cancelAnalysis(); selectionAnalysis = null; }
    else detail = null;
    deps.scheduleRender();
  }
  function chooseColumn(column: string): void { mode = "column"; columnText = column; deps.scheduleRender(); window.setTimeout(() => { document.querySelector<HTMLInputElement>('[name="column"]')?.focus(); }, 0); }
  function displayedCanvasView(): { x: number; y: number; width: number; height: number } | null {
    const svg = document.querySelector<SVGSVGElement>("#lineage-graph-svg");
    return svg ? readSvgView(svg) : canvasView;
  }
  function zoomBy(delta: number): void {
    const svg = document.querySelector<SVGSVGElement>("#lineage-graph-svg");
    if (!svg) return;
    const view = readSvgView(svg);
    const factor = delta > 0 ? 0.84 : 1.19;
    const { minimumWidth, maximumWidth } = zoomBounds(svg);
    const width = Math.max(minimumWidth, Math.min(maximumWidth, view.width * factor));
    const height = view.height * (width / view.width);
    canvasView = { x: view.x + (view.width - width) / 2, y: view.y + (view.height - height) / 2, width, height };
    deps.scheduleRender();
  }
  function fit(): void { canvasView = null; deps.scheduleRender(); }
  function toggleMaximize(): void { maximized = !maximized; deps.scheduleRender(); }

  async function analyzeSelection(): Promise<void> {
    if (!columnGraph || !selectedColumns.size) return;
    const nodes = columnGraph.nodes.filter((node) => selectedColumns.has(node.id)).slice(0, 20).map(({ id, table, column }) => ({ id, table, column }));
    const connected = connectedRelations(columnGraph, new Set(nodes.map((node) => node.id))).slice(0, 200);
    analysisController?.abort();
    analysisController = new AbortController();
    analysisLoading = true; selectionAnalysis = null; startAnalysisTimer(); deps.scheduleRender();
    try {
      const response = await api<{ result: ColumnSelectionAnalysisResult }>("/api/lineage/columns/analyze-selection", {
        method: "POST", signal: analysisController.signal,
        body: JSON.stringify({ teamId: analysisTeamId || deps.state().selectedTeamId, nodes, relations: connected }),
      });
      selectionAnalysis = response.result;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
    } finally {
      analysisLoading = false; analysisController = null; stopAnalysisTimer(); deps.scheduleRender();
    }
  }

  function startAnalysisTimer(): void {
    stopAnalysisTimer(); analysisElapsedSeconds = 0;
    analysisTimer = window.setInterval(() => { analysisElapsedSeconds += 1; deps.scheduleRender(); }, 1_000);
  }
  function stopAnalysisTimer(): void { if (analysisTimer !== undefined) window.clearInterval(analysisTimer); analysisTimer = undefined; }
  function cancelAnalysis(): void { analysisController?.abort(); analysisLoading = false; stopAnalysisTimer(); deps.scheduleRender(); }

  function pointerDown(event: PointerEvent): void {
    const origin = event.target instanceof Element ? event.target : null;
    const canvas = origin?.closest<HTMLElement>("[data-lineage-canvas]");
    if (!canvas || origin?.closest("button, [data-lineage-expand-column], [data-lineage-collapse-column], [data-lineage-expand-table], [data-lineage-collapse-table]") || (event.button !== 0 && event.button !== 1)) return;
    const svg = canvas.querySelector<SVGSVGElement>("#lineage-graph-svg");
    if (!svg) return;
    const node = origin?.closest<SVGElement>("[data-lineage-field-node]");
    const pan = event.button === 1 || spacePressed || canvasMode === "pan";
    if (!pan && origin?.closest("[data-lineage-node]")) return;
    drag = { kind: pan ? "pan" : node ? "node" : "box", startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, nodeId: node?.dataset.lineageFieldNode, additive: event.ctrlKey || event.metaKey, view: readSvgView(svg) };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function pointerMove(event: PointerEvent): void {
    if (!drag) return;
    const canvas = document.querySelector<HTMLElement>("[data-lineage-canvas]");
    const svg = canvas?.querySelector<SVGSVGElement>("#lineage-graph-svg");
    if (!canvas || !svg) return;
    drag.lastX = event.clientX; drag.lastY = event.clientY;
    if (drag.kind === "pan" && drag.view) {
      const dx = (event.clientX - drag.startX) * drag.view.width / Math.max(1, svg.clientWidth);
      const dy = (event.clientY - drag.startY) * drag.view.height / Math.max(1, svg.clientHeight);
      svg.setAttribute("viewBox", `${drag.view.x - dx} ${drag.view.y - dy} ${drag.view.width} ${drag.view.height}`);
    } else if (drag.kind === "box") {
      const rect = canvas.getBoundingClientRect();
      const box = canvas.querySelector<HTMLElement>("[data-lineage-selection-box]");
      if (!box) return;
      const left = Math.max(0, Math.min(drag.startX, event.clientX) - rect.left);
      const top = Math.max(0, Math.min(drag.startY, event.clientY) - rect.top);
      box.hidden = false; box.style.left = `${left}px`; box.style.top = `${top}px`;
      box.style.width = `${Math.abs(event.clientX - drag.startX)}px`; box.style.height = `${Math.abs(event.clientY - drag.startY)}px`;
    }
  }

  function pointerUp(): void {
    if (!drag) return;
    const current = drag; drag = null;
    const canvas = document.querySelector<HTMLElement>("[data-lineage-canvas]");
    const svg = canvas?.querySelector<SVGSVGElement>("#lineage-graph-svg");
    if (!canvas || !svg) return;
    const moved = Math.hypot(current.lastX - current.startX, current.lastY - current.startY);
    if (current.kind === "pan") canvasView = readSvgView(svg);
    if (current.kind === "node" && current.nodeId && moved < 6) {
      if (!current.additive) selectedColumns.clear();
      if (current.additive && selectedColumns.has(current.nodeId)) selectedColumns.delete(current.nodeId);
      else if (selectedColumns.size < 20) selectedColumns.add(current.nodeId);
      else deps.toast("一次最多选择 20 个字段", "info");
    }
    if (current.kind === "box" && moved >= 4) {
      if (!current.additive) selectedColumns.clear();
      const selection = { left: Math.min(current.startX, current.lastX), right: Math.max(current.startX, current.lastX), top: Math.min(current.startY, current.lastY), bottom: Math.max(current.startY, current.lastY) };
      for (const node of canvas.querySelectorAll<SVGElement>("[data-lineage-field-node]")) {
        const rect = node.getBoundingClientRect();
        if (rect.right < selection.left || rect.left > selection.right || rect.bottom < selection.top || rect.top > selection.bottom) continue;
        if (selectedColumns.size >= 20) break;
        if (node.dataset.lineageFieldNode) selectedColumns.add(node.dataset.lineageFieldNode);
      }
    }
    canvas.querySelector<HTMLElement>("[data-lineage-selection-box]")?.setAttribute("hidden", "");
    deps.scheduleRender();
  }

  function wheel(event: WheelEvent): void {
    const origin = event.target instanceof Element ? event.target : null;
    const canvas = origin?.closest<HTMLElement>("[data-lineage-canvas]");
    const svg = canvas?.querySelector<SVGSVGElement>("#lineage-graph-svg");
    if (!canvas || !svg) return;
    event.preventDefault();
    const rect = svg.getBoundingClientRect(); const view = readSvgView(svg);
    const factor = event.deltaY > 0 ? 1.12 : 0.89;
    const { minimumWidth, maximumWidth } = zoomBounds(svg);
    const width = Math.max(minimumWidth, Math.min(maximumWidth, view.width * factor));
    const height = view.height * (width / view.width);
    const ratioX = (event.clientX - rect.left) / Math.max(1, rect.width);
    const ratioY = (event.clientY - rect.top) / Math.max(1, rect.height);
    const x = view.x + view.width * ratioX - width * ratioX;
    const y = view.y + view.height * ratioY - height * ratioY;
    canvasView = { x, y, width, height }; svg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
  }

  function keyDown(event: KeyboardEvent): void {
    if (event.key === " " && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement)) spacePressed = true;
    if (event.key === "Escape" && selectedColumns.size) { selectedColumns.clear(); deps.scheduleRender(); }
  }
  function keyUp(event: KeyboardEvent): void { if (event.key === " ") spacePressed = false; }

  function downloadGraph(): void {
    const svg = document.querySelector<SVGSVGElement>("#lineage-graph-svg");
    if (!svg) { deps.toast("当前没有可导出的血缘图", "info"); return; }
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.querySelectorAll(".node-expand").forEach((control) => control.remove());
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = `.lineage-edge{fill:none;stroke:#91a3bd;stroke-width:1.5}.lineage-svg-node rect{fill:#fff;stroke:#b9c8dc;stroke-width:1.25}.lineage-svg-node.root rect{fill:#eef5ff;stroke:#1677ff;stroke-width:2}.node-name{font:600 14px system-ui;fill:#172033}.node-meta{font:12px system-ui;fill:#68778d}.edge-label{font:11px system-ui;fill:#68778d;text-anchor:middle}marker path{fill:#91a3bd}`;
    copy.prepend(style);
    const blob = new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml;charset=utf-8" });
    const rootLabel = graph?.rootId || columnGraph?.nodes.find((node) => node.root)?.table || "graph";
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `lineage-${rootLabel.replaceAll(".", "-")}.svg`; link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  }

  function pollStatus(): void {
    let attempts = 0;
    const tick = () => { void api<LineageStatus>("/api/lineage/status").then((next) => { status = next; deps.scheduleRender(); attempts += 1; if (next.running && attempts < 240) window.setTimeout(tick, 1_500); }).catch(() => undefined); };
    window.setTimeout(tick, 1_000);
  }

  function dateText(value?: number | null): string { return value ? deps.fmt(value) : "暂无"; }

  document.addEventListener("pointerdown", pointerDown);
  document.addEventListener("pointermove", pointerMove);
  document.addEventListener("pointerup", pointerUp);
  document.addEventListener("wheel", wheel, { passive: false });
  document.addEventListener("keydown", keyDown);
  document.addEventListener("keyup", keyUp);

  return { render, renderDataSync, load, submitQuery, saveConfig, testConnection, triggerSync, diagnoseSource, reprocess, search, chooseTable, swapPath, expandColumn, collapseColumn, expandTable, collapseTable, selectNode, setMode, setScope, setCanvasMode, setCollectionMode, closeDetail, chooseColumn, zoomBy, fit, toggleMaximize, analyzeSelection, cancelAnalysis, downloadGraph };
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

function graphSvg(
  graph: LineageGraph,
  selectedView: { x: number; y: number; width: number; height: number } | null,
  escape: (value: HtmlValue) => string,
  loadedDirections: Set<string>,
  expansions: Map<string, DirectionalExpansion<LineageGraph>>,
  expandingDirections: Set<string>,
): string {
  const layout = graphLayout(graph);
  const view = selectedView ?? { x: 0, y: 0, width: layout.width, height: layout.height };
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
    const controls = graph.scope === "first" ? directionalControls("table", table.id, table.name, pos, loadedDirections, expansions, expandingDirections, escape) : "";
    return `<g class="lineage-svg-node ${tone} ${root ? "root" : ""}" transform="translate(${pos.x} ${pos.y})" tabindex="0" role="button" data-lineage-node="${escape(table.id)}"><rect width="210" height="70" rx="8"/><rect class="node-icon-bg" x="12" y="18" width="32" height="32" rx="6"/><text class="node-icon" x="28" y="39">${tone === "view" ? "V" : "T"}</text><text class="node-name" x="54" y="29">${escape(shortSvgName(table.name, 17))}</text><text class="node-meta" x="54" y="50">${escape(shortSvgName(table.project, 17))}</text><title>${escape(table.id)}${table.comment ? ` · ${escape(table.comment)}` : ""}</title></g>${controls}`;
  }).join("");
  const pathNotice = graph.scope === "path"
    ? graph.pathFound === false
      ? '<div class="graph-notice error">两张表之间未找到可达路径。</div>'
      : graph.pathReversed
        ? '<div class="graph-notice info">已识别反向输入，并按真实数据流方向展示。</div>'
        : ""
    : graph.truncated ? '<div class="graph-notice">节点数量较多，当前结果已截断。可从边界节点继续展开。</div>' : "";
  return `<div class="lineage-svg-wrap" data-lineage-canvas><svg class="lineage-graph" id="lineage-graph-svg" data-lineage-layout-width="${layout.width}" data-lineage-layout-height="${layout.height}" viewBox="${view.x} ${view.y} ${view.width} ${view.height}" role="img" aria-label="${escape(graph.rootId)} 的表血缘图"><defs><marker id="lineage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker></defs>${paths}${nodes}</svg><div class="lineage-canvas-help compact-help"><strong>画布操作</strong><span>←＋ 仅上游 · ＋→ 仅下游 · 对应减号单独收回 · 滚轮连续缩放</span></div>${pathNotice}</div>`;
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

function columnGraphLayout(graph: DataWorksColumnGraph): { positions: Map<string, { x: number; y: number }>; width: number; height: number } {
  const levels = new Map<string, number>([[graph.rootId, 0]]);
  for (let pass = 0; pass < graph.nodes.length + 2; pass += 1) {
    for (const edge of graph.edges) {
      const source = levels.get(edge.sourceId); const target = levels.get(edge.targetId);
      if (source !== undefined && target === undefined) levels.set(edge.targetId, source + 1);
      else if (target !== undefined && source === undefined) levels.set(edge.sourceId, target - 1);
    }
  }
  graph.nodes.forEach((node) => { if (!levels.has(node.id)) levels.set(node.id, node.depth); });
  const values = [...levels.values()];
  const minLevel = Math.min(...values, 0); const maxLevel = Math.max(...values, 0);
  const groups = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const level = levels.get(node.id) ?? 0; const group = groups.get(level) ?? []; group.push(node.id); groups.set(level, group);
  }
  groups.forEach((ids) => ids.sort((left, right) => left.localeCompare(right)));
  const maxRows = Math.max(1, ...[...groups.values()].map((ids) => ids.length));
  const width = Math.max(760, (maxLevel - minLevel + 1) * 285 + 90);
  const height = Math.max(440, maxRows * 92 + 110);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, ids] of groups) ids.forEach((id, index) => positions.set(id, { x: 45 + (level - minLevel) * 285, y: spread(index, ids.length, height) }));
  return { positions, width, height };
}

function readSvgView(svg: SVGSVGElement): { x: number; y: number; width: number; height: number } {
  const view = svg.viewBox.baseVal;
  return { x: view.x, y: view.y, width: view.width || 760, height: view.height || 440 };
}

function zoomBounds(svg: SVGSVGElement): { minimumWidth: number; maximumWidth: number } {
  const layoutWidth = Math.max(1, Number(svg.dataset.lineageLayoutWidth) || readSvgView(svg).width);
  return { minimumWidth: 48, maximumWidth: Math.max(1_000_000, layoutWidth * 16) };
}

function preserveAnchor(
  view: { x: number; y: number; width: number; height: number } | null,
  before?: { x: number; y: number },
  after?: { x: number; y: number },
): { x: number; y: number; width: number; height: number } | null {
  if (!view || !before || !after) return view;
  return { ...view, x: view.x + after.x - before.x, y: view.y + after.y - before.y };
}

function expansionKey(nodeId: string, direction: ExpansionDirection): string { return `${direction}\u0000${nodeId}`; }
function directionsOf(direction: "up" | "down" | "both"): ExpansionDirection[] { return direction === "both" ? ["up", "down"] : [direction]; }

function directionalControls<T>(
  kind: "column" | "table",
  nodeId: string,
  label: string,
  position: { x: number; y: number },
  loadedDirections: Set<string>,
  expansions: Map<string, DirectionalExpansion<T>>,
  expandingDirections: Set<string>,
  escape: (value: HtmlValue) => string,
): string {
  return (["up", "down"] as const).map((direction) => {
    const key = expansionKey(nodeId, direction);
    const collapse = expansions.has(key);
    const loading = expandingDirections.has(key);
    if (loadedDirections.has(key) && !collapse && !loading) return "";
    const relation = direction === "up" ? "上游" : "下游";
    const action = collapse ? "收回" : "展开";
    const attribute = collapse ? `data-lineage-collapse-${kind}` : `data-lineage-expand-${kind}`;
    const x = direction === "up" ? position.x - 18 : position.x + 192;
    const glyph = loading ? "···" : direction === "up" ? `←${collapse ? "−" : "＋"}` : `${collapse ? "−" : "＋"}→`;
    return `<g class="node-expand direction-control ${direction === "up" ? "upstream" : "downstream"} ${collapse ? "collapse" : ""} ${loading ? "loading" : ""}" transform="translate(${x} ${position.y + 23})" tabindex="0" role="button" aria-label="${action} ${escape(label)} 的${relation}" ${attribute}="${escape(nodeId)}" data-lineage-direction="${direction}"><rect width="36" height="22" rx="11"/><text x="18" y="15">${glyph}</text></g>`;
  }).join("");
}

function connectedRelations(graph: DataWorksColumnGraph, selected: Set<string>): DataWorksColumnGraph["edges"] {
  return graph.edges.filter((edge) => selected.has(edge.sourceId) || selected.has(edge.targetId));
}

function mergeColumnGraphs(current: DataWorksColumnGraph, patch: DataWorksColumnGraph, expandedId: string, direction: ExpansionDirection): DataWorksColumnGraph {
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  const parentDepth = nodes.get(expandedId)?.depth ?? 0;
  for (const node of patch.nodes) {
    if (node.id === expandedId) continue;
    const existing = nodes.get(node.id);
    const offset = node.depth < 0 ? -1 : node.depth > 0 ? 1 : direction === "up" ? -1 : 1;
    if (!existing) nodes.set(node.id, { ...node, root: false, depth: parentDepth + offset, boundary: true });
  }
  const edges = new Map(current.edges.map((edge) => [`${edge.sourceId}\u0000${edge.targetId}`, edge]));
  patch.edges.forEach((edge) => edges.set(`${edge.sourceId}\u0000${edge.targetId}`, edge));
  return { ...current, depth: Math.max(current.depth, parentDepth + 1), nodes: [...nodes.values()], edges: [...edges.values()], truncated: current.truncated || patch.truncated };
}

function mergeTableGraphs(current: LineageGraph, patch: LineageGraph): LineageGraph {
  const tables = new Map(current.tables.map((table) => [table.id, table]));
  patch.tables.forEach((table) => tables.set(table.id, table));
  const edges = new Map(current.edges.map((edge) => [`${edge.sourceTableId}\u0000${edge.targetTableId}`, edge]));
  patch.edges.forEach((edge) => edges.set(`${edge.sourceTableId}\u0000${edge.targetTableId}`, edge));
  return { ...current, tables: [...tables.values()], edges: [...edges.values()], truncated: current.truncated || patch.truncated };
}

function composeColumnGraph(base: DataWorksColumnGraph, expansions: Map<string, DirectionalExpansion<DataWorksColumnGraph>>): DataWorksColumnGraph {
  let result = base; const applied = new Set<string>(); let changed = true;
  while (changed) {
    changed = false;
    for (const [key, expansion] of expansions) {
      if (applied.has(key) || !result.nodes.some((node) => node.id === expansion.nodeId)) continue;
      result = mergeColumnGraphs(result, expansion.graph, expansion.nodeId, expansion.direction); applied.add(key); changed = true;
    }
  }
  return result;
}

function composeTableGraph(base: LineageGraph, expansions: Map<string, DirectionalExpansion<LineageGraph>>): LineageGraph {
  let result = base; const applied = new Set<string>(); let changed = true;
  while (changed) {
    changed = false;
    for (const [key, expansion] of expansions) {
      if (applied.has(key) || !result.tables.some((table) => table.id === expansion.nodeId)) continue;
      result = mergeTableGraphs(result, expansion.graph); applied.add(key); changed = true;
    }
  }
  return result;
}

function pruneColumnExpansions(graph: DataWorksColumnGraph, expansions: Map<string, DirectionalExpansion<DataWorksColumnGraph>>, loaded: Set<string>): void {
  const visible = new Set(graph.nodes.map((node) => node.id));
  for (const [key, expansion] of expansions) if (!visible.has(expansion.nodeId)) { expansions.delete(key); loaded.delete(key); }
}

function pruneTableExpansions(graph: LineageGraph, expansions: Map<string, DirectionalExpansion<LineageGraph>>, loaded: Set<string>): void {
  const visible = new Set(graph.tables.map((table) => table.id));
  for (const [key, expansion] of expansions) if (!visible.has(expansion.nodeId)) { expansions.delete(key); loaded.delete(key); }
}

function spread(index: number, count: number, height: number): number { return count <= 1 ? height / 2 - 35 : 50 + index * ((height - 120) / (count - 1)); }
function shortName(value: string, maximum: number): string { return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value; }
function shortSvgName(value: string, maximumUnits: number): string {
  let units = 0; let output = "";
  for (const character of value) {
    const size = /[^\u0000-\u00ff]/.test(character) ? 2 : 1;
    if (units + size > maximumUnits - 1) return `${output}…`;
    output += character; units += size;
  }
  return output;
}
function bytes(value?: number | null): string { if (value === null || value === undefined || !Number.isFinite(value)) return "暂无"; const units = ["B", "KB", "MB", "GB", "TB", "PB"]; let size = Math.max(0, value); let index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; } return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`; }

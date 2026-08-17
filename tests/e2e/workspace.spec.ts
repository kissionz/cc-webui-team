import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(page.getByRole("heading", { name: "团队工作台" })).toBeVisible();
  await expect(page.getByText("登录已失效，请重新登录。")).toHaveCount(0);
}

test("管理员可登录、筛选会话并查看审计", async ({ page, isMobile }) => {
  test.skip(isMobile, "桌面端覆盖会话筛选");
  await login(page);
  await page.getByRole("button", { name: "打开工作台" }).click();
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  await expect(page.locator("h1", { hasText: "Harness Platform" })).toBeVisible();
  const search = page.getByPlaceholder("搜索标题或消息");
  await search.fill("部署后的第一条");
  await expect(page.getByRole("button", { name: /部署后的第一条 Harness 会话 idle/ })).toBeVisible();
  expect(await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1024, height: 800 });
  expect(await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth + 1)).toBe(true);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出会话" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.md$/);
  await page.getByRole("button", { name: "系统设置" }).click();
  await page.locator(".system-subnav [data-view='audit']").click();
  await expect(page.getByRole("heading", { name: "审计日志" })).toBeVisible();
  await page.getByRole("button", { name: "筛选日志" }).click();
  await expect(page.getByText("system.initialized")).toBeVisible();
});

test("新建会话后可以立即发送第一条消息", async ({ page, isMobile }) => {
  test.skip(isMobile, "桌面端覆盖新会话首条消息");
  await login(page);
  await page.getByRole("button", { name: "打开工作台" }).click();

  const sent = page.waitForRequest((request) => request.method() === "POST" && /\/api\/sessions\/[^/]+\/messages$/.test(new URL(request.url()).pathname));
  await page.route("**/api/sessions/*/messages", async (route) => {
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: true }) });
  });

  await page.getByRole("button", { name: "新会话" }).click();
  await expect(page.locator("#chat-panel").getByRole("heading", { name: "新会话" })).toBeVisible();
  const composer = page.locator("#chat-panel textarea[name='content']");
  await composer.fill("验证新会话首条消息");
  await page.locator("#chat-panel").getByRole("button", { name: "发送", exact: true }).click();

  const request = await sent;
  expect(request.postDataJSON()).toEqual({ content: "验证新会话首条消息", mode: "send" });
  expect(new URL(request.url()).pathname).not.toContain("session_welcome");
  await expect(composer).toHaveValue("");
});

test("管理员可查看指标、应用模板并批量归档", async ({ page, isMobile }) => {
  test.skip(isMobile, "桌面端覆盖管理批量操作");
  await login(page);
  await page.getByRole("button", { name: "系统设置" }).click();
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();
  await page.getByText("新建团队模板").click();
  await page.getByLabel("名称").fill("E2E 默认策略");
  await page.getByLabel("说明").fill("浏览器验收模板");
  await page.getByRole("button", { name: "保存模板" }).click();
  await expect(page.getByText("团队模板已保存")).toBeVisible();
  await expect(page.getByText("E2E 默认策略")).toBeVisible();
  const template = page.locator(".template-row", { hasText: "E2E 默认策略" });
  await template.getByRole("button", { name: "编辑" }).click();
  await page.getByLabel("名称").fill("E2E 更新策略");
  await page.getByRole("button", { name: "保存模板" }).click();
  await expect(page.getByText("团队模板已保存")).toBeVisible();
  const updatedTemplate = page.locator(".template-row", { hasText: "E2E 更新策略" });
  await updatedTemplate.locator("[data-template-team]").selectOption("team_platform");
  await updatedTemplate.getByRole("button", { name: "应用" }).click();
  await expect(page.getByText("团队模板已应用")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await updatedTemplate.getByRole("button", { name: "删除模板 E2E 更新策略" }).click();
  await expect(page.getByText("团队模板已删除")).toBeVisible();
  await page.getByRole("button", { name: "团队工作台" }).click();
  await page.getByRole("button", { name: "打开工作台" }).click();
  const sessionRail = page.locator(".session-section .session-list");
  const sessionRow = page.locator(".session-row").first();
  expect(await sessionRail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect((await sessionRow.boundingBox())?.height ?? 0).toBeLessThan(100);
  await page.locator("[data-session-select='session_welcome']").check();
  expect(await sessionRail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "归档选中" }).click();
  await expect(page.getByText("已归档 1 个会话")).toBeVisible();
});

test("移动端导航与会话抽屉可通过按钮开关", async ({ page, isMobile }) => {
  test.skip(!isMobile, "仅在移动视口验证抽屉");
  await login(page);
  const navigation = page.getByRole("button", { name: "打开导航" });
  await navigation.click();
  await expect(page.locator("[data-action='toggle-mobile-nav'][aria-label='关闭导航']").last()).toBeVisible();
  await page.getByRole("button", { name: "团队工作台" }).click();
  await page.getByRole("button", { name: "打开工作台" }).click();
  await page.getByRole("button", { name: "会话", exact: true }).click();
  await expect(page.locator("#team-rail")).toBeVisible();
  await expect(page.getByRole("button", { name: "导出会话" })).toBeVisible();
  expect(await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth + 1)).toBe(true);
});

test("数据同步集中配置后可查询血缘并手动触发", async ({ page, isMobile }) => {
  await login(page);
  const stylesheet = await page.request.get("/styles.css");
  expect(stylesheet.headers()["cache-control"]).toBe("no-cache, must-revalidate");
  const completedRun = {
    id: "lineage_sync_e2e", trigger: "manual", requestedBy: "user_admin", dataDate: "20260812", status: "success",
    currentStage: "lineage", projectsProcessed: 2, tablesProcessed: 38, columnsProcessed: 420,
    tasksStaged: 12, jobsProcessed: 12, edgesProcessed: 27, error: null,
    startedAt: 1_786_579_800_000, progressUpdatedAt: 1_786_579_860_000, completedAt: 1_786_579_860_000,
  };
  let mockRun: Record<string, unknown> = { ...completedRun };
  await page.route("**/api/lineage/status", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.config.discoveredProjects = [
      { name: "btn_datalake_customer_service_long_project_name", status: "NORMAL", region: "cn-shanghai" },
      { name: "btn_billing", status: "NORMAL", region: "cn-shanghai" },
    ];
    body.running = mockRun.status === "running";
    body.runs = [mockRun];
    await route.fulfill({ response, json: body });
  });
  if (isMobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "系统设置" }).click();
  await page.locator(".system-subnav [data-view='sync']").click();
  const projectRows = page.locator(".sync-project-option");
  await expect(projectRows).toHaveCount(2);
  const firstRow = await projectRows.nth(0).boundingBox();
  const secondRow = await projectRows.nth(1).boundingBox();
  expect(Math.abs((firstRow?.x ?? 0) - (secondRow?.x ?? 0))).toBeLessThan(2);
  expect((secondRow?.y ?? 0)).toBeGreaterThan((firstRow?.y ?? 0) + (firstRow?.height ?? 0) - 2);
  const longProjectName = projectRows.nth(0).getByText("btn_datalake_customer_service_long_project_name");
  await expect(longProjectName).toBeVisible();
  const longNameLayout = await longProjectName.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  expect(longNameLayout).toMatchObject({ overflow: "visible", textOverflow: "clip", whiteSpace: "normal" });
  expect(longNameLayout.scrollWidth).toBeLessThanOrEqual(longNameLayout.clientWidth + 1);
  expect(longNameLayout.scrollHeight).toBeLessThanOrEqual(longNameLayout.clientHeight + 1);
  await page.getByLabel("执行项目").fill("analytics");
  await page.getByLabel("Endpoint").fill("https://service.cn-shanghai.maxcompute.aliyun.com/api");
  await page.getByLabel("AccessKey ID").fill("LTAI-e2e-test");
  await page.getByLabel("AccessKey Secret").fill("e2e-secret-value");
  await page.getByLabel("启用每日自动同步").check();
  await page.getByLabel(/每日执行时间/).fill("07:30");
  await page.getByRole("button", { name: "保存数据源与调度" }).click();
  await expect(page.getByText("同步设置已保存")).toBeVisible();
  await expect(page.locator(".sync-summary-card", { hasText: "自动调度" })).toContainText("07:30");
  await expect(page.locator(".sync-result")).toContainText("最近同步结果");
  await expect(page.locator(".sync-pipeline")).toContainText("项目范围2 个项目");
  await expect(page.locator(".sync-pipeline")).toContainText("元数据同步38 张表");
  await expect(page.locator(".sync-pipeline")).toContainText("任务历史落库12 个任务");
  await expect(page.locator(".sync-pipeline")).toContainText("血缘增量解析27 条关系");
  mockRun = {
    ...completedRun, status: "running", currentStage: "tasks", tasksStaged: 6_400,
    jobsProcessed: 0, edgesProcessed: 0, progressUpdatedAt: 1_786_579_840_000, completedAt: null,
  };
  await page.reload();
  await expect(page.locator(".sync-result")).toContainText("本次同步进度");
  await expect(page.locator(".sync-result")).toContainText("第 3/4 步");
  await expect(page.locator(".sync-pipeline li.complete")).toHaveCount(2);
  await expect(page.locator(".sync-pipeline li.active")).toContainText("任务历史落库6400 个任务");
  await expect(page.locator(".sync-pipeline li.pending")).toContainText("血缘增量解析等待执行");
  await expect(page.locator(".sync-progress-bar span.active")).toHaveCount(1);
  mockRun = { ...completedRun };
  await page.reload();
  await page.route("**/api/lineage/source-diagnostic", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ diagnostic: {
      dataDate: "20260812", totalJobs: 12, lineageReadyJobs: 7,
      groups: [{ project: "analytics", taskType: "SQL", status: "Terminated", jobs: 12, withInputs: 10, withOutputs: 8, lineageReady: 7 }],
      samples: [], warnings: [], storage: { processedJobs: 12, stagedJobs: 12, parsedJobs: 12, invalidJobs: 0, observations: 0, totalEdges: 0 }, recoveryRecommended: true,
    } }),
  }));
  await page.getByRole("button", { name: "诊断血缘来源" }).click();
  await expect(page.locator(".source-diagnostic")).toContainText("12来源任务");
  await expect(page.getByRole("button", { name: "重新解析已落库任务" })).toBeVisible();

  if (isMobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "数据血缘" }).click();
  await expect(page.getByRole("heading", { name: "数据血缘" })).toBeVisible();
  await expect(page.locator(".lineage-workbench")).toHaveCount(1);
  await expect(page.locator("details.lineage-sync-settings")).toHaveCount(0);

  const table = (id: string, name: string) => ({
    id, project: "analytics", name, type: "MANAGED_TABLE", comment: "E2E 示例", ownerId: null, ownerName: "alice",
    isPartitioned: false, createTime: null, lastModifiedTime: null, lastAccessTime: null, dataLength: 1024,
    partitionCount: 0, lifecycle: 30, storageTier: "standard", clusterType: null, numberBuckets: null,
    hasPrimaryKey: false, isTransactional: false, isDeltaTable: false, tableStorage: "native", tableFormat: "ORC",
    lastScheduleTime: null, lastScheduleStatus: "Terminated", lastTaskName: "daily_sales", lastInstanceId: "i1",
    scheduleOwner: "scheduler", scheduleNodeId: "n1", scheduleNodeName: "销售日汇总", scheduleOnDuty: "u42",
    lastBizDate: "20260812", accessCount: 24, accessBytes: 2048, createdAt: 1, updatedAt: 1,
  });
  const root = table("analytics.dws_sales", "dws_sales");
  const upstream = table("analytics.ods_orders", "ods_orders_with_an_extremely_long_table_name");
  const columns = Array.from({ length: 80 }, (_, index) => ({
    tableId: root.id, name: `field_${String(index + 1).padStart(3, "0")}`, ordinalPosition: index + 1,
    dataType: "STRING", comment: `字段 ${index + 1}`, nullable: true, partitionKey: false, primaryKey: false, updatedAt: 1,
  }));
  await page.route(/\/api\/lineage\/tables(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ tables: [root, upstream] }),
  }));
  await page.route("**/api/lineage/graph?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("scope") === "path";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        rootId: root.id, scope: path ? "path" : "first", direction: "both", tables: [root, upstream], truncated: false,
        pathReversed: path, pathFound: true,
        edges: [{ sourceTableId: upstream.id, targetTableId: root.id, firstSeenAt: 1, lastSeenAt: 1, occurrenceCount: 1, lastInstanceId: "i1", lastTaskName: "daily_sales", lastOwnerName: "scheduler", lastNodeId: "n1", lastNodeName: "销售日汇总", lastOnDuty: "u42", updatedAt: 1 }],
      }),
    });
  });
  await page.route("**/api/lineage/tables/analytics.dws_sales", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ table: root, columns, relations: { upstream: 1, downstream: 0 } }),
  }));
  await page.getByLabel("查询表").fill("analytics.dws");
  await page.getByRole("option", { name: /analytics\.dws_sales/ }).click();
  await page.getByRole("button", { name: "查询血缘" }).click();
  await expect(page.locator(".lineage-svg-node", { hasText: "dws_sales" })).toBeVisible();
  await expect(page.locator(".lineage-svg-node", { hasText: "…" })).toBeVisible();
  await expect(page.locator(".lineage-inspector")).toContainText("销售日汇总");
  const inspectorOverflow = await page.locator(".inspector-scroll").evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(inspectorOverflow.scrollHeight).toBeGreaterThan(inspectorOverflow.clientHeight);
  if (!isMobile) expect((await page.locator(".lineage-workbench").boundingBox())?.height ?? 0).toBeLessThanOrEqual(822);
  const tableExpand = page.locator(`[data-lineage-expand-table="${upstream.id}"]`);
  await expect(tableExpand).toBeVisible();
  await tableExpand.click();
  const tableCollapse = page.locator(`[data-lineage-collapse-table="${upstream.id}"]`);
  await expect(tableCollapse).toBeVisible();
  await tableCollapse.click();
  await expect(tableExpand).toBeVisible();

  await page.getByRole("button", { name: "查路径" }).click();
  await page.getByLabel("表 B").fill("analytics.ods");
  await page.getByRole("option", { name: /analytics\.ods_orders/ }).click();
  await page.getByRole("button", { name: "交换两张表" }).click();
  await expect(page.getByLabel("表 A")).toHaveValue("analytics.ods_orders");
  await page.getByRole("button", { name: "交换两张表" }).click();
  await page.getByRole("button", { name: "查询两表路径" }).click();
  await expect(page.getByText("已识别反向输入，并按真实数据流方向展示。")).toBeVisible();

  const columnRootId = "maxcompute-column:::analytics::dws_sales:total_amount";
  const columnSourceId = "maxcompute-column:::analytics::ods_orders:amount";
  await page.route("**/api/lineage/columns/graph", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ graph: {
      rootId: columnRootId, depth: 1, direction: "both", truncated: false,
      nodes: [
        { id: columnSourceId, table: upstream.id, column: "amount", depth: -1, root: false, boundary: true },
        { id: columnRootId, table: root.id, column: "total_amount", depth: 0, root: true, boundary: false },
      ],
      edges: [{ sourceId: columnSourceId, sourceTable: upstream.id, sourceColumn: "amount", targetId: columnRootId, targetTable: root.id, targetColumn: "total_amount", taskId: "task-1", taskType: "sql", createTime: 1 }],
    } }),
  }));
  await page.route("**/api/lineage/columns/analyze-selection", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ result: {
        status: "found", summary: "订单金额汇总为销售金额。", warnings: [],
        groups: [{ id: "g1", title: "销售金额汇总", fields: [`${upstream.id}.amount`, `${root.id}.total_amount`], relations: [{ sourceTable: upstream.id, sourceColumn: "amount", targetTable: root.id, targetColumn: "total_amount", transformation: "SUM 聚合", confidence: "high", evidenceIds: ["e1"] }] }],
        snippets: [{ id: "e1", language: "sql", explanation: "销售金额聚合", snippet: "SELECT SUM(amount) AS total_amount\nFROM analytics.ods_orders" }],
      } }),
    });
  });
  await page.getByRole("button", { name: "字段血缘" }).click();
  await page.getByLabel("查询表").fill(root.id);
  await page.getByLabel("字段").fill("total_amount");
  await page.getByRole("button", { name: "查看字段血缘" }).click();
  await page.locator(`[data-lineage-field-node="${columnRootId}"]`).click();
  await page.getByRole("button", { name: "分析字段逻辑" }).click();
  await expect(page.locator(".lineage-inspector")).toContainText("Harness 分析中");
  await expect(page.locator(".lineage-inspector")).toContainText("销售金额汇总");
  await expect(page.locator(".analysis-code-snippets")).toContainText("SELECT SUM(amount) AS total_amount");

  const syncRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/lineage/sync");
  await page.route("**/api/lineage/sync", (route) => route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: true }) }));
  await page.getByRole("button", { name: "立即同步" }).click();
  await syncRequest;
  await expect(page.getByText("血缘同步已启动")).toBeVisible();
  expect(await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth + 1)).toBe(true);
});

test("系统设置统一管理用户与目录权限", async ({ page, isMobile }) => {
  test.skip(isMobile, "桌面端覆盖单行用户管理布局");
  await login(page);
  await page.getByRole("button", { name: "系统设置" }).click();
  expect((await page.locator(".system-subnav-item").first().boundingBox())?.height ?? 0).toBeLessThan(70);
  await page.locator(".system-subnav [data-view='users']").click();
  await expect(page.locator(".user-row").first()).toBeVisible();
  const rowBox = await page.locator(".user-row").first().boundingBox();
  expect(rowBox?.height ?? 0).toBeLessThan(100);
  await page.getByRole("button", { name: "创建用户" }).click();
  await expect(page.getByRole("dialog", { name: "创建用户" })).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();
  await page.locator(".system-subnav [data-view='permissions']").click();
  await expect(page.getByRole("heading", { name: "角色目录权限" })).toBeVisible();
  await expect(page.locator("form[data-form='directory-permissions'] input[name='lineage']")).not.toBeChecked();
});

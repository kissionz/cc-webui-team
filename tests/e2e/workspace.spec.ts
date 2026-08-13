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
  await expect(page.locator("h1", { hasText: "Claude Code Platform" })).toBeVisible();
  const search = page.getByPlaceholder("搜索标题或消息");
  await search.fill("部署后的第一条");
  await expect(page.getByRole("button", { name: /部署后的第一条 Claude Code 会话 idle/ })).toBeVisible();
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
  if (isMobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "系统设置" }).click();
  await page.locator(".system-subnav [data-view='sync']").click();
  await page.getByLabel("Project").fill("analytics");
  await page.getByLabel("Endpoint").fill("https://service.cn-shanghai.maxcompute.aliyun.com/api");
  await page.getByLabel("AccessKey ID").fill("LTAI-e2e-test");
  await page.getByLabel("AccessKey Secret").fill("e2e-secret-value");
  await page.getByLabel("启用每日自动同步").check();
  await page.getByLabel(/每日执行时间/).fill("07:30");
  await page.getByRole("button", { name: "保存数据源与调度" }).click();
  await expect(page.getByText("同步设置已保存")).toBeVisible();
  await expect(page.locator(".sync-summary-card", { hasText: "自动调度" })).toContainText("07:30");

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
  const upstream = table("analytics.ods_orders", "ods_orders");
  await page.route("**/api/lineage/graph?*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      rootId: root.id, scope: "first", direction: "both", tables: [root, upstream], truncated: false,
      edges: [{ sourceTableId: upstream.id, targetTableId: root.id, firstSeenAt: 1, lastSeenAt: 1, occurrenceCount: 1, lastInstanceId: "i1", lastTaskName: "daily_sales", lastOwnerName: "scheduler", lastNodeId: "n1", lastNodeName: "销售日汇总", lastOnDuty: "u42", updatedAt: 1 }],
    }),
  }));
  await page.route("**/api/lineage/tables/analytics.dws_sales", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ table: root, columns: [], relations: { upstream: 1, downstream: 0 } }),
  }));
  await page.getByLabel("查询表").fill("analytics.dws_sales");
  await page.getByRole("button", { name: "查询血缘" }).click();
  await expect(page.locator(".lineage-svg-node", { hasText: "dws_sales" })).toBeVisible();
  await expect(page.locator(".lineage-inspector")).toContainText("销售日汇总");

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

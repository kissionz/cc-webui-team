import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(page.getByRole("heading", { name: "团队工作台" })).toBeVisible();
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
  await page.getByRole("button", { name: "审计日志" }).click();
  await expect(page.getByRole("heading", { name: "审计日志" })).toBeVisible();
  await page.getByRole("button", { name: "筛选日志" }).click();
  await expect(page.getByText("system.initialized")).toBeVisible();
});

test("管理员可查看指标、应用模板并批量归档", async ({ page, isMobile }) => {
  test.skip(isMobile, "桌面端覆盖管理批量操作");
  await login(page);
  await page.getByRole("button", { name: "Agent 设置" }).click();
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
  await page.locator("[data-session-select='session_welcome']").check();
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

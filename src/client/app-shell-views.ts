import type { AppState, AppView, HtmlValue, User } from "./types.js";

export interface AppShellViewDeps {
  state(): AppState;
  currentUser(): User | undefined;
  icons: Record<string, string>;
  escapeHtml(value: HtmlValue): string;
}

export function createAppShellViews(deps: AppShellViewDeps) {
  const state = new Proxy({} as AppState, {
    get: (_target, key: keyof AppState) => deps.state()[key],
  });
  const { currentUser, icons, escapeHtml } = deps;

  function navButton(view: AppView, icon: string, text: string): string {
    const systemViews: AppView[] = ["settings", "sync", "users", "audit", "permissions"];
    const active = state.activeView === view || (view === "teams" && state.activeView === "team") || (view === "settings" && systemViews.includes(state.activeView));
    return `<button class="nav-button ${active ? "active" : ""}" title="${escapeHtml(text)}" data-view="${view}">${icon}<span>${text}</span></button>`;
  }

  function appRoot(inner: string): string {
    const user = currentUser();
    const canSee = (directory: "teams" | "lineage" | "system") => state.allowedDirectories.includes(directory);
    const nav = `${canSee("teams") ? navButton("teams", icons.teams, "团队工作台") : ""}${canSee("lineage") ? navButton("lineage", icons.lineage, "数据血缘") : ""}${canSee("system") ? navButton("settings", icons.settings, "系统设置") : ""}`;
    const sidebarLabel = state.sidebarCollapsed ? "展开导航栏" : "收起导航栏";
    const mobileLabel = state.mobileNavOpen ? "关闭导航" : "打开导航";

    return `
      <div class="app-shell ${state.sidebarCollapsed ? "sidebar-collapsed" : ""} ${state.mobileNavOpen ? "mobile-nav-open" : ""}">
        <button class="mobile-nav-scrim" aria-label="关闭导航" data-action="toggle-mobile-nav"></button>
        <aside class="sidebar">
          <div class="brand">
            <div class="brand-mark">CC</div>
            <div class="brand-copy"><div class="brand-title">Claude Code</div><div class="brand-subtitle">Team Platform</div></div>
            <button class="sidebar-toggle" title="${sidebarLabel}" aria-label="${sidebarLabel}" data-action="toggle-sidebar">${icons.panel}</button>
          </div>
          <nav class="nav-group">${nav}</nav>
          <div class="sidebar-footer">
            <div class="user-chip"><div class="avatar">${escapeHtml(user?.displayName?.slice(0, 1) || "U")}</div><div><strong>${escapeHtml(user?.displayName || "")}</strong><div class="brand-subtitle">${escapeHtml(user?.role || "")}</div></div></div>
            <button class="nav-button margin-top-12" title="改密码" data-modal="password">${icons.settings}<span>改密码</span></button>
            <button class="nav-button margin-top-12" title="退出" data-action="logout">${icons.logout}<span>退出</span></button>
          </div>
        </aside>
        <main class="main">
          <button class="mobile-nav-trigger" data-action="toggle-mobile-nav" aria-expanded="${state.mobileNavOpen}" aria-label="${mobileLabel}">${icons.panel}<span>导航</span></button>
          ${inner}
        </main>
      </div>
    `;
  }

  function topbar(title: string, subtitle: string, actions = ""): string {
    return `<header class="topbar"><div><h1 class="page-title">${escapeHtml(title)}</h1><div class="page-subtitle">${escapeHtml(subtitle)}</div></div><div class="toolbar">${actions}</div></header>`;
  }

  function renderLogin(error = ""): void {
    const element = document.querySelector<HTMLElement>("#app");
    if (!element) throw new Error("应用挂载节点不存在");
    element.innerHTML = `
      <div class="login-page">
        <section class="login-copy"><h1>Claude Code Team Platform</h1><p>把服务器上的 Claude Code CLI 封装成团队可共享、可观察、可审批的 Agent 工作台。</p></section>
        <section class="login-panel">
          <form class="login-box" data-form="login">
            <h2>登录工作台</h2><p>管理员账号为 admin，密码来自部署环境变量 ADMIN_PASSWORD。</p>
            <div class="field"><label for="login-username">用户名</label><input class="input" id="login-username" name="username" value="admin" autocomplete="username" /></div>
            <div class="field"><label for="login-password">密码</label><input class="input" id="login-password" name="password" type="password" autocomplete="current-password" /></div>
            ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
            <button class="button primary full-width" type="submit">登录工作台</button>
            <div class="helper">数据由服务端持久化。首次部署请立刻修改默认管理员密码。</div>
          </form>
        </section>
      </div>
    `;
  }

  return { appRoot, topbar, renderLogin };
}

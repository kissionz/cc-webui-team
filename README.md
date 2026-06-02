# Claude Code Team Platform

一个可 Docker 部署的 Claude Code CLI 团队协作平台 MVP。它提供真实后端、登录会话、团队/成员/会话 API、权限审批、SSE 事件流、JSON 文件持久化，以及服务器侧 Claude Code CLI 健康检查和进程执行入口。

## 最低硬件

- 2 vCPU
- 4 GB RAM
- 20 GB SSD
- Ubuntu 22.04+ / Debian 12+ / 任意可运行 Docker 的 Linux

推荐小团队配置：4 vCPU、8 GB RAM、50 GB SSD，并配置 2-4 GB swap。

## Docker 部署

先创建 `.env`，并设置一个强管理员密码：

```bash
cp .env.example .env
```

然后编辑 `.env`：

```text
ADMIN_PASSWORD=replace-with-a-strong-admin-password
```

```bash
docker compose up -d --build
```

访问：

```text
http://服务器IP:3000
```

默认管理员账号：

```text
admin / 你在 ADMIN_PASSWORD 中设置的密码
```

如果需要本地演示用户，可以把 `SEED_DEMO_USERS` 设为 `true` 后重新初始化数据目录。生产环境建议保持关闭。

## 挂载目录

```text
./data       -> /app/data       # 用户、团队、会话、权限、审计等持久化数据
./workspaces -> /workspaces     # 团队工作区 allowlist 根目录
```

团队 workspace 必须位于 `/workspaces` 内，否则后端会拒绝创建。

## 使用宿主机 Claude Code CLI

如果宿主机已经安装并登录了 Claude Code CLI，可以让容器复用宿主机上的 CLI 包和 `~/.claude` 登录态。

先在宿主机确认：

```bash
claude --version
```

然后准备可挂载的 CLI 包。

macOS / Linux：

```bash
sh scripts/prepare-host-claude.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-host-claude.ps1
```

启动时叠加 host override：

```bash
docker compose -f docker-compose.yml -f docker-compose.host-claude.yml up -d --build
```

这个方式会挂载：

```text
./.host-claude/claude-code -> /opt/claude-code     # 宿主机 CLI 包副本
~/.claude                  -> /home/node/.claude   # 宿主机 Claude Code 登录态
```

`.host-claude/` 和 `.env` 都已加入 `.gitignore`，不要上传到 GitHub。

后端会按以下配置调用 CLI：

```text
CLAUDE_COMMAND=/opt/claude-code/cli.js
CLAUDE_ARGS=-p
```

生产环境不要把 `~/.claude`、`.env`、`.host-claude/` 暴露给前端或提交到仓库。

### Windows 宿主机注意事项

Windows 可以用 Docker Desktop 部署，但有三点差异：

- `claude` 通常是 `claude.cmd`，脚本会解析它背后的 npm 全局包并复制到 `.host-claude/`。
- `~/.claude` 在 compose 中会解析为你的 Windows 用户目录，例如 `C:\Users\you\.claude`。
- 你的项目目录和用户目录必须在 Docker Desktop 的文件共享范围内，否则挂载会失败。

如果容器内健康检查显示找不到 Claude Code，先确认宿主机 PowerShell 里能运行：

```powershell
claude --version
```

再重新执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-host-claude.ps1
docker compose -f docker-compose.yml -f docker-compose.host-claude.yml up -d --build
```

## 本地运行

```bash
npm start
```

默认监听：

```text
http://localhost:3000
```

## 当前能力

- 服务端登录、退出、HttpOnly cookie session
- 用户创建、启用/禁用
- 团队创建、成员添加、角色权限
- 单 Agent 会话创建、停止、发送消息
- 敏感任务平台层审批
- SSE 事件通知与前端自动刷新
- Claude Code CLI `--version` 健康检查
- 在团队 workspace 中调用 Claude Code CLI
- 审计日志

## 生产建议

- 使用 Caddy/Nginx 做 HTTPS 反代
- 修改默认管理员密码
- 把 `data` 和 `workspaces` 做持久化备份
- 容器以非 root 用户运行
- 限制 workspace allowlist
- 若要高并发或企业审计，下一步建议迁移到 PostgreSQL/SQLite 正式数据库层

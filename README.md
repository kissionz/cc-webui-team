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
PORT=8068
HOST=0.0.0.0
```

```bash
docker compose up -d --build
```

访问：

```text
http://服务器IP:8068
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
CLAUDE_ARGS=
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
http://localhost:8068
```

## Windows 原生运行 Claude Code

如果你在 Windows 宿主机上的 Claude Code CLI 已经配置了很多 MCP、hooks、settings 或项目级配置，推荐不要把后端放进 Linux Docker 容器，而是直接在 Windows 上运行 Node 服务。这样后端调用的就是你宿主机环境里的 `claude`，能最大程度复用现有配置。

PowerShell：

```powershell
git clone https://github.com/kissionz/cc-webui-team.git
cd cc-webui-team

copy .env.example .env
notepad .env

$env:ADMIN_PASSWORD="your-strong-password"
$env:PORT="8068"
$env:HOST="0.0.0.0"
$env:WORKSPACE_ROOT="C:\workspaces"
$env:CLAUDE_COMMAND="claude"
$env:CLAUDE_ARGS=""

npm start
```

后端通过官方 `@anthropic-ai/claude-agent-sdk` 调用宿主机 Claude Code，并保存返回的 `session_id`。同一个 Web 会话后续消息会自动用 `resume` 恢复 Claude Code 上下文。`CLAUDE_ARGS` 只用于额外参数，不要填写 `-p`、`--output-format`、`--input-format`、`--resume` 或 `--allowedTools`。

访问：

```text
http://localhost:8068
```

同一内网里的其他电脑访问：

```text
http://你的Windows内网IP:8068
```

Windows 防火墙如果拦截，需要放行 8068 端口：

```powershell
New-NetFirewallRule -DisplayName "Claude Code WebUI 8068" -Direction Inbound -Protocol TCP -LocalPort 8068 -Action Allow
```

查看本机内网 IP：

```powershell
ipconfig
```

通常看正在使用的网卡下的 `IPv4 地址`，例如 `192.168.1.23`。

这种方式不会复制 Claude Code CLI，也不会改变你的 MCP 配置；它直接使用当前 Windows 用户的 PATH、`%USERPROFILE%\.claude` 和宿主机可执行环境。

如果用 Docker 复用宿主机 CLI，需要注意：Linux 容器无法直接执行 Windows 的 `claude.cmd`，所以只能复制 CLI 包并挂载 `.claude`。这能复用一部分配置，但如果 MCP 里引用了 Windows 路径、PowerShell 命令、`.exe` 程序或宿主机专用环境变量，容器内可能无法运行。

### 忘记或改错 admin 密码

如果已经启动过一次，`data/db.json` 里会保存初始化时的密码哈希。之后修改 `.env` 里的 `ADMIN_PASSWORD` 不会自动覆盖已有密码。

可以临时设置一次：

```powershell
$env:RESET_ADMIN_PASSWORD="true"
$env:ADMIN_PASSWORD="new-strong-password"
npm start
```

成功登录后，停止服务并清掉这个临时变量：

```powershell
Remove-Item Env:\RESET_ADMIN_PASSWORD
```

也可以删除 `data\db.json` 后重新初始化，但这会清空用户、团队、会话和审计数据。

### Workspace 配置没有生效

`.env` 里的 `WORKSPACE_ROOT` 会在服务启动时同步到系统运行配置，用于新建团队时的 workspace allowlist。

如果你已经启动过一次，默认团队 `Claude Code Platform` 的 workspace 路径已经保存在 `data\db.json`，后续修改 `WORKSPACE_ROOT` 不会自动改这个已有团队。

可以选择其一：

1. 在页面里创建一个新团队，workspace 填新的目录。
2. 删除 `data\db.json` 后重新初始化，这会清空已有数据。
3. 临时重置默认团队 workspace：

```powershell
$env:RESET_DEFAULT_TEAM_WORKSPACE="true"
npm start
```

重置后清掉临时变量：

```powershell
Remove-Item Env:\RESET_DEFAULT_TEAM_WORKSPACE
```

## 当前能力

- 服务端登录、退出、HttpOnly cookie session
- 用户创建、初始密码设置、启用/禁用
- 团队创建、成员添加、角色权限
- 单 Agent 会话创建、停止、发送消息
- 敏感任务平台层审批
- SSE 事件通知与前端自动刷新
- Claude Code CLI `--version` 健康检查
- 在团队 workspace 中调用 Claude Code CLI
- 审计日志

## MCP / 工具授权说明

后端使用 Claude Agent SDK 的 `canUseTool` 回调接入 Claude Code 原生工具授权。Claude Code 请求使用 MCP 工具或受限工具时，后端会暂停在该工具调用节点，生成待审批记录，通过 SSE 推给前端。用户选择“允许一次 / 总是允许工具 / 总是允许 server / 拒绝”后，审批结果会回传给 SDK，Claude Code 在同一轮任务中继续执行。

如果某些旧版 CLI 或特殊权限路径没有触发 `canUseTool`，后端仍保留 `allowedTools + resume` 兜底逻辑；这种情况下续跑 prompt 会静默发送，不会显示成用户聊天气泡。

## 生产建议

- 使用 Caddy/Nginx 做 HTTPS 反代
- 修改默认管理员密码
- 把 `data` 和 `workspaces` 做持久化备份
- 容器以非 root 用户运行
- 限制 workspace allowlist
- 若要高并发或企业审计，下一步建议迁移到 PostgreSQL/SQLite 正式数据库层

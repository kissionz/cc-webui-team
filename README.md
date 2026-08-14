# Claude Code Team Platform

面向小团队的 Claude Code 协作平台。当前版本采用严格 TypeScript、SQLite WAL、Claude Agent SDK、游标分页和可恢复任务状态；适合当前百级会话、20+ 用户规模，并为更大的单机团队部署保留了容量空间。

## 当前架构

```text
Browser (TypeScript SPA)
  ├─ REST：登录、团队、会话、数据血缘、审批、导出、审计、指标
  └─ SSE：消息增量、状态、审批和计划更新
            │
Node.js 24 / TypeScript
  ├─ 鉴权、角色与团队数据隔离
  ├─ 全局 / 团队 / 用户三级并发调度
  ├─ Claude Agent SDK 运行时、增量批处理与会话恢复
  ├─ MaxCompute 元数据日同步、表血缘查询与字段血缘只读分析
  ├─ 有界 SSE 背压、结构化日志与管理指标
  └─ SQLite WAL：事务、全文检索、游标分页、在线备份
            │
       团队 workspace allowlist
```

JSON 文件存储已退出主链路。第一次启动新版时，如果 `data/db.json` 存在，系统会在事务中一次性导入 SQLite，成功后把原文件重命名为带时间戳的 `.bak` 备份。不要手工删除备份，确认数据完整后再自行归档。

## 要求

- Node.js 24 或更高版本
- Claude Code 登录态；团队部署应使用独立、可撤销的服务账号凭据
- 推荐小团队主机：4 vCPU、8 GB RAM、50 GB SSD

## 本地运行

```bash
cp .env.example .env
npm ci
npm run build
npm start
```

打开 `http://localhost:8068`。初次启动的管理员账号是 `admin`，密码来自 `.env` 的 `ADMIN_PASSWORD`。

开发时使用：

```bash
npm run dev
```

项目会自动加载仓库根目录的 `.env`，但不会覆盖已经存在的进程环境变量。需要另一份配置时可直接运行：

```bash
node --env-file=/absolute/path/to/custom.env dist/server.js
```

## Docker 部署

```bash
cp .env.example .env
# 编辑 .env，至少设置强 ADMIN_PASSWORD
docker compose up -d --build
```

默认使用 Docker named volume，避免 Linux 首次部署时 bind mount 被 root 创建后导致服务账号无写权限：

```text
claude_data       -> /app/data       # SQLite、迁移备份
claude_workspaces -> /workspaces     # 团队工作区 allowlist 根目录
```

需要映射宿主机目录时，可自行改为 bind mount，但要先创建目录并确保容器内 `node` 用户（UID 1000）可读写。

如果必须复用宿主机安装的 Claude Code 包和 `~/.claude`，先运行对应准备脚本，再叠加 compose override：

```bash
sh scripts/prepare-host-claude.sh
docker compose -f docker-compose.yml -f docker-compose.host-claude.yml up -d --build
```

Windows 可运行 `scripts/prepare-host-claude.ps1`。包含宿主机绝对路径、PowerShell 或 `.exe` 的 MCP 配置不能直接在 Linux 容器内工作；这种情况建议在 Windows 原生运行 Node 服务。

安全上不把 `ANTHROPIC_API_KEY` 或 OAuth token 注入任务子进程环境，避免获批 shell 读取共享密钥。Docker 团队部署应使用上面的独立 Claude 服务账号登录态挂载；不要挂载个人主账号凭据。

## 生产配置

关键环境变量见 [.env.example](.env.example)：

- `WORKSPACE_ROOT`：所有团队 workspace 的真实路径必须位于此目录内；会解析符号链接后校验。
- `ALLOWED_ORIGINS`：反向代理或自定义域名必须配置精确来源，多个用逗号分隔。
- `COOKIE_SECURE=true`：HTTPS 部署必须开启。
- `MAX_CONCURRENT_TURNS`、`MAX_CONCURRENT_TURNS_PER_TEAM`、`MAX_CONCURRENT_TURNS_PER_USER`：三级并发上限。
- `CLAUDE_COMMAND`：通常留空或写 `claude`，让 SDK 使用自带运行时；只有使用明确存在的自定义可执行文件时才填写路径。
- `CLAUDE_ALLOW_UNSANDBOXED_WINDOWS`：Windows 原生环境不支持 Claude Code sandbox。推荐改用 WSL2；仅当主机和团队成员均受信任时才设为 `true`，允许 SDK 无沙箱回退。
- `MCP_TOOL_ALLOWLIST`：平台预授权工具；其余工具由会话内审批。
- `MAXCOMPUTE_PROJECT`、`MAXCOMPUTE_PYTHON_COMMAND`、`MAXCOMPUTE_PYTHON_ARGS`：表血缘抽取所用执行项目和 Python 3 启动方式；也可在“系统设置 → 数据同步”直接配置。
- `MAXCOMPUTE_ENABLED`、`MAXCOMPUTE_SCHEDULE_TIME`：是否启用每日同步及 Asia/Shanghai 执行时间；管理员可在“系统设置 → 数据同步”调整、验证连接并随时手动触发。默认 06:15 抽取前一天数据。
- `CREDENTIAL_ENCRYPTION_KEY`：可选的 32 字节 Base64 主密钥。MaxCompute AccessKey 使用 AES-256-GCM 加密后保存；留空时自动生成 `DATA_DIR/credential.key`（0600）。生产环境建议由部署密钥管理注入并纳入备份恢复流程。
- `BACKUP_ENABLED`、`BACKUP_INTERVAL_HOURS`、`BACKUP_RETENTION`：在线备份开关、周期和保留数量。

公网部署建议由 Caddy、Nginx 或同类反向代理终止 TLS，并将数据目录和 workspace 纳入独立备份策略。SQLite 的 `-wal` 与 `-shm` 文件属于数据库运行状态，不应单独复制；优先使用 SQLite 在线备份或在停机后整体备份。

## 备份与恢复

服务默认启动在线 SQLite 备份，每 24 小时执行一次，保留最近 14 份。备份目录默认是 `data/backups/`。也可以手动执行：

```bash
npm run build
npm run db:backup
npm run db:verify -- --source=/absolute/path/to/backup.sqlite
```

恢复必须先正常停止服务，避免与仍在运行的 WAL 写入并发。恢复命令会验证来源文件，并在覆盖前为当前数据库再创建一份 `pre-restore` 备份：

```bash
npm run db:restore -- \
  --source=/absolute/path/to/backup.sqlite \
  --force \
  --confirm-offline
```

不要把 `--confirm-offline` 当作普通确认参数；它表示你已经确认服务进程关闭，数据库的 `-wal` 和 `-shm` 文件不存在。

## 管理与导出

- 管理员运行概览展示真实的队列、任务、流式刷盘、SSE 连接、数据库、备份和平台数据。
- 审计日志支持条件筛选、游标分页及 CSV/JSON 导出。
- 会话可导出为 Markdown 或完整 JSON。
- 管理员可以批量归档/恢复非运行中会话；无法操作的会话会逐项返回原因。
- 团队模板只保存非敏感运行默认值，并按团队隔离；不会复制凭据、命令或 workspace 路径。

## 数据血缘

- 管理员在“系统设置 → 数据同步”填写执行项目、MaxCompute 服务 Endpoint、AccessKey ID/Secret 和调度时间。点击“发现项目并验证连接”会自动保存表单，通过官方 PyODPS SDK 查询 `CATALOGS`，并展示当前 AK 在同一元数据中心可见的项目和 SDK 运行信息。
- AccessKey Secret 不会回传前端，也不会出现在命令行参数、脚本文件或日志中。系统使用 AES-256-GCM 加密后入库，仅在查询启动时通过子进程标准输入传递给 PyODPS Helper。生产环境仍应使用独立 RAM 用户、最小权限并定期轮换 AccessKey。
- 表血缘每天从 `SYSTEM_CATALOG.INFORMATION_SCHEMA` 的 `TABLES`、`COLUMNS`、`PARTITIONS`、`TABLE_ACCESS_INFO` 和 `TASKS_HISTORY` 抽取。默认采集该 AK 在同一元数据中心可见的全部项目，也可在页面勾选指定项目；系统以 `project.table` 隔离对象，把任务输入表到输出表固化为关系，并保存 Owner、最近调度、最近访问、分区与存储等元数据。
- `TASKS_HISTORY` 只保留近期数据，首次上线后应尽快完成一次手动同步；重复抽取同一 `inst_id` 不会重复累计关系。
- 当前按默认 Schema 使用 `project.table` 标识。运行 PyODPS 的账号需要读取租户级 Information Schema，以及目标表对应的 InstanceTunnel 数据读取权限。
- 字段血缘不入库。每次查询只在所选团队 workspace 内启动一次只读 Claude Code 分析，仅允许 `Read`、`Glob`、`Grep`，并由服务端重新读取真实文件和行号后返回代码片段；缺少可验证代码证据的关系不会展示。
- Docker 镜像已经包含 Python 3 和 PyODPS 0.13.0。直接在宿主机运行时安装 Python 3.9+ 后执行 `python -m pip install pyodps==0.13.0`；租户级 Information Schema 授权见[阿里云文档](https://help.aliyun.com/zh/maxcompute/user-guide/tenant-level-information-schema/)。
- Windows 非 Docker 部署推荐把“Python 3 命令”保持为 `auto`，系统会依次尝试 `py -3`、`python` 和 `python3`。如服务使用的解释器不同，可填写 `python.exe` 绝对路径。PyODPS 通过 InstanceTunnel 流式读取完整结果，不再解析 odpscmd 控制台文本，也不需要 Java、MaxCompute 客户端或 Visual Studio。

## 权限与运行模型

- 系统角色：管理员、成员。
- “系统设置 → 权限设置”可配置 Member 是否可见并访问数据血缘；团队工作台固定可见，系统设置固定仅管理员可见。菜单隐藏与后端接口鉴权同时生效。
- 团队角色：所有者、管理员、成员、查看者。
- 私有会话仅创建者和系统管理员可见；团队会话按团队成员关系可见。
- 同一会话只允许一个活跃任务；并发超限时进入公平队列。
- 排队任务可取消；运行中任务可中断；进程异常退出后，遗留运行态会被标记为 `interrupted`，不会假装仍在运行。
- 进程崩溃后，尚未开始的排队任务会按原 FIFO 顺序恢复；缺失用户、团队、会话或 Agent 的异常队列记录会安全终结并写入审计。
- 工具审批具有过期、幂等和原子决策保护，审批缓存可按工具或 MCP 服务撤销。

## 数据升级与回滚

升级前备份 `data/`。新版启动后：

1. 创建 `app.sqlite` 并启用 WAL。
2. 检测旧 `db.json`，只导入一次。
3. 校验并写入迁移标记。
4. 将旧 JSON 重命名为 `.migrated-<timestamp>.bak`。

需要回滚旧版本时，先停止新服务，保留 `app.sqlite*`，再把迁移备份复制为旧版本需要的 `db.json`。不要让新旧版本同时写同一个数据目录。

## 验证

```bash
npm run typecheck
npm run build
npm test -- --run
npx playwright install chromium
npm run test:e2e
```

构建会同时严格检查服务端和浏览器 TypeScript，并把产物写入 `dist/`。端到端测试会启动隔离数据目录和真实 Chromium，不会执行 Claude 任务；本机也可用 `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` 复用已安装的 Chrome。

## 容量边界

当前架构的目标是单实例小团队：百至低千级会话、几十名活跃用户。在下列情况出现前无需引入微服务或 PostgreSQL：多实例横向扩容、跨机任务调度、外部 BI 直接查询、持续高并发写入。届时持久化 Repository 和运行时 Store 已形成清晰边界，可以迁移数据库与队列而不重写前端。

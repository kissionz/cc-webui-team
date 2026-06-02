# Claude Code CLI 团队协作平台 PRD

版本：v1.1  
日期：2026-06-02  
产品定位：从 0 搭建一个可通过 Web 使用 Claude Code CLI 的团队协作平台  
目标用户：研发团队、产品技术团队、自动化工程团队、需要多人共享 AI Coding Agent 工作区的组织

---

## 1. 背景

Claude Code CLI 适合在本地或服务器终端中执行代码理解、代码修改、文件读写、项目分析等任务。个人使用时，用户通常直接在终端运行 Claude Code；但团队使用时，会遇到以下问题：

- 多个成员无法方便地共享同一个 AI Coding 工作区。
- 多个 Claude Code 会话分散在不同终端，缺少统一可视化管理。
- 团队成员难以查看 AI 正在做什么、改了什么、是否需要审批。
- 缺少团队级权限控制，无法区分管理员、成员、只读观察者。
- 服务器上的 Claude Code 登录态、工作区、任务结果缺少统一管理。
- 多 Agent 协同时，缺少 Leader/Teammate 式的任务分发和状态追踪。

本产品从 0 搭建一个 Web 平台，将 Claude Code CLI 封装为可被团队共同使用的 Agent 工作台。平台通过后端进程启动和管理 Claude Code CLI，会话通过 WebSocket/Server-Sent Events 流式返回到浏览器，团队成员可以在同一项目工作区中协作、观察、审批和管理 AI 执行过程。

---

## 2. 产品目标

### 2.1 核心目标

1. 支持在服务器环境中检测、连接、启动 Claude Code CLI。
2. 支持多人账号登录与团队成员管理。
3. 支持团队共享项目工作区。
4. 支持创建、查看、继续和停止 Claude Code 会话。
5. 支持 Leader/Teammate 多 Agent 团队模式。
6. 支持权限审批，包括文件修改、命令执行、危险操作确认。
7. 支持团队角色权限，避免非授权用户触发敏感操作。
8. 支持任务、消息、文件变更、Agent 状态的持久化记录。
9. 支持从 Web 端远程查看和控制 Claude Code 运行过程。

### 2.2 MVP 目标

首版 MVP 需要完成：

- 用户登录。
- 管理员创建用户。
- 创建团队。
- 添加团队成员。
- 配置团队工作区。
- 检测 Claude Code CLI。
- 创建 Claude Code 单 Agent 会话。
- Web 页面发送消息并流式查看 Claude Code 回复。
- 展示 Claude Code 工具调用和权限请求。
- 支持批准/拒绝权限请求。
- 团队成员按角色访问团队与会话。

### 2.3 非目标

首版不做：

- SaaS 计费。
- 企业 SSO/OIDC。
- 多租户组织计费体系。
- 每个用户独立绑定 Claude Code OAuth 凭据。
- 云端代码仓库托管。
- 浏览器内完整 IDE。
- 从零实现 Claude Code 协议，只负责调用和编排 CLI。

---

## 3. 用户角色

### 3.1 System Admin

系统管理员。拥有全局最高权限。

权限：

- 初始化系统。
- 创建和禁用用户。
- 配置 Claude Code CLI 路径。
- 配置全局工作区根目录 allowlist。
- 查看系统运行状态。
- 查看全部团队。
- 重置用户密码。

### 3.2 Team Owner

团队拥有者。通常是团队创建者。

权限：

- 删除团队。
- 修改团队信息。
- 管理团队成员。
- 管理团队 Agent。
- 配置团队工作区。
- 转让 owner。

### 3.3 Team Admin

团队管理员。

权限：

- 添加/移除普通成员。
- 修改 member/viewer 角色。
- 创建和停止团队会话。
- 添加/移除团队 Agent。
- 修改团队名称和工作区。

限制：

- 不能删除团队。
- 不能移除 owner。
- 不能转让 owner。

### 3.4 Team Member

团队普通成员。

权限：

- 查看团队。
- 发送消息。
- 启动已有会话。
- 停止自己触发的任务。
- 审批自己发起任务产生的权限请求。

限制：

- 不能添加/删除成员。
- 不能添加/删除 Agent。
- 不能修改团队工作区。

### 3.5 Team Viewer

只读成员。

权限：

- 查看团队。
- 查看会话消息。
- 查看 Agent 状态。
- 查看文件变更摘要。

限制：

- 不能发送消息。
- 不能启动/停止 Agent。
- 不能审批权限。
- 不能修改任何配置。

---

## 4. 核心使用流程

### 4.1 系统初始化

1. 部署服务端。
2. 系统检测数据库是否已初始化。
3. 首次启动时创建 admin 用户。
4. 管理员登录。
5. 管理员配置 Claude Code CLI 路径。
6. 系统执行健康检查。
7. 管理员配置允许访问的工作区根目录。

### 4.2 创建团队

1. 管理员或普通用户创建团队。
2. 设置团队名称。
3. 选择工作区目录。
4. 选择默认 Agent：Claude Code。
5. 创建者自动成为 Team Owner。
6. 系统创建默认会话或等待用户手动创建。

### 4.3 邀请/添加成员

1. Owner/Admin 打开团队成员管理。
2. 从系统用户列表中选择用户。
3. 设置角色：admin/member/viewer。
4. 用户登录后可以看到该团队。

### 4.4 使用 Claude Code 单 Agent 会话

1. 成员进入团队。
2. 打开或创建 Claude Code 会话。
3. 输入任务。
4. 后端启动 Claude Code CLI 进程。
5. 浏览器实时显示 Claude Code 输出。
6. 若 Claude Code 请求工具权限，页面展示审批卡片。
7. 用户批准或拒绝。
8. Claude Code 继续执行并返回结果。
9. 会话消息和文件变更被持久化。

### 4.5 多 Agent 团队模式

1. Owner/Admin 创建 Agent Team。
2. 设置 Leader Agent，默认 Claude Code。
3. 添加 Teammate Agent，可为 Claude Code 多实例或其他兼容 CLI Agent。
4. 用户向 Leader 下达任务。
5. Leader 将任务拆分给 Teammate。
6. Teammate 并行执行。
7. Leader 汇总结果。
8. 页面显示每个 Agent 的状态、消息、任务进度和权限请求。

---

## 5. 系统架构

### 5.1 推荐技术栈

前端：

- React
- TypeScript
- Vite
- WebSocket/SSE 客户端
- Zustand 或 TanStack Query
- Monaco Editor 可选，用于文件预览

后端：

- Node.js + TypeScript
- Fastify 或 Express
- WebSocket
- SQLite 首版，后续可迁移 PostgreSQL
- child_process/pty 进程管理
- Zod 参数校验

部署：

- Docker
- 单机服务器
- 反向代理可选：Nginx/Caddy

### 5.2 模块划分

```text
web/
  pages/
    login/
    teams/
    sessions/
    settings/
  components/
    agent/
    team/
    permission/
    file-preview/

server/
  modules/
    auth/
    users/
    teams/
    sessions/
    agents/
    permissions/
    workspace/
    audit/
  infra/
    db/
    websocket/
    process-manager/
    logger/

shared/
  types/
  schemas/
```

### 5.3 后端核心服务

#### AuthService

负责：

- 登录。
- 登出。
- JWT/session 签发。
- 当前用户解析。
- 密码 hash。

#### UserService

负责：

- 用户创建。
- 用户禁用。
- 用户角色管理。
- 密码重置。

#### TeamService

负责：

- 团队创建。
- 团队成员管理。
- 团队权限判断。
- 团队列表过滤。

#### AgentService

负责：

- Claude Code CLI 检测。
- Agent 配置管理。
- Agent 健康检查。
- Agent 能力描述。

#### SessionService

负责：

- 会话创建。
- 消息持久化。
- 会话状态。
- 会话恢复。
- 停止会话。

#### ProcessManager

负责：

- 启动 Claude Code CLI。
- 管理 stdin/stdout/stderr。
- 流式解析输出。
- 进程超时和清理。
- 多会话进程隔离。

#### PermissionService

负责：

- 创建权限请求。
- 等待审批。
- 批准/拒绝。
- 权限请求超时。

#### WorkspaceService

负责：

- 工作区目录校验。
- 文件列表。
- 文件读取。
- 文件变更摘要。
- 路径越界防护。

---

## 6. Claude Code CLI 集成

### 6.1 CLI 配置

系统需要支持以下配置：

```json
{
  "claudeCode": {
    "enabled": true,
    "command": "claude",
    "args": [],
    "workingDirectoryMode": "team_workspace",
    "env": {}
  }
}
```

字段说明：

- `command`: CLI 命令，默认 `claude`。
- `args`: 启动参数，首版可为空；如需 ACP/JSON 模式时由实现确认具体参数。
- `workingDirectoryMode`: 默认在团队工作区中启动。
- `env`: 附加环境变量，敏感值加密存储或仅服务端环境注入。

### 6.2 健康检查

健康检查步骤：

1. 检查 command 是否存在。
2. 执行 `claude --version`。
3. 检查服务端环境是否已登录 Claude Code。
4. 尝试启动一次最小会话或协议握手。
5. 返回状态。

响应示例：

```json
{
  "available": true,
  "version": "x.y.z",
  "latency_ms": 120,
  "capabilities": {
    "streaming": true,
    "permission_prompts": true,
    "file_edit": true
  }
}
```

错误示例：

```json
{
  "available": false,
  "code": "CLAUDE_NOT_LOGGED_IN",
  "message": "Claude Code CLI is installed but not authenticated on the server."
}
```

### 6.3 会话启动

启动规则：

- 每个会话一个独立 CLI 进程，或一个可恢复进程，取决于 Claude Code CLI 能力。
- 进程 cwd 为团队 workspace。
- stdout/stderr 实时转发到消息流。
- 会话结束后进程释放。
- 用户手动停止时发送中断信号。

### 6.4 流式输出解析

首版支持两种模式：

1. 文本流模式：按 stdout 文本增量展示。
2. 结构化模式：如果 CLI 支持 JSON/协议输出，则解析为 message/tool_call/permission/file_change。

建议抽象统一事件：

```ts
type AgentEvent =
  | { type: 'message_delta'; text: string }
  | { type: 'message_done'; message_id: string }
  | { type: 'tool_call'; tool_name: string; args: unknown }
  | { type: 'permission_request'; permission_id: string; summary: string }
  | { type: 'file_change'; path: string; change_type: 'created' | 'modified' | 'deleted' }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' };
```

### 6.5 权限审批

当 Claude Code 请求执行敏感操作时，系统需要：

- 创建权限请求记录。
- 暂停该操作。
- 通知前端。
- 等待有权限用户审批。
- 将审批结果写回 CLI 进程或协议通道。

权限请求字段：

- 操作类型。
- 命令内容。
- 文件路径。
- 风险等级。
- 申请 Agent。
- 申请会话。
- 过期时间。

---

## 7. 数据模型

### 7.1 users

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);
```

### 7.2 teams

```sql
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  workspace_mode TEXT NOT NULL DEFAULT 'shared',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
);
```

### 7.3 team_members

```sql
CREATE TABLE team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(team_id, user_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### 7.4 agents

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  env_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);
```

说明：

- `type = 'claude_code'` 表示 Claude Code CLI。
- `team_id = NULL` 表示系统级 Agent 模板。

### 7.5 sessions

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  cwd TEXT NOT NULL,
  process_id TEXT,
  parent_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
```

状态：

- `idle`
- `running`
- `waiting_permission`
- `stopped`
- `completed`
- `failed`

### 7.6 messages

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_id TEXT,
  content_type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

`sender_type`：

- `user`
- `agent`
- `system`
- `tool`

### 7.7 permission_requests

```sql
CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  requested_by_user_id TEXT,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (decided_by) REFERENCES users(id)
);
```

### 7.8 file_changes

```sql
CREATE TABLE file_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  change_type TEXT NOT NULL,
  diff_text TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

### 7.9 audit_logs

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
```

---

## 8. API 设计

### 8.1 Auth

#### POST `/api/auth/login`

请求：

```json
{
  "username": "admin",
  "password": "password"
}
```

响应：

```json
{
  "user": {
    "id": "user_1",
    "username": "admin",
    "display_name": "Admin",
    "role": "admin"
  },
  "token": "jwt"
}
```

#### GET `/api/auth/me`

返回当前用户。

#### POST `/api/auth/logout`

退出登录。

### 8.2 Users

#### GET `/api/users`

仅系统 admin。

#### POST `/api/users`

仅系统 admin。

请求：

```json
{
  "username": "alice",
  "password": "password",
  "display_name": "Alice",
  "email": "alice@example.com",
  "role": "member"
}
```

#### PATCH `/api/users/:id`

仅系统 admin。

#### POST `/api/users/:id/reset-password`

仅系统 admin。

#### PATCH `/api/users/:id/status`

启用或禁用用户。

### 8.3 Claude Code Agent

#### GET `/api/agents/claude-code/status`

返回 Claude Code 状态。

#### POST `/api/agents/claude-code/health-check`

执行健康检查。

#### PATCH `/api/agents/claude-code/config`

系统 admin 修改 Claude Code CLI 配置。

### 8.4 Teams

#### GET `/api/teams`

返回当前用户可访问团队。

系统 admin 可使用：

```text
GET /api/teams?scope=all
```

#### POST `/api/teams`

创建团队。

请求：

```json
{
  "name": "Web Team",
  "workspace_path": "/srv/workspaces/web-app"
}
```

#### GET `/api/teams/:team_id`

返回团队详情。

#### PATCH `/api/teams/:team_id`

修改团队。

#### DELETE `/api/teams/:team_id`

删除团队，仅 owner。

### 8.5 Team Members

#### GET `/api/teams/:team_id/members`

查看团队成员。

#### POST `/api/teams/:team_id/members`

添加成员。

请求：

```json
{
  "user_id": "user_2",
  "role": "member"
}
```

#### PATCH `/api/teams/:team_id/members/:user_id`

修改角色。

#### DELETE `/api/teams/:team_id/members/:user_id`

移除成员。

### 8.6 Sessions

#### GET `/api/teams/:team_id/sessions`

查看团队会话。

#### POST `/api/teams/:team_id/sessions`

创建会话。

请求：

```json
{
  "agent_type": "claude_code",
  "title": "Implement login flow"
}
```

#### GET `/api/sessions/:session_id`

查看会话详情。

#### POST `/api/sessions/:session_id/messages`

发送消息。

请求：

```json
{
  "content": "帮我分析这个项目的登录流程"
}
```

#### POST `/api/sessions/:session_id/stop`

停止会话。

### 8.7 Permission Requests

#### GET `/api/sessions/:session_id/permissions`

查看权限请求。

#### POST `/api/permissions/:permission_id/approve`

批准权限请求。

#### POST `/api/permissions/:permission_id/reject`

拒绝权限请求。

### 8.8 WebSocket Events

连接：

```text
GET /ws
```

事件：

```ts
type ServerEvent =
  | { type: 'session.message.delta'; session_id: string; text: string }
  | { type: 'session.message.done'; session_id: string; message_id: string }
  | { type: 'session.status.changed'; session_id: string; status: string }
  | { type: 'permission.created'; permission_id: string; session_id: string }
  | { type: 'permission.updated'; permission_id: string; status: string }
  | { type: 'file.changed'; session_id: string; path: string }
  | { type: 'agent.error'; session_id: string; code: string; message: string };
```

权限：

- WebSocket 连接必须认证。
- 用户只能收到自己可访问团队的事件。

---

## 9. 前端页面

### 9.1 登录页

功能：

- 用户名密码登录。
- 错误提示。
- 首次初始化引导。

### 9.2 团队列表页

功能：

- 查看我的团队。
- 创建团队。
- admin 查看全部团队。
- 显示团队名称、工作区、成员数、最近活动时间、我的角色。

### 9.3 团队详情页

区域：

- 左侧：团队会话列表。
- 中间：当前会话聊天流。
- 右侧：Agent 状态、权限请求、文件变更。

功能：

- 创建 Claude Code 会话。
- 发送消息。
- 停止会话。
- 查看流式回复。
- 审批权限请求。
- 查看文件变更摘要。

### 9.4 团队成员页/弹窗

功能：

- 成员列表。
- 添加成员。
- 修改角色。
- 移除成员。
- owner 转让。

### 9.5 Agent 设置页

功能：

- 查看 Claude Code CLI 状态。
- 配置 CLI 命令路径。
- 运行健康检查。
- 显示版本。
- 显示登录态状态。
- 显示工作区运行策略说明。

### 9.6 用户管理页

仅系统 admin。

功能：

- 用户列表。
- 创建用户。
- 修改用户。
- 禁用用户。
- 重置密码。

### 9.7 个人设置页

功能：

- 查看个人信息。
- 修改显示名。
- 修改密码。
- 退出登录。

---

## 10. 权限规则

### 10.1 系统权限

| 操作 | admin | member |
| --- | --- | --- |
| 查看全部用户 | 是 | 否 |
| 创建用户 | 是 | 否 |
| 禁用用户 | 是 | 否 |
| 配置 Claude Code CLI | 是 | 否 |
| 配置 workspace allowlist | 是 | 否 |
| 查看全部团队 | 是 | 否 |

### 10.2 团队权限

| 操作 | owner | admin | member | viewer |
| --- | --- | --- | --- | --- |
| 查看团队 | 是 | 是 | 是 | 是 |
| 查看会话 | 是 | 是 | 是 | 是 |
| 创建会话 | 是 | 是 | 是 | 否 |
| 发送消息 | 是 | 是 | 是 | 否 |
| 停止会话 | 是 | 是 | 有限制 | 否 |
| 审批权限 | 是 | 是 | 有限制 | 否 |
| 添加 Agent | 是 | 是 | 否 | 否 |
| 添加成员 | 是 | 是 | 否 | 否 |
| 移除成员 | 是 | 是 | 否 | 否 |
| 修改工作区 | 是 | 是 | 否 | 否 |
| 删除团队 | 是 | 否 | 否 | 否 |

说明：

- member 只能停止或审批自己发起任务产生的请求。
- owner 至少保留一个。
- admin 不能移除 owner。
- viewer 后端 API 也必须拒绝写操作。

---

## 11. 安全要求

### 11.1 认证

- 所有 API 默认需要认证，除登录和首次初始化。
- 密码使用 bcrypt/argon2 hash。
- JWT 设置过期时间。
- 禁用用户的 token 应失效。

### 11.2 授权

- 后端必须做权限判断。
- 前端隐藏按钮只是体验优化，不作为安全边界。
- 所有 team/session/permission/file API 都必须校验用户是否属于团队。

### 11.3 工作区安全

- 系统 admin 配置允许访问的根目录。
- 团队 workspace 必须位于 allowlist 内。
- 文件读取必须防路径穿越。
- 不允许读取 workspace 外的文件，除非系统显式授权。

### 11.4 CLI 安全

- Claude Code 使用服务器环境登录态。
- 不在前端暴露 Claude Code token。
- 日志中脱敏 env、token、API key。
- 进程启动环境变量最小化。

### 11.5 权限请求

以下操作应产生权限请求或受策略控制：

- 文件写入。
- 文件删除。
- shell 命令执行。
- 安装依赖。
- 访问 workspace 外路径。
- 长时间运行任务。

### 11.6 审计日志

必须记录：

- 登录失败。
- 用户创建、禁用、重置密码。
- 团队创建、删除。
- 成员添加、移除、角色变更。
- Claude Code 配置修改。
- 权限请求批准/拒绝。

---

## 12. 错误码

建议错误码：

```text
AUTH_INVALID_CREDENTIALS
AUTH_USER_DISABLED
AUTH_TOKEN_EXPIRED
PERMISSION_DENIED
TEAM_NOT_FOUND
TEAM_MEMBER_REQUIRED
TEAM_OWNER_REQUIRED
TEAM_LAST_OWNER
WORKSPACE_NOT_ALLOWED
WORKSPACE_PATH_INVALID
CLAUDE_NOT_FOUND
CLAUDE_NOT_EXECUTABLE
CLAUDE_NOT_LOGGED_IN
CLAUDE_HEALTH_CHECK_FAILED
SESSION_NOT_FOUND
SESSION_ALREADY_RUNNING
SESSION_PROCESS_FAILED
PERMISSION_REQUEST_NOT_FOUND
PERMISSION_REQUEST_EXPIRED
```

---

## 13. 验收标准

### 13.1 系统初始化

- 首次启动可以创建 admin。
- admin 可以登录。
- admin 可以配置 Claude Code CLI。
- admin 可以配置 workspace allowlist。

### 13.2 Claude Code

- 系统能检测 Claude Code 是否存在。
- 系统能显示 Claude Code 版本。
- 未安装时显示明确错误。
- 未登录时显示明确错误。
- 健康检查成功后可创建会话。
- 用户消息可以发送到 Claude Code。
- Claude Code 回复可以流式显示。
- 用户可以停止正在运行的 Claude Code 会话。

### 13.3 用户管理

- admin 可以创建用户。
- 新用户可以登录。
- 禁用用户不能登录。
- admin 可以重置用户密码。
- 普通用户不能访问用户管理页/API。

### 13.4 团队管理

- 用户可以创建团队并成为 owner。
- owner/admin 可以添加成员。
- member 不能添加成员。
- viewer 只能查看不能发送消息。
- 非团队成员不能通过 URL 或 API 访问团队。
- owner 可以删除团队。
- 团队至少保留一个 owner。

### 13.5 权限审批

- Claude Code 触发敏感操作时生成权限请求。
- 有权限用户可以批准。
- 有权限用户可以拒绝。
- viewer 不能审批。
- 过期权限请求不能再审批。

### 13.6 数据持久化

- 刷新页面后团队仍存在。
- 刷新页面后会话历史仍存在。
- 文件变更记录可查看。
- 审计日志可查询。

---

## 14. 测试计划

### 14.1 单元测试

覆盖：

- 密码 hash。
- JWT 签发与解析。
- 用户状态校验。
- 团队角色权限判断。
- workspace 路径校验。
- Claude Code 健康检查结果解析。
- 权限请求状态流转。

### 14.2 集成测试

覆盖：

- 登录获取 token。
- 创建用户。
- 创建团队。
- 添加成员。
- 创建会话。
- 发送消息。
- 权限审批。
- 非成员访问被拒绝。
- viewer 写操作被拒绝。

### 14.3 E2E 测试

覆盖：

- admin 初始化系统。
- admin 创建用户。
- 用户登录。
- 用户创建团队。
- 用户添加成员。
- 成员创建 Claude Code 会话。
- 成员发送消息并看到流式回复。
- viewer 进入团队只读。
- 权限请求审批流程。

### 14.4 CLI Smoke Test

覆盖：

- `claude --version`。
- command 不存在。
- command 不可执行。
- 未登录状态。
- 最小 prompt 会话。
- stop 会话。

---

## 15. 分阶段开发计划

### Phase 1：项目骨架与认证

交付：

- 前后端项目初始化。
- SQLite schema。
- admin 初始化。
- 登录/登出。
- 当前用户 API。
- 用户管理基础。

### Phase 2：团队与权限

交付：

- teams/team_members。
- 创建团队。
- 添加成员。
- 团队权限中间件。
- 团队列表和详情页。

### Phase 3：Claude Code CLI 接入

交付：

- Claude Code 配置。
- 健康检查。
- ProcessManager。
- 创建会话。
- 发送消息。
- 流式输出。
- 停止进程。

### Phase 4：权限审批与文件变更

交付：

- permission_requests。
- 权限请求 UI。
- approve/reject。
- file_changes。
- 文件变更摘要。

### Phase 5：多 Agent 团队模式

交付：

- Leader/Teammate Agent 配置。
- 多 Agent 并行运行。
- Agent 状态面板。
- Agent 间任务分发记录。
- 汇总结果展示。

### Phase 6：安全与运维完善

交付：

- workspace allowlist。
- audit_logs。
- Docker 部署。
- 日志脱敏。
- 会话清理。
- 健康检查面板。

---

## 16. 开发细节建议

### 16.1 先做单 Agent，再做多 Agent

Claude Code 单 Agent 会话跑通后，再抽象多 Agent。否则容易同时处理进程管理、权限审批、团队分发三个复杂点。

### 16.2 后端权限优先

每个 API 都应该先写权限中间件，再写业务逻辑。尤其是 session、permission、workspace 相关接口。

### 16.3 CLI 适配层要抽象

不要把 Claude Code 逻辑散落在业务代码中。建议定义统一接口：

```ts
interface AgentAdapter {
  type: string;
  healthCheck(): Promise<AgentHealth>;
  startSession(input: StartSessionInput): Promise<AgentRuntime>;
}
```

这样后续可接入 Codex、Gemini CLI、OpenCode 等。

### 16.4 ProcessManager 必须可清理

需要处理：

- 用户停止。
- 浏览器断开。
- 服务重启。
- 进程异常退出。
- 长时间无输出。
- 会话超时。

### 16.5 日志和消息分离

CLI 原始 stdout/stderr 不等于用户消息。建议同时保存：

- 原始运行日志。
- 结构化用户可见消息。
- 工具调用事件。
- 错误事件。

### 16.6 敏感信息脱敏

日志、审计、前端错误都必须脱敏：

- token
- api_key
- authorization
- cookie
- password
- secret

---

## 17. 开放问题

1. Claude Code 是否支持稳定的结构化输出协议？如果不支持，首版需要按文本流兼容。
2. 权限审批如何准确回写到 Claude Code CLI？需要根据 CLI 实际交互方式设计。
3. member 是否可以审批自己发起任务的所有权限，还是只能审批低风险操作？
4. workspace allowlist 是否作为 MVP 必选？建议是必选，因为团队共享服务器文件系统风险较高。
5. 多 Agent 是否使用多个 Claude Code 进程，还是复用同一进程多 session？建议首版多进程隔离。
6. 会话恢复是否依赖 Claude Code CLI 自身能力？如果 CLI 不支持恢复，则平台只恢复历史消息，不恢复进程上下文。

---

## 18. MVP 开发优先级

P0：

- 登录。
- 用户管理。
- 团队管理。
- Claude Code 健康检查。
- 单 Agent 会话。
- 流式消息。
- 停止会话。
- 基础权限判断。

P1：

- 权限审批。
- 文件变更记录。
- workspace allowlist。
- 审计日志。

P2：

- 多 Agent 团队模式。
- Agent 状态看板。
- Leader/Teammate 编排。

P3：

- 更多 CLI Agent。
- 用户独立 Claude Code 凭据。
- SSO。
- PostgreSQL。
- 高可用部署。


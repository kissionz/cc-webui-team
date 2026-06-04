import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

const root = process.cwd();

loadDotEnv(join(root, ".env"));

const PORT = Number(process.env.PORT || 8068);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || join(root, "data");
const DB_FILE = process.env.DB_FILE || join(DATA_DIR, "db.json");
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "/workspaces";
const CLAUDE_COMMAND = process.env.CLAUDE_COMMAND || "claude";
const CLAUDE_ARGS = (process.env.CLAUDE_ARGS || "").split(" ").filter(Boolean);
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const BOOTSTRAP_MESSAGES_PER_SESSION = 240;
const BOOTSTRAP_AUDIT_LIMIT = 300;
const IS_WINDOWS = process.platform === "win32";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const now = () => Date.now();
const id = (prefix) => `${prefix}_${randomBytes(6).toString("hex")}`;

let db = null;
const clients = new Set();
const running = new Map();

function loadDotEnv(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional; Docker Compose and shell env vars can provide config.
  }
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = hashPassword(password, salt).split(":")[1];
  return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex"));
}

function cmdQuote(value) {
  const text = String(value);
  if (!/[ \t&()^|<>"]/.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
}

function windowsShellPath() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (systemRoot) return join(systemRoot, "System32", "cmd.exe");
  return "cmd.exe";
}

function spawnCli(command, args, options = {}) {
  if (!IS_WINDOWS) return spawn(command, args, options);
  const resolved = resolveWindowsCli(command, args);
  if (resolved) return spawn(resolved.command, resolved.args, options);
  return spawnWindowsCommand(command, args, options);
}

function resolveWindowsCli(command, args) {
  const commandPath = resolveWindowsCommandPath(command);
  if (!commandPath) return null;
  const cmdSibling = `${commandPath}.cmd`;
  if (!extname(commandPath) && existsSync(cmdSibling)) {
    const target = resolveClaudeTargetFromCmd(cmdSibling);
    if (target) return { command: target.command, args: [...target.args, ...args] };
    return { command: windowsShellPath(), args: ["/d", "/s", "/c", [cmdSibling, ...args].map(cmdQuote).join(" ")] };
  }
  const lower = commandPath.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const target = resolveClaudeTargetFromCmd(commandPath);
    if (target) return { command: target.command, args: [...target.args, ...args] };
    return { command: windowsShellPath(), args: ["/d", "/s", "/c", [commandPath, ...args].map(cmdQuote).join(" ")] };
  }
  if (!extname(commandPath)) return null;
  return { command: commandPath, args };
}

function spawnWindowsCommand(command, args, options) {
  const line = [command, ...args].map(cmdQuote).join(" ");
  return spawn(windowsShellPath(), ["/d", "/s", "/c", line], options);
}

function resolveWindowsCommandPath(command) {
  if (!command) return null;
  if ((isAbsolute(command) || command.includes("\\") || command.includes("/")) && existsSync(command)) return command;
  try {
    const output = execFileSync("where.exe", [command], { encoding: "utf8", windowsHide: true });
    const matches = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return preferWindowsCommandMatch(matches) || null;
  } catch {
    for (const dir of String(process.env.PATH || "").split(delimiter)) {
      for (const ext of [".cmd", ".bat", ".exe", ""]) {
        const candidate = join(dir, `${command}${ext}`);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function preferWindowsCommandMatch(matches) {
  return (
    matches.find((match) => match.toLowerCase().endsWith(".cmd")) ||
    matches.find((match) => match.toLowerCase().endsWith(".bat")) ||
    matches.find((match) => match.toLowerCase().endsWith(".exe")) ||
    matches[0]
  );
}

function resolveClaudeTargetFromCmd(cmdPath) {
  const candidates = [
    join(dirname(cmdPath), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    join(dirname(dirname(cmdPath)), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    join(dirname(cmdPath), "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
    join(dirname(dirname(cmdPath)), "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
  ];
  for (const candidate of candidates) {
    const target = commandTargetForPath(candidate);
    if (target) return target;
  }

  try {
    const cmdText = readFileSync(cmdPath, "utf8");
    const match = cmdText.match(/(["']?)([^"'\r\n]*node_modules[\\/]+@anthropic-ai[\\/]+claude-code[\\/]+(?:cli\.js|bin[\\/]claude\.exe))\1/i);
    if (!match) return null;
    const raw = match[2]
      .replaceAll("%~dp0", dirname(cmdPath))
      .replaceAll("%dp0%", dirname(cmdPath));
    const normalized = resolve(raw);
    return commandTargetForPath(normalized);
  } catch {
    return null;
  }
}

function commandTargetForPath(filePath) {
  if (!existsSync(filePath)) return null;
  if (filePath.toLowerCase().endsWith(".js")) return { command: process.execPath, args: [filePath] };
  return { command: filePath, args: [] };
}

function seedDb() {
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const createdAt = now();
  const users = [
    { id: "user_admin", username: "admin", passwordHash: hashPassword(adminPassword), displayName: "System Admin", email: "admin@example.com", role: "admin", status: "active", createdAt, updatedAt: createdAt },
  ];
  const members = [
    { teamId: "team_platform", userId: "user_admin", role: "owner", createdAt, updatedAt: createdAt },
  ];

  if (process.env.SEED_DEMO_USERS === "true") {
    users.push(
      { id: "user_alice", username: "alice", passwordHash: hashPassword("password"), displayName: "Alice Chen", email: "alice@example.com", role: "member", status: "active", createdAt, updatedAt: createdAt },
      { id: "user_bob", username: "bob", passwordHash: hashPassword("password"), displayName: "Bob Lin", email: "bob@example.com", role: "member", status: "active", createdAt, updatedAt: createdAt },
      { id: "user_viewer", username: "viewer", passwordHash: hashPassword("password"), displayName: "Viewer", email: "viewer@example.com", role: "member", status: "active", createdAt, updatedAt: createdAt },
    );
    members.push(
      { teamId: "team_platform", userId: "user_alice", role: "admin", createdAt, updatedAt: createdAt },
      { teamId: "team_platform", userId: "user_bob", role: "member", createdAt, updatedAt: createdAt },
      { teamId: "team_platform", userId: "user_viewer", role: "viewer", createdAt, updatedAt: createdAt },
    );
  }

  return {
    sessionsByToken: {},
    users,
    teams: [
      { id: "team_platform", name: "Claude Code Platform", workspacePath: WORKSPACE_ROOT, workspaceMode: "shared", createdBy: "user_admin", createdAt, updatedAt: createdAt },
    ],
    members,
    agents: [
      { id: "agent_claude", teamId: "team_platform", name: "Claude Code", type: "claude_code", command: CLAUDE_COMMAND, enabled: true, status: "idle", createdAt, updatedAt: createdAt },
    ],
    sessions: [
      { id: "session_welcome", teamId: "team_platform", agentId: "agent_claude", createdBy: "user_admin", title: "部署后的第一条 Claude Code 会话", status: "idle", cwd: WORKSPACE_ROOT, createdAt, updatedAt: createdAt },
    ],
    messages: [
      { id: "msg_welcome", sessionId: "session_welcome", senderType: "system", senderId: null, content: "服务端已启动。发送消息后，后端会在团队 workspace 中调用 Claude Code CLI。", createdAt },
    ],
    permissions: [],
    fileChanges: [],
    auditLogs: [],
    claudeConfig: {
      command: CLAUDE_COMMAND,
      args: CLAUDE_ARGS.join(" "),
      workspaceRoot: WORKSPACE_ROOT,
      enabled: true,
      available: false,
      version: "unknown",
      latencyMs: 0,
      authenticated: false,
      lastCheckAt: null,
    },
  };
}

async function loadDb() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    db = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    db = seedDb();
    await saveDb();
  }
}

async function maybeResetAdminPassword() {
  if (process.env.RESET_ADMIN_PASSWORD !== "true") return;
  const admin = db.users.find((user) => user.username === "admin");
  if (!admin) return;
  admin.passwordHash = hashPassword(process.env.ADMIN_PASSWORD || "admin123");
  admin.updatedAt = now();
  db.sessionsByToken = {};
  audit(admin.id, "user.admin_password_reset_from_env", "user", admin.id);
  await saveDb();
}

async function syncRuntimeConfigFromEnv() {
  let changed = false;

  if (process.env.CLAUDE_COMMAND && db.claudeConfig.command !== process.env.CLAUDE_COMMAND) {
    db.claudeConfig.command = process.env.CLAUDE_COMMAND;
    changed = true;
  }

  if (process.env.CLAUDE_ARGS !== undefined && db.claudeConfig.args !== process.env.CLAUDE_ARGS) {
    db.claudeConfig.args = process.env.CLAUDE_ARGS;
    changed = true;
  }

  if (process.env.WORKSPACE_ROOT && db.claudeConfig.workspaceRoot !== process.env.WORKSPACE_ROOT) {
    db.claudeConfig.workspaceRoot = process.env.WORKSPACE_ROOT;
    changed = true;
  }

  if (process.env.RESET_DEFAULT_TEAM_WORKSPACE === "true" && process.env.WORKSPACE_ROOT) {
    const defaultTeam = db.teams.find((team) => team.id === "team_platform");
    const defaultSession = db.sessions.find((session) => session.id === "session_welcome");
    const workspacePath = process.env.WORKSPACE_ROOT;
    if (defaultTeam) {
      defaultTeam.workspacePath = workspacePath;
      defaultTeam.updatedAt = now();
      changed = true;
    }
    if (defaultSession) {
      defaultSession.cwd = workspacePath;
      defaultSession.updatedAt = now();
      changed = true;
    }
  }

  if (changed) await saveDb();
}

async function saveDb() {
  await mkdir(dirname(DB_FILE), { recursive: true });
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim().split("="))
      .filter((item) => item.length === 2),
  );
}

function getCurrentUser(req) {
  const token = parseCookies(req).cc_session;
  const session = token ? db.sessionsByToken[token] : null;
  if (!session || session.expiresAt < now()) return null;
  const user = db.users.find((item) => item.id === session.userId);
  if (!user || user.status !== "active") return null;
  return user;
}

function revokeSessionsForUser(userId, exceptToken = null) {
  for (const [token, session] of Object.entries(db.sessionsByToken || {})) {
    if (session.userId === userId && token !== exceptToken) delete db.sessionsByToken[token];
  }
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  return JSON.parse(body);
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

function error(res, status, code, message) {
  send(res, status, { code, message });
}

function audit(userId, action, targetType, targetId, metadata = {}) {
  db.auditLogs.push({ id: id("audit"), userId, action, targetType, targetId, metadata, createdAt: now() });
}

function canManageTeamSessions(user, teamId) {
  return user.role === "admin" || ["owner", "admin"].includes(getTeamRole(teamId, user.id));
}

function canSeeSession(user, session) {
  return Boolean(session) && canSeeTeam(user, session.teamId) && (canManageTeamSessions(user, session.teamId) || session.createdBy === user.id);
}

function canWriteSession(user, session) {
  return Boolean(session) && canWriteTeam(user, session.teamId) && (canManageTeamSessions(user, session.teamId) || session.createdBy === user.id);
}

function eventVisibleToUser(event, user) {
  if (!user || user.status !== "active") return false;
  if (event.sessionId) return canSeeSession(user, db.sessions.find((session) => session.id === event.sessionId));
  if (event.teamId) return canSeeTeam(user, event.teamId);
  return true;
}

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    const user = db.users.find((item) => item.id === client.userId);
    if (eventVisibleToUser(event, user)) client.res.write(data);
  }
}

function getTeamRole(teamId, userId) {
  return db.members.find((member) => member.teamId === teamId && member.userId === userId)?.role;
}

function canSeeTeam(user, teamId) {
  return user.role === "admin" || Boolean(getTeamRole(teamId, user.id));
}

function canWriteTeam(user, teamId) {
  return user.role === "admin" || ["owner", "admin", "member"].includes(getTeamRole(teamId, user.id));
}

function canManageTeam(user, teamId) {
  return user.role === "admin" || ["owner", "admin"].includes(getTeamRole(teamId, user.id));
}

function canApprove(user, permission) {
  const session = db.sessions.find((item) => item.id === permission.sessionId);
  const role = getTeamRole(session?.teamId, user.id);
  return user.role === "admin" || ["owner", "admin"].includes(role) || (role === "member" && permission.requestedByUserId === user.id);
}

function assertWorkspaceAllowed(workspacePath) {
  const rootPath = resolve(db.claudeConfig.workspaceRoot || WORKSPACE_ROOT);
  const candidate = resolve(workspacePath);
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}/`)) {
    const problem = new Error("WORKSPACE_NOT_ALLOWED");
    problem.code = "WORKSPACE_NOT_ALLOWED";
    throw problem;
  }
  return candidate;
}

function bootstrapFor(user) {
  const teamIds = new Set(db.teams.filter((team) => canSeeTeam(user, team.id)).map((team) => team.id));
  const visibleSessions = db.sessions.filter((session) => teamIds.has(session.teamId) && canSeeSession(user, session));
  const sessionIds = new Set(visibleSessions.map((session) => session.id));
  const auditLogs = user.role === "admin" ? db.auditLogs : db.auditLogs.filter((log) => log.userId === user.id);
  return {
    currentUserId: user.id,
    users: user.role === "admin" ? db.users.map(publicUser) : db.users.map(publicUser),
    teams: db.teams.filter((team) => teamIds.has(team.id)),
    members: db.members.filter((member) => teamIds.has(member.teamId)),
    agents: db.agents.filter((agent) => !agent.teamId || teamIds.has(agent.teamId)),
    sessions: visibleSessions,
    messages: recentMessagesForSessions(sessionIds, BOOTSTRAP_MESSAGES_PER_SESSION),
    permissions: db.permissions.filter((permission) => sessionIds.has(permission.sessionId)),
    fileChanges: db.fileChanges.filter((file) => sessionIds.has(file.sessionId)),
    auditLogs: auditLogs.slice(-BOOTSTRAP_AUDIT_LIMIT),
    claudeConfig: db.claudeConfig,
  };
}

function recentMessagesForSessions(sessionIds, limitPerSession) {
  const buckets = new Map();
  for (let index = db.messages.length - 1; index >= 0; index -= 1) {
    const message = db.messages[index];
    if (!sessionIds.has(message.sessionId)) continue;
    const bucket = buckets.get(message.sessionId) || [];
    if (bucket.length >= limitPerSession) continue;
    bucket.push(message);
    buckets.set(message.sessionId, bucket);
  }
  return [...buckets.values()].flatMap((bucket) => bucket.reverse());
}

async function healthCheck() {
  const started = now();
  return new Promise((resolveHealth) => {
    const probe = describeCliLaunch(db.claudeConfig.command, ["--version"]);
    const child = spawnCli(db.claudeConfig.command, ["--version"], { env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (spawnError) => {
      resolveHealth({ available: false, version: "not found", latencyMs: now() - started, authenticated: false, message: `${spawnError.message}\n${probe}` });
    });
    child.on("close", (code) => {
      const output = (out || err || "unknown").trim();
      resolveHealth({
        available: code === 0,
        version: output.split("\n")[0],
        latencyMs: now() - started,
        authenticated: code === 0,
        message: code === 0 ? `Claude Code CLI is available.\n${probe}` : `${output || `Claude Code exited with code ${code}.`}\n${probe}`,
      });
    });
  });
}

function describeCliLaunch(command, args) {
  if (!IS_WINDOWS) return `launch: ${command} ${args.join(" ")}`;
  const resolved = resolveWindowsCli(command, args);
  if (resolved) return `launch: ${resolved.command} ${resolved.args.join(" ")}`;
  return `launch: ${windowsShellPath()} /d /s /c ${[command, ...args].map(cmdQuote).join(" ")}`;
}

function needsApproval(content) {
  return /(rm\s+-|sudo|install|npm\s+i|pnpm\s+i|yarn\s+add|写入|删除|执行命令|shell|workspace 外|权限)/i.test(content);
}

function sanitizeClaudeExtraArgs(args) {
  const blocked = new Set(["-p", "--print", "--input-format", "--output-format", "--resume", "-r", "--continue", "-c", "--session-id", "--replay-user-messages", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools"]);
  const sanitized = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (blocked.has(arg)) {
      if (["--input-format", "--output-format", "--resume", "-r", "--session-id", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools"].includes(arg)) index += 1;
      continue;
    }
    if (arg.startsWith("--input-format=") || arg.startsWith("--output-format=") || arg.startsWith("--resume=") || arg.startsWith("--session-id=") || arg.startsWith("--allowedTools=") || arg.startsWith("--allowed-tools=") || arg.startsWith("--disallowedTools=") || arg.startsWith("--disallowed-tools=")) continue;
    sanitized.push(arg);
  }
  return sanitized;
}

function ensureToolApprovals(session) {
  if (!session.toolApprovals) session.toolApprovals = { onceTools: [], alwaysTools: [], alwaysServers: [] };
  session.toolApprovals.onceTools ||= [];
  session.toolApprovals.alwaysTools ||= [];
  session.toolApprovals.alwaysServers ||= [];
  return session.toolApprovals;
}

function parseMcpToolName(name = "") {
  const text = String(name || "");
  if (!text.startsWith("mcp__")) return { toolName: text, serverName: "" };
  const parts = text.split("__");
  return { serverName: parts[1] || "", toolName: parts.slice(2).join("__") || text };
}

function toolSpecForServer(serverName) {
  return serverName ? `mcp__${serverName}__*` : "";
}

function approvedToolSpecs(session) {
  const approvals = ensureToolApprovals(session);
  const specs = new Set();
  for (const toolName of [...approvals.alwaysTools, ...approvals.onceTools]) {
    if (toolName) specs.add(toolName);
  }
  for (const serverName of approvals.alwaysServers) {
    const spec = toolSpecForServer(serverName);
    if (spec) specs.add(spec);
  }
  return [...specs];
}

function isToolApprovedByPolicy(session, toolName) {
  const approvals = ensureToolApprovals(session);
  const parsed = parseMcpToolName(toolName);
  return approvals.onceTools.includes(toolName) || approvals.alwaysTools.includes(toolName) || (parsed.serverName && approvals.alwaysServers.includes(parsed.serverName));
}

function applyToolApproval(session, permission, decision) {
  const approvals = ensureToolApprovals(session);
  const toolName = permission.toolName || permission.metadata?.toolName;
  const serverName = permission.serverName || permission.metadata?.serverName;
  if (decision === "allow_always_server" && serverName) {
    if (!approvals.alwaysServers.includes(serverName)) approvals.alwaysServers.push(serverName);
    if (toolName && !approvals.alwaysTools.includes(toolName)) approvals.alwaysTools.push(toolName);
    return;
  }
  if (decision === "allow_always_tool" && toolName) {
    if (!approvals.alwaysTools.includes(toolName)) approvals.alwaysTools.push(toolName);
    return;
  }
  if (decision === "allow_once" && toolName) {
    if (!approvals.onceTools.includes(toolName)) approvals.onceTools.push(toolName);
  }
}

function clearOnceToolApprovals(session) {
  const approvals = ensureToolApprovals(session);
  if (approvals.onceTools.length) approvals.onceTools = [];
}

function permissionUpdatesForDecision(permission, decision, suggestions = []) {
  if (decision === "allow_once") return [];
  if (decision === "allow_always_tool" && Array.isArray(suggestions) && suggestions.length) return suggestions;
  const toolName = permission.toolName || permission.metadata?.toolName;
  const serverName = permission.serverName || permission.metadata?.serverName;
  const rules = [];
  if (decision === "allow_always_server" && serverName) {
    rules.push({ toolName: `mcp__${serverName}__*` });
  } else if (toolName) {
    rules.push({ toolName });
  }
  return rules.length ? [{ type: "addRules", rules, behavior: "allow", destination: "session" }] : [];
}

function permissionClassification(decision, approved) {
  if (!approved) return "user_reject";
  return decision === "allow_once" ? "user_temporary" : "user_permanent";
}

function writeClaudeInput(runtime, payload) {
  if (!runtime?.child?.stdin || runtime.child.stdin.destroyed) return false;
  runtime.child.stdin.write(`${JSON.stringify(payload)}\n`);
  return true;
}

function titleFromPrompt(content) {
  return String(content || "").replace(/\s+/g, " ").trim().slice(0, 50) || "新会话";
}

async function appendAgentMessage(session, agent, content = "", metadata = {}) {
  const message = { id: id("msg"), sessionId: session.id, senderType: "agent", senderId: agent.id, content, metadata, createdAt: now() };
  db.messages.push(message);
  await saveDb();
  broadcast({ type: "session.message.created", sessionId: session.id, message });
  return message;
}

async function appendSessionMessage(session, senderType, content, senderId = null, metadata = {}) {
  const message = { id: id("msg"), sessionId: session.id, senderType, senderId, content, metadata, createdAt: now() };
  db.messages.push(message);
  session.updatedAt = now();
  await saveDb();
  broadcast({ type: "session.message.created", sessionId: session.id, message });
  return message;
}

async function updateSessionMessage(session, message, content, metadata = message.metadata || {}) {
  message.content = content;
  message.metadata = metadata;
  message.updatedAt = now();
  session.updatedAt = now();
  await saveDb();
  broadcast({ type: "session.message.updated", sessionId: session.id, message });
  return message;
}

async function appendMessageDelta(session, message, text, metadata = message.metadata || {}) {
  if (!text) return message;
  message.content = `${message.content || ""}${text}`;
  message.metadata = metadata;
  message.updatedAt = now();
  session.updatedAt = now();
  broadcast({ type: "session.message.delta", sessionId: session.id, messageId: message.id, text });
  return message;
}

function getRuntime(sessionId) {
  return running.get(sessionId) || null;
}

function stopRuntime(sessionId) {
  const runtime = getRuntime(sessionId);
  if (!runtime) return;
  runtime.stoppedForRestart = true;
  runtime.exited = true;
  clearRuntimeHeartbeat(runtime);
  if (runtime.abortController) runtime.abortController.abort();
  if (runtime.pendingPermissionResolvers) {
    for (const resolver of runtime.pendingPermissionResolvers.values()) {
      resolver({ behavior: "deny", message: "Session stopped.", decisionClassification: "user_reject" });
    }
    runtime.pendingPermissionResolvers.clear();
  }
  if (runtime.child && !runtime.child.killed) runtime.child.kill("SIGINT");
  running.delete(sessionId);
}

function clearRuntimeHeartbeat(runtime) {
  if (runtime?.heartbeat) clearInterval(runtime.heartbeat);
  if (runtime) runtime.heartbeat = null;
}

function startTurnHeartbeat(session, runtime) {
  clearRuntimeHeartbeat(runtime);
  runtime.lastOutputAt = now();
  runtime.heartbeatCount = 0;
  runtime.heartbeat = setInterval(() => {
    if (!runtime.currentMessage || now() - runtime.lastOutputAt < 10000) return;
    runtime.heartbeatCount += 1;
    const waitedSeconds = Math.round((now() - runtime.currentMessage.createdAt) / 1000);
    const metadata = { ...runtime.heartbeatMessage?.metadata, type: "thinking", status: "thinking", count: runtime.heartbeatCount, waitedSeconds, turnId: runtime.turnId };
    if (runtime.heartbeatMessage) {
      updateSessionMessage(session, runtime.heartbeatMessage, runtime.heartbeatMessage.content || "", metadata);
    } else {
      appendSessionMessage(session, "tool", "", runtime.agent?.id, metadata).then((created) => {
        runtime.heartbeatMessage = created;
      });
    }
    runtime.lastOutputAt = now();
  }, 5000);
}

async function finishTurnThinking(session, runtime) {
  if (!runtime?.heartbeatMessage) return;
  const durationMs = Math.max(0, now() - (runtime.currentMessage?.createdAt || now()));
  await updateSessionMessage(session, runtime.heartbeatMessage, runtime.heartbeatMessage.content || "", {
    ...runtime.heartbeatMessage.metadata,
    type: "thinking",
    status: "done",
    durationMs,
    turnId: runtime.turnId,
  });
}

async function appendThinkingDelta(session, runtime, text, subject = "正在分析") {
  if (!runtime.heartbeatMessage) {
    runtime.heartbeatMessage = await appendSessionMessage(session, "tool", "", runtime.agent?.id, { type: "thinking", status: "thinking", subject, waitedSeconds: 0, turnId: runtime.turnId });
  }
  const metadata = { ...runtime.heartbeatMessage.metadata, type: "thinking", status: "thinking", subject, turnId: runtime.turnId };
  await appendMessageDelta(session, runtime.heartbeatMessage, text, metadata);
}

function streamPartDelta(runtime, key, value) {
  const text = String(value || "");
  if (!text) return "";
  const previous = runtime.streamParts.get(key) || "";
  runtime.streamParts.set(key, text);
  if (text.startsWith(previous)) return text.slice(previous.length);
  return text;
}

function extractClaudeTextPart(part) {
  if (!part || typeof part !== "object") return "";
  return part.text || part.content || part.delta?.text || part.delta?.content || "";
}

async function handleClaudeSdkStreamEvent(session, runtime, event) {
  const raw = event?.event || {};
  if (!raw || typeof raw !== "object") return;
  if (raw.type === "content_block_start" && raw.content_block?.type === "tool_use") {
    await upsertToolStreamMessage(session, runtime, raw.content_block, "running");
    return;
  }
  if (raw.type !== "content_block_delta") return;
  const delta = raw.delta || {};
  if (delta.type === "text_delta" && delta.text) {
    runtime.usedPartialText = true;
    runtime.finalText += delta.text;
    await appendMessageDelta(session, runtime.currentMessage, delta.text, { ...runtime.currentMessage.metadata, claudeSessionId: session.claudeSessionId || null });
  } else if ((delta.type === "thinking_delta" || delta.type === "signature_delta") && delta.thinking) {
    await appendThinkingDelta(session, runtime, delta.thinking, "正在分析");
  }
}

async function handleClaudeStreamEvent(session, runtime, event) {
  if (!event || typeof event !== "object") return;
  if (event.session_id) session.claudeSessionId = event.session_id;

  if (event.type === "stream_event") {
    await handleClaudeSdkStreamEvent(session, runtime, event);
    return;
  }

  if (event.type === "control_request") {
    if (event.request?.subtype === "can_use_tool") {
      await createToolPermissionRequest(session, runtime, event);
    } else {
      writeClaudeInput(runtime, {
        type: "control_response",
        response: { subtype: "error", request_id: event.request_id, error: `Unsupported control_request subtype: ${event.request?.subtype || "unknown"}` },
      });
    }
    return;
  }

  if (event.type === "system") {
    if (event.subtype === "init") {
      runtime.model = event.model || runtime.model;
      return;
    }
    if (event.subtype === "api_retry") {
      const delaySeconds = Math.max(1, Math.round(Number(event.retry_delay_ms || 0) / 1000));
      await appendThinkingDelta(session, runtime, `API 重试 ${event.attempt}/${event.max_retries}，约 ${delaySeconds}s 后继续。\n`, "连接模型");
    }
    return;
  }

  if (event.type === "assistant" && event.message?.content) {
    const messageId = event.message.id || event.uuid || runtime.turnId;
    for (const [index, part] of event.message.content.entries()) {
      const partType = part?.type || "text";
      const key = `${messageId}:${index}:${partType}`;
      if (partType === "text") {
        if (runtime.usedPartialText) continue;
        const delta = streamPartDelta(runtime, key, extractClaudeTextPart(part));
        runtime.finalText += delta;
        await appendMessageDelta(session, runtime.currentMessage, delta, { ...runtime.currentMessage.metadata, claudeSessionId: session.claudeSessionId || null });
      } else if (partType === "thinking") {
        const delta = streamPartDelta(runtime, key, extractClaudeTextPart(part));
        await appendThinkingDelta(session, runtime, delta, part.subject || "正在分析");
      } else if (partType === "tool_use") {
        await upsertToolStreamMessage(session, runtime, part, "running");
      }
    }
    return;
  }

  if (event.type === "user" && event.message?.content) {
    for (const part of event.message.content) {
      if (part?.type === "tool_result") {
        await upsertToolStreamMessage(session, runtime, part, "completed");
        const permissionRequest = extractPermissionRequestFromToolResult(part);
        if (permissionRequest) await createFallbackToolPermission(session, runtime, permissionRequest);
      }
    }
    return;
  }

  if (event.type === "result") {
    runtime.result = event;
    if (event.session_id) session.claudeSessionId = event.session_id;
    if (!runtime.finalText && event.result) {
      runtime.finalText = String(event.result);
      await appendMessageDelta(session, runtime.currentMessage, runtime.finalText, { ...runtime.currentMessage.metadata, claudeSessionId: session.claudeSessionId || null });
    }
    if (!runtime.sdk && !runtime.completionScheduled) {
      runtime.completionScheduled = true;
      setTimeout(() => {
        completeClaudeTurn(session, runtime, 0).catch((err) => {
          runtime.stderr += `\n[turn completion error] ${err.message}`;
        });
      }, 0);
    }
  }
}

async function upsertToolStreamMessage(session, runtime, part, status) {
  const callId = part.id || part.tool_use_id || part.call_id || part.name || id("tool");
  const existing = runtime.toolMessages.get(callId);
  const name = part.name || part.tool_name || existing?.metadata?.name || "tool";
  const output = part.content || part.output || "";
  const payload = part.input || part.args || existing?.metadata?.input || {};
  const content = status === "completed" ? `${name} 完成${output ? `\n${typeof output === "string" ? output : JSON.stringify(output, null, 2)}` : ""}` : `${name} 运行中\n${JSON.stringify(payload, null, 2)}`;
  const metadata = { type: "tool_call", callId, name, status, input: payload, turnId: runtime.turnId };
  if (existing) {
    await updateSessionMessage(session, existing, content, metadata);
    return;
  }
  const message = await appendSessionMessage(session, "tool", content, runtime.agent?.id, metadata);
  runtime.toolMessages.set(callId, message);
}

function normalizeToolPermissionRequest(request = {}) {
  const toolName = request.tool_name || request.toolName || request.name || request.tool || request.tool_use?.name || request.tool_use_name || "unknown_tool";
  const parsed = parseMcpToolName(toolName);
  const input = request.input || request.tool_input || request.args || request.parameters || request.tool_use?.input || {};
  return {
    toolName,
    serverName: request.server_name || request.serverName || parsed.serverName || "",
    displayName: parsed.toolName || toolName,
    reason: request.decision_reason || request.reason || request.message || request.description || request.error || "Claude Code requested permission to use this tool.",
    input,
  };
}

function extractPermissionRequestFromToolResult(part = {}) {
  const raw = typeof part.content === "string" ? part.content : Array.isArray(part.content) ? part.content.map((item) => item?.text || item?.content || "").join("\n") : "";
  const match = raw.match(/requested permissions to use\s+([A-Za-z0-9_.$:-]+).*haven't granted it yet/i);
  if (!match) return null;
  return {
    tool_name: match[1],
    input: part.input || {},
    reason: raw,
    tool_use_id: part.tool_use_id || part.id,
  };
}

async function createToolPermissionRequest(session, runtime, event) {
  const request = event.request || {};
  const info = normalizeToolPermissionRequest(request);
  if (isToolApprovedByPolicy(session, info.toolName)) {
    writePermissionResponse(runtime, event.request_id, "allow", info.input, request.tool_use_id);
    return null;
  }
  const existing = db.permissions.find((permission) => permission.sessionId === session.id && permission.type === "mcp_tool" && permission.status === "pending" && permission.controlRequestId === event.request_id);
  if (existing) return existing;
  const permission = {
    id: id("perm"),
    sessionId: session.id,
    agentId: session.agentId,
    requestedByUserId: session.createdBy,
    type: "mcp_tool",
    risk: info.toolName.startsWith("mcp__") ? "medium" : "low",
    summary: `Claude Code 请求使用 ${info.serverName ? `${info.serverName} / ` : ""}${info.displayName}`,
    payload: runtime.prompt || "",
    turnId: runtime.turnId,
    status: "pending",
    toolName: info.toolName,
    serverName: info.serverName,
    toolInput: info.input,
    reason: info.reason,
    controlRequestId: event.request_id,
    toolUseId: request.tool_use_id,
    permissionSuggestions: request.permission_suggestions || [],
    expiresAt: now() + 1000 * 60 * 30,
    createdAt: now(),
  };
  db.permissions.push(permission);
  session.status = "waiting_permission";
  runtime.agent.status = "waiting";
  await appendSessionMessage(
    session,
    "tool",
    `${permission.summary}\n${permission.reason}`,
    runtime.agent.id,
    { type: "permission_request", permissionId: permission.id, toolName: permission.toolName, serverName: permission.serverName, turnId: runtime.turnId },
  );
  audit(session.createdBy, "permission.created", "permission", permission.id, { type: permission.type, toolName: permission.toolName, serverName: permission.serverName });
  await saveDb();
  broadcast({ type: "permission.created", sessionId: session.id, permissionId: permission.id });
  broadcast({ type: "session.status.changed", sessionId: session.id, status: session.status });
  return permission;
}

async function createSdkToolPermissionRequest(session, runtime, toolName, input = {}, options = {}) {
  if (toolName === "AskUserQuestion") {
    return {
      behavior: "allow",
      updatedInput: input,
      toolUseID: options.toolUseID,
      decisionClassification: "user_temporary",
    };
  }

  const info = normalizeToolPermissionRequest({
    tool_name: toolName,
    input,
    reason: options.title || options.decisionReason || options.description,
  });
  if (isToolApprovedByPolicy(session, info.toolName)) {
    return {
      behavior: "allow",
      updatedInput: input,
      toolUseID: options.toolUseID,
      decisionClassification: "user_permanent",
    };
  }

  const permission = {
    id: id("perm"),
    sessionId: session.id,
    agentId: session.agentId,
    requestedByUserId: session.createdBy,
    type: "mcp_tool",
    risk: info.toolName.startsWith("mcp__") ? "medium" : "low",
    summary: options.title || `Claude Code 请求使用 ${info.serverName ? `${info.serverName} / ` : ""}${info.displayName}`,
    payload: runtime.prompt || "",
    turnId: runtime.turnId,
    status: "pending",
    toolName: info.toolName,
    serverName: info.serverName,
    toolInput: input || {},
    reason: options.description || options.decisionReason || "Claude Code 请求使用该工具。",
    toolUseId: options.toolUseID,
    permissionSuggestions: options.suggestions || [],
    sdkPermission: true,
    expiresAt: now() + 1000 * 60 * 30,
    createdAt: now(),
  };
  db.permissions.push(permission);
  session.status = "waiting_permission";
  runtime.agent.status = "waiting";
  await appendSessionMessage(
    session,
    "tool",
    `${permission.summary}\n${permission.reason}`,
    runtime.agent.id,
    { type: "permission_request", permissionId: permission.id, toolName: permission.toolName, serverName: permission.serverName, turnId: runtime.turnId },
  );
  audit(session.createdBy, "permission.created", "permission", permission.id, { type: permission.type, toolName: permission.toolName, serverName: permission.serverName, sdkPermission: true });
  await saveDb();
  broadcast({ type: "permission.created", sessionId: session.id, permissionId: permission.id });
  broadcast({ type: "session.status.changed", sessionId: session.id, status: session.status });

  return new Promise((resolvePermission) => {
    runtime.pendingPermissionResolvers.set(permission.id, resolvePermission);
    options.signal?.addEventListener?.("abort", () => {
      if (!runtime.pendingPermissionResolvers.has(permission.id)) return;
      runtime.pendingPermissionResolvers.delete(permission.id);
      resolvePermission({
        behavior: "deny",
        message: "Permission request was aborted.",
        toolUseID: permission.toolUseId,
        decisionClassification: "user_reject",
      });
    }, { once: true });
  });
}

async function createFallbackToolPermission(session, runtime, request) {
  const info = normalizeToolPermissionRequest(request);
  if (db.permissions.some((permission) => permission.sessionId === session.id && permission.turnId === runtime.turnId && permission.status === "pending" && permission.toolName === info.toolName)) return null;
  const permission = {
    id: id("perm"),
    sessionId: session.id,
    agentId: session.agentId,
    requestedByUserId: session.createdBy,
    type: "mcp_tool",
    risk: "medium",
    summary: `Claude Code 请求使用 ${info.serverName ? `${info.serverName} / ` : ""}${info.displayName}`,
    payload: "继续上一轮任务。",
    turnId: runtime.turnId,
    status: "pending",
    toolName: info.toolName,
    serverName: info.serverName,
    toolInput: info.input,
    reason: info.reason || "Claude Code 工具结果提示尚未授权。",
    toolUseId: request.tool_use_id,
    fallbackResume: true,
    expiresAt: now() + 1000 * 60 * 30,
    createdAt: now(),
  };
  db.permissions.push(permission);
  await appendSessionMessage(
    session,
    "tool",
    `${permission.summary}\n${permission.reason}`,
    runtime.agent.id,
    { type: "permission_request", permissionId: permission.id, toolName: permission.toolName, serverName: permission.serverName, turnId: runtime.turnId },
  );
  audit(session.createdBy, "permission.created", "permission", permission.id, { type: permission.type, toolName: permission.toolName, serverName: permission.serverName, fallbackResume: true });
  broadcast({ type: "permission.created", sessionId: session.id, permissionId: permission.id });
  return permission;
}

function writePermissionResponse(runtime, requestId, behavior, updatedInput = undefined, toolUseId = undefined, message = undefined) {
  const response = { behavior };
  if (behavior === "allow") {
    if (updatedInput !== undefined) response.updatedInput = updatedInput;
  } else {
    response.message = message || "User denied permission";
  }
  if (toolUseId) response.toolUseID = toolUseId;
  return writeClaudeInput(runtime, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response,
    },
  });
}

async function completeClaudeTurn(session, runtime, code = 0) {
  if (!runtime.currentMessage || runtime.turnCompleted) return;
  runtime.turnCompleted = true;
  clearRuntimeHeartbeat(runtime);
  if (runtime.streamQueue) await runtime.streamQueue;
  if (runtime.streamBuffer !== undefined) await flushClaudeStreamBuffer(session, runtime);
  await finishTurnThinking(session, runtime);
  const resultText = runtime.finalText || runtime.result?.result || runtime.result?.message || "";
  if (!String(runtime.currentMessage.content || "").trim()) {
    await updateSessionMessage(session, runtime.currentMessage, resultText || (code === 0 ? "Claude Code 本轮没有返回文本。" : runtime.stderr.trim() || `Claude Code exited with code ${code}.`), { ...runtime.currentMessage.metadata, claudeSessionId: session.claudeSessionId || null });
  } else {
    await updateSessionMessage(session, runtime.currentMessage, runtime.currentMessage.content, { ...runtime.currentMessage.metadata, claudeSessionId: session.claudeSessionId || null });
  }
  const existingPendingPermission = db.permissions.find((permission) => permission.sessionId === session.id && permission.turnId === runtime.turnId && permission.status === "pending");
  session.status = existingPendingPermission ? "waiting_permission" : code === 0 && !runtime.result?.is_error ? "completed" : "failed";
  if (session.status !== "waiting_permission") clearOnceToolApprovals(session);
  runtime.agent.status = "idle";
  await appendSessionMessage(
    session,
    "tool",
    session.status === "waiting_permission" ? "本轮等待用户确认后继续。" : session.status === "completed" ? "本轮完成，可继续发送下一轮。" : `本轮失败，退出码：${code}`,
    runtime.agent.id,
    { type: "exit", code, claudeSessionId: session.claudeSessionId || null, turnId: runtime.turnId },
  );
  runtime.currentMessage = null;
  runtime.heartbeatMessage = null;
  runtime.turnId = null;
  runtime.prompt = "";
  runtime.result = null;
  runtime.finalText = "";
  runtime.stderr = "";
  runtime.streamParts = new Map();
  runtime.toolMessages = new Map();
  runtime.pendingPermissionResolvers?.clear();
  await saveDb();
  broadcast({ type: "session.status.changed", sessionId: session.id, status: session.status });
}

async function consumeClaudeStreamChunk(session, runtime, chunk) {
  runtime.streamBuffer += chunk.toString();
  const lines = runtime.streamBuffer.split(/\r?\n/);
  runtime.streamBuffer = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      await handleClaudeStreamEvent(session, runtime, JSON.parse(trimmed));
    } catch (err) {
      runtime.stderr += `\n[stream parse error] ${err.message}: ${trimmed.slice(0, 300)}`;
    }
  }
}

async function flushClaudeStreamBuffer(session, runtime) {
  const trimmed = runtime.streamBuffer.trim();
  runtime.streamBuffer = "";
  if (!trimmed) return;
  try {
    await handleClaudeStreamEvent(session, runtime, JSON.parse(trimmed));
  } catch (err) {
    runtime.stderr += `\n[stream parse error] ${err.message}: ${trimmed.slice(0, 300)}`;
  }
}

function resolvePosixCommandPath(command) {
  if (!command) return null;
  if ((isAbsolute(command) || command.includes("/")) && existsSync(command)) return command;
  try {
    return execFileSync("which", [command], { encoding: "utf8" }).trim().split(/\r?\n/)[0] || command;
  } catch {
    return command;
  }
}

function claudeSdkLaunchOptions(command) {
  if (IS_WINDOWS) {
    const resolved = resolveWindowsCli(command, []);
    if (resolved?.command === process.execPath && resolved.args?.[0]) {
      return { pathToClaudeCodeExecutable: resolved.args[0], executable: "node" };
    }
    return { pathToClaudeCodeExecutable: resolved?.command || command };
  }
  const resolved = resolvePosixCommandPath(command);
  return resolved?.endsWith(".js")
    ? { pathToClaudeCodeExecutable: resolved, executable: "node" }
    : { pathToClaudeCodeExecutable: resolved || command };
}

function cliArgsToExtraArgs(args) {
  const extraArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 2) {
      extraArgs[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("-")) {
      extraArgs[key] = null;
    } else {
      extraArgs[key] = next;
      index += 1;
    }
  }
  return extraArgs;
}

async function submitClaudeTurn(session, prompt, turnId) {
  const agent = db.agents.find((item) => item.id === session.agentId);
  const message = await appendAgentMessage(session, agent, "", { turnId });
  session.status = "running";
  session.updatedAt = now();
  agent.status = "running";
  await saveDb();
  broadcast({ type: "session.status.changed", sessionId: session.id, status: session.status });

  const abortController = new AbortController();
  const runtime = {
    sdk: true,
    abortController,
    agent,
    currentMessage: message,
    turnId,
    prompt,
    lastOutputAt: now(),
    heartbeat: null,
    heartbeatCount: 0,
    heartbeatMessage: await appendSessionMessage(session, "tool", "", agent.id, { type: "thinking", status: "thinking", subject: "正在分析", waitedSeconds: 0, turnId }),
    streamParts: new Map(),
    toolMessages: new Map(),
    pendingPermissionResolvers: new Map(),
    result: null,
    finalText: "",
    stderr: "",
    exited: false,
    turnCompleted: false,
    usedPartialText: false,
  };
  running.set(session.id, runtime);
  startTurnHeartbeat(session, runtime);

  const extraArgs = sanitizeClaudeExtraArgs(String(db.claudeConfig.args || "").split(" ").filter(Boolean));
  const sdkLaunch = claudeSdkLaunchOptions(db.claudeConfig.command);
  const sdkOptions = {
    abortController,
    cwd: session.cwd,
    env: { ...process.env, TERM: "xterm-256color" },
    includePartialMessages: true,
    allowedTools: approvedToolSpecs(session),
    extraArgs: cliArgsToExtraArgs(extraArgs),
    ...(session.claudeSessionId ? { resume: session.claudeSessionId } : {}),
    ...sdkLaunch,
    canUseTool: (toolName, input, options) => createSdkToolPermissionRequest(session, runtime, toolName, input, options),
  };
  await mkdir(session.cwd, { recursive: true });
  await appendSessionMessage(
    session,
    "tool",
    `${session.claudeSessionId ? "恢复 Claude Code SDK 会话" : "启动 Claude Code SDK 会话"}\ncommand: ${sdkLaunch.pathToClaudeCodeExecutable || db.claudeConfig.command}\nallowedTools: ${sdkOptions.allowedTools.length ? sdkOptions.allowedTools.join(", ") : "(none)"}\ncwd: ${session.cwd}`,
    agent.id,
    { type: "command", command: sdkLaunch.pathToClaudeCodeExecutable || db.claudeConfig.command, args: sdkOptions.allowedTools, cwd: session.cwd, claudeSessionId: session.claudeSessionId || null, runtime: "sdk" },
  );

  try {
    for await (const event of query({ prompt, options: sdkOptions })) {
      runtime.lastOutputAt = now();
      await handleClaudeStreamEvent(session, runtime, event);
    }
    await completeClaudeTurn(session, runtime, 0);
  } catch (err) {
    runtime.stderr += `\n${err.message || String(err)}`;
    if (runtime.currentMessage && !runtime.turnCompleted) {
      await updateSessionMessage(session, runtime.currentMessage, `[agent error] ${err.message || String(err)}`, { ...runtime.currentMessage.metadata, error: err.message || String(err) });
      await completeClaudeTurn(session, runtime, 1);
    }
    broadcast({ type: "agent.error", sessionId: session.id, message: err.message || String(err) });
  } finally {
    runtime.exited = true;
    clearRuntimeHeartbeat(runtime);
    if (getRuntime(session.id) === runtime) running.delete(session.id);
    agent.status = "idle";
    await saveDb();
    broadcast({ type: "session.status.changed", sessionId: session.id, status: session.status });
  }
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/health") return send(res, 200, { ok: true });

  if (pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readBody(req);
    const user = db.users.find((item) => item.username === body.username);
    if (!user || !verifyPassword(body.password || "", user.passwordHash)) {
      audit(user?.id, "auth.login_failed", "user", user?.id, { username: body.username });
      await saveDb();
      return error(res, 401, "AUTH_INVALID_CREDENTIALS", "Invalid username or password.");
    }
    if (user.status !== "active") return error(res, 403, "AUTH_USER_DISABLED", "User is disabled.");
    const token = randomBytes(32).toString("hex");
    db.sessionsByToken[token] = { userId: user.id, expiresAt: now() + SESSION_TTL_MS };
    user.lastLoginAt = now();
    audit(user.id, "auth.login", "user", user.id);
    await saveDb();
    return send(res, 200, { user: publicUser(user) }, { "Set-Cookie": `cc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` });
  }

  const user = getCurrentUser(req);
  if (!user) return error(res, 401, "AUTH_REQUIRED", "Please log in.");

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const token = parseCookies(req).cc_session;
    delete db.sessionsByToken[token];
    await saveDb();
    return send(res, 200, { ok: true }, { "Set-Cookie": "cc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }

  if (pathname === "/api/auth/password" && req.method === "PATCH") {
    const body = await readBody(req);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (!verifyPassword(currentPassword, user.passwordHash)) return error(res, 400, "PASSWORD_CURRENT_INVALID", "Current password is incorrect.");
    if (newPassword.trim().length < 6) return error(res, 400, "PASSWORD_WEAK", "Password must be at least 6 characters.");
    user.passwordHash = hashPassword(newPassword);
    user.updatedAt = now();
    revokeSessionsForUser(user.id, parseCookies(req).cc_session);
    audit(user.id, "user.password_changed", "user", user.id);
    await saveDb();
    return send(res, 200, { ok: true });
  }

  if (pathname === "/api/bootstrap") return send(res, 200, bootstrapFor(user));

  if (pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("data: {\"type\":\"connected\"}\n\n");
    const client = { res, userId: user.id };
    clients.add(client);
    req.on("close", () => clients.delete(client));
    return;
  }

  if (pathname === "/api/teams" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const workspacePath = assertWorkspaceAllowed(body.workspacePath);
      const team = { id: id("team"), name: body.name, workspacePath, workspaceMode: "shared", createdBy: user.id, createdAt: now(), updatedAt: now() };
      const agent = { id: id("agent"), teamId: team.id, name: "Claude Code", type: "claude_code", command: db.claudeConfig.command, enabled: true, status: "idle", createdAt: now(), updatedAt: now() };
      db.teams.push(team);
      db.members.push({ teamId: team.id, userId: user.id, role: "owner", createdAt: now(), updatedAt: now() });
      db.agents.push(agent);
      audit(user.id, "team.created", "team", team.id);
      await saveDb();
      broadcast({ type: "team.created", teamId: team.id });
      return send(res, 201, { team });
    } catch (err) {
      return error(res, 400, err.code || "WORKSPACE_PATH_INVALID", "Workspace path must be inside the configured allowlist.");
    }
  }

  const teamMatch = pathname.match(/^\/api\/teams\/([^/]+)$/);
  if (teamMatch && req.method === "PATCH") {
    const teamId = teamMatch[1];
    if (!canManageTeam(user, teamId)) return error(res, 403, "PERMISSION_DENIED", "Cannot update this team.");
    const team = db.teams.find((item) => item.id === teamId);
    if (!team) return error(res, 404, "TEAM_NOT_FOUND", "Team not found.");
    const body = await readBody(req);
    try {
      if (body.name) team.name = String(body.name);
      if (body.workspacePath) {
        const workspacePath = assertWorkspaceAllowed(body.workspacePath);
        team.workspacePath = workspacePath;
        for (const session of db.sessions.filter((item) => item.teamId === teamId && item.status !== "running")) {
          session.cwd = workspacePath;
          session.updatedAt = now();
        }
      }
      team.updatedAt = now();
      audit(user.id, "team.updated", "team", teamId, { workspacePath: team.workspacePath });
      await saveDb();
      broadcast({ type: "team.updated", teamId });
      return send(res, 200, { team });
    } catch (err) {
      return error(res, 400, err.code || "WORKSPACE_PATH_INVALID", "Workspace path must be inside the configured allowlist.");
    }
  }

  const memberMatch = pathname.match(/^\/api\/teams\/([^/]+)\/members$/);
  if (memberMatch && req.method === "POST") {
    const teamId = memberMatch[1];
    if (!canManageTeam(user, teamId)) return error(res, 403, "PERMISSION_DENIED", "Cannot manage this team.");
    const body = await readBody(req);
    if (!db.members.some((item) => item.teamId === teamId && item.userId === body.userId)) {
      db.members.push({ teamId, userId: body.userId, role: body.role, createdAt: now(), updatedAt: now() });
      audit(user.id, "team.member_added", "team", teamId, { addedUserId: body.userId, role: body.role });
      await saveDb();
      broadcast({ type: "team.member_added", teamId });
    }
    return send(res, 200, { ok: true });
  }

  const sessionMatch = pathname.match(/^\/api\/teams\/([^/]+)\/sessions$/);
  if (sessionMatch && req.method === "POST") {
    const teamId = sessionMatch[1];
    if (!canWriteTeam(user, teamId)) return error(res, 403, "PERMISSION_DENIED", "Cannot create sessions.");
    const team = db.teams.find((item) => item.id === teamId);
    const agent = db.agents.find((item) => item.teamId === teamId && item.type === "claude_code");
    const session = { id: id("session"), teamId, agentId: agent.id, createdBy: user.id, title: "新会话", status: "idle", cwd: team.workspacePath, createdAt: now(), updatedAt: now() };
    db.sessions.unshift(session);
    db.messages.push({ id: id("msg"), sessionId: session.id, senderType: "system", senderId: null, content: "会话已创建，等待用户发送任务。", createdAt: now() });
    audit(user.id, "session.created", "session", session.id);
    await saveDb();
    broadcast({ type: "session.created", sessionId: session.id });
    return send(res, 201, { session });
  }

  const deleteSessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (deleteSessionMatch && req.method === "DELETE") {
    const session = db.sessions.find((item) => item.id === deleteSessionMatch[1]);
    if (!canWriteSession(user, session)) return error(res, 403, "PERMISSION_DENIED", "Cannot delete this session.");
    const runtime = getRuntime(session.id);
    if (runtime) stopRuntime(session.id);
    db.sessions = db.sessions.filter((item) => item.id !== session.id);
    db.messages = db.messages.filter((message) => message.sessionId !== session.id);
    db.permissions = db.permissions.filter((permission) => permission.sessionId !== session.id);
    db.fileChanges = db.fileChanges.filter((file) => file.sessionId !== session.id);
    audit(user.id, "session.deleted", "session", session.id);
    await saveDb();
    broadcast({ type: "session.deleted", sessionId: session.id });
    return send(res, 200, { ok: true });
  }

  const messageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messageMatch && req.method === "POST") {
    const session = db.sessions.find((item) => item.id === messageMatch[1]);
    if (!canWriteSession(user, session)) return error(res, 403, "PERMISSION_DENIED", "Cannot send messages.");
    const body = await readBody(req);
    const content = String(body.content || "").trim();
    if (!content) return error(res, 400, "MESSAGE_EMPTY", "Message cannot be empty.");
    if (["running", "waiting_permission"].includes(session.status)) return error(res, 409, "SESSION_BUSY", "This conversation turn is already running.");
    const turnId = id("turn");
    if (session.title === "新会话") session.title = titleFromPrompt(content);
    session.updatedAt = now();
    db.messages.push({ id: id("msg"), sessionId: session.id, senderType: "user", senderId: user.id, content, metadata: { turnId }, createdAt: now() });
    audit(user.id, "session.message_sent", "session", session.id);
    if (needsApproval(content)) {
      const permission = { id: id("perm"), sessionId: session.id, agentId: session.agentId, requestedByUserId: user.id, type: "platform_gate", risk: "medium", summary: "任务可能执行敏感操作，需要审批后再交给 Claude Code CLI", payload: content, turnId, status: "pending", expiresAt: now() + 1000 * 60 * 30, createdAt: now() };
      db.permissions.push(permission);
      session.status = "waiting_permission";
      audit(user.id, "permission.created", "permission", permission.id);
      await saveDb();
      broadcast({ type: "permission.created", sessionId: session.id, permissionId: permission.id });
    } else {
      await saveDb();
      submitClaudeTurn(session, content, turnId);
    }
    return send(res, 201, { ok: true });
  }

  const stopMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
  if (stopMatch && req.method === "POST") {
    const session = db.sessions.find((item) => item.id === stopMatch[1]);
    if (!canWriteSession(user, session)) return error(res, 403, "PERMISSION_DENIED", "Cannot stop sessions.");
    stopRuntime(session.id);
    session.status = "stopped";
    const agent = db.agents.find((item) => item.id === session.agentId);
    if (agent) agent.status = "idle";
    audit(user.id, "session.stopped", "session", session.id);
    await saveDb();
    broadcast({ type: "session.status.changed", sessionId: session.id, status: session.status });
    return send(res, 200, { ok: true });
  }

  const permissionMatch = pathname.match(/^\/api\/permissions\/([^/]+)\/(approve|reject)$/);
  if (permissionMatch && req.method === "POST") {
    const permission = db.permissions.find((item) => item.id === permissionMatch[1]);
    if (!permission || !canApprove(user, permission)) return error(res, 403, "PERMISSION_DENIED", "Cannot decide this permission.");
    const body = await readBody(req);
    const decision = String(body.decision || (permissionMatch[2] === "approve" ? "allow_once" : "rejected"));
    permission.status = permissionMatch[2] === "approve" ? "approved" : "rejected";
    permission.decidedBy = user.id;
    permission.decidedAt = now();
    permission.decision = decision;
    const session = db.sessions.find((item) => item.id === permission.sessionId);
    const runtime = session ? getRuntime(session.id) : null;
    if (permission.status === "approved" && permission.type === "mcp_tool") {
      if (!permission.controlRequestId || decision !== "allow_once") applyToolApproval(session, permission, decision);
      if (permission.sdkPermission) {
        const resolver = runtime?.pendingPermissionResolvers?.get(permission.id);
        if (!resolver) {
          permission.status = "pending";
          permission.decidedBy = undefined;
          permission.decidedAt = undefined;
          permission.decision = undefined;
          return error(res, 409, "PERMISSION_RUNTIME_MISSING", "Claude Code is no longer waiting for this permission.");
        }
        runtime.pendingPermissionResolvers.delete(permission.id);
        resolver({
          behavior: "allow",
          updatedInput: permission.toolInput || {},
          updatedPermissions: permissionUpdatesForDecision(permission, decision, permission.permissionSuggestions || []),
          toolUseID: permission.toolUseId,
          decisionClassification: permissionClassification(decision, true),
        });
        session.status = "running";
        runtime.agent.status = "running";
      } else if (permission.controlRequestId && (!runtime || !writePermissionResponse(runtime, permission.controlRequestId, "allow", permission.toolInput || {}, permission.toolUseId))) {
        permission.status = "pending";
        permission.decidedBy = undefined;
        permission.decidedAt = undefined;
        permission.decision = undefined;
        return error(res, 409, "PERMISSION_RUNTIME_MISSING", "Claude Code is no longer waiting for this permission.");
      }
      if (permission.controlRequestId && !permission.sdkPermission) {
        session.status = "running";
        runtime.agent.status = "running";
      }
    }
    if (permission.status === "rejected" && permission.type === "mcp_tool") {
      if (permission.sdkPermission) {
        const resolver = runtime?.pendingPermissionResolvers?.get(permission.id);
        if (resolver) {
          runtime.pendingPermissionResolvers.delete(permission.id);
          resolver({
            behavior: "deny",
            message: "User denied permission",
            toolUseID: permission.toolUseId,
            decisionClassification: permissionClassification(decision, false),
          });
        }
        session.status = "running";
        if (runtime?.agent) runtime.agent.status = "running";
      } else if (runtime && permission.controlRequestId) writePermissionResponse(runtime, permission.controlRequestId, "deny", undefined, permission.toolUseId, "User denied permission");
      if (permission.controlRequestId || permission.sdkPermission) {
        session.status = "running";
        if (runtime?.agent) runtime.agent.status = "running";
      } else {
        session.status = "stopped";
      }
    }
    db.messages.push({ id: id("msg"), sessionId: session.id, senderType: "system", senderId: null, content: `权限请求已${permission.status === "approved" ? "批准" : "拒绝"}：${permission.summary}`, metadata: { turnId: permission.turnId, decision }, createdAt: now() });
    audit(user.id, `permission.${permission.status}`, "permission", permission.id);
    await saveDb();
    broadcast({ type: "permission.updated", sessionId: session.id, permissionId: permission.id, status: permission.status });
    if (permission.type === "platform_gate" && permission.status === "approved") submitClaudeTurn(session, permission.payload, permission.turnId);
    else if (permission.type === "mcp_tool" && permission.status === "approved" && !permission.controlRequestId && !permission.sdkPermission) {
      const nextTurnId = id("turn");
      const payload = permission.payload || "继续上一轮任务。";
      stopRuntime(session.id);
      await saveDb();
      submitClaudeTurn(session, payload, nextTurnId);
    }
    else if (permission.type === "platform_gate") {
      session.status = "stopped";
      await saveDb();
    }
    return send(res, 200, { ok: true });
  }

  if (pathname === "/api/users" && req.method === "POST") {
    if (user.role !== "admin") return error(res, 403, "PERMISSION_DENIED", "Admin required.");
    const body = await readBody(req);
    if (!String(body.password || "").trim()) return error(res, 400, "PASSWORD_REQUIRED", "Initial password is required.");
    if (db.users.some((item) => item.username === body.username)) return error(res, 409, "USER_EXISTS", "Username already exists.");
    const newUser = { id: id("user"), username: body.username, passwordHash: hashPassword(body.password), displayName: body.displayName, email: body.email || `${body.username}@example.com`, role: body.role || "member", status: "active", createdAt: now(), updatedAt: now() };
    db.users.push(newUser);
    audit(user.id, "user.created", "user", newUser.id);
    await saveDb();
    return send(res, 201, { user: publicUser(newUser) });
  }

  const userStatusMatch = pathname.match(/^\/api\/users\/([^/]+)\/status$/);
  if (userStatusMatch && req.method === "PATCH") {
    if (user.role !== "admin") return error(res, 403, "PERMISSION_DENIED", "Admin required.");
    const target = db.users.find((item) => item.id === userStatusMatch[1]);
    if (!target || target.id === user.id) return error(res, 400, "USER_STATUS_INVALID", "Cannot update this user.");
    target.status = target.status === "active" ? "disabled" : "active";
    target.updatedAt = now();
    audit(user.id, "user.status_changed", "user", target.id);
    await saveDb();
    return send(res, 200, { user: publicUser(target) });
  }

  const userPasswordMatch = pathname.match(/^\/api\/users\/([^/]+)\/password$/);
  if (userPasswordMatch && req.method === "PATCH") {
    if (user.role !== "admin") return error(res, 403, "PERMISSION_DENIED", "Admin required.");
    const target = db.users.find((item) => item.id === userPasswordMatch[1]);
    if (!target) return error(res, 404, "USER_NOT_FOUND", "User not found.");
    const body = await readBody(req);
    const newPassword = String(body.newPassword || "");
    if (newPassword.trim().length < 6) return error(res, 400, "PASSWORD_WEAK", "Password must be at least 6 characters.");
    target.passwordHash = hashPassword(newPassword);
    target.updatedAt = now();
    revokeSessionsForUser(target.id, target.id === user.id ? parseCookies(req).cc_session : null);
    audit(user.id, "user.password_reset", "user", target.id);
    await saveDb();
    return send(res, 200, { user: publicUser(target) });
  }

  if (pathname === "/api/claude/config" && req.method === "PATCH") {
    if (user.role !== "admin") return error(res, 403, "PERMISSION_DENIED", "Admin required.");
    const body = await readBody(req);
    db.claudeConfig.command = body.command || db.claudeConfig.command;
    db.claudeConfig.args = body.args || "";
    db.claudeConfig.workspaceRoot = body.workspaceRoot || db.claudeConfig.workspaceRoot;
    audit(user.id, "claude.config_updated", "agent", "claude_code");
    await saveDb();
    return send(res, 200, { claudeConfig: db.claudeConfig });
  }

  if (pathname === "/api/claude/health-check" && req.method === "POST") {
    if (user.role !== "admin") return error(res, 403, "PERMISSION_DENIED", "Admin required.");
    const result = await healthCheck();
    Object.assign(db.claudeConfig, result, { lastCheckAt: now() });
    audit(user.id, "claude.health_check", "agent", "claude_code", result);
    await saveDb();
    return send(res, 200, db.claudeConfig);
  }

  return error(res, 404, "NOT_FOUND", "API route not found.");
}

async function serveStatic(req, res, pathname) {
  const filePath = pathname === "/" ? join(root, "index.html") : join(root, normalize(pathname));
  if (!filePath.startsWith(root)) return error(res, 403, "PATH_FORBIDDEN", "Forbidden.");
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not file");
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(filePath).pipe(res);
  } catch {
    createReadStream(join(root, "index.html")).pipe(res);
  }
}

await loadDb();
await syncRuntimeConfigFromEnv();
await maybeResetAdminPassword();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname);
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    return error(res, 500, "INTERNAL_ERROR", "Internal server error.");
  }
}).listen(PORT, HOST, () => {
  console.log(`Claude Code Team Platform listening on ${HOST}:${PORT}`);
});

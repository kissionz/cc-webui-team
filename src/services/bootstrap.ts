import type { AppConfig } from "../config.js";
import { createId, type Agent, type ClaudeConfig, type ConversationSession, type Message, type Team, type TeamMember, type User } from "../domain/index.js";
import { hashPassword } from "../auth/passwords.js";
import type { PersistenceRepository } from "../persistence/index.js";

export async function ensureInitialData(repository: PersistenceRepository, config: AppConfig): Promise<void> {
  if (repository.listUsers().length > 0) {
    ensureClaudeConfig(repository, config);
    await applyExplicitEnvironmentResets(repository, config);
    return;
  }
  if (config.adminPassword === "admin123" && config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    throw new Error("ADMIN_PASSWORD must be set before binding the service beyond localhost.");
  }
  const createdAt = Date.now();
  const admin: User = {
    id: "user_admin",
    username: "admin",
    passwordHash: await hashPassword(config.adminPassword),
    displayName: "System Admin",
    email: "admin@example.com",
    role: "admin",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  };
  const team: Team = {
    id: "team_platform",
    name: "Claude Code Platform",
    workspacePath: config.workspaceRoot,
    workspaceMode: "shared",
    createdBy: admin.id,
    createdAt,
    updatedAt: createdAt,
  };
  const member: TeamMember = {
    teamId: team.id,
    userId: admin.id,
    role: "owner",
    createdAt,
    updatedAt: createdAt,
  };
  const demoUsers = config.seedDemoUsers ? await createDemoUsers(createdAt) : [];
  const demoMembers: TeamMember[] = demoUsers.map((user, index) => ({
    teamId: team.id,
    userId: user.id,
    role: index === 0 ? "admin" : index === 1 ? "member" : "viewer",
    createdAt,
    updatedAt: createdAt,
  }));
  const agent: Agent = {
    id: "agent_claude",
    teamId: team.id,
    name: "Claude Code",
    type: "claude_code",
    command: config.claudeCommand,
    enabled: true,
    status: "idle",
    metadata: {},
    createdAt,
    updatedAt: createdAt,
  };
  const welcomeSession: ConversationSession = {
    id: "session_welcome",
    teamId: team.id,
    agentId: agent.id,
    createdBy: admin.id,
    title: "部署后的第一条 Claude Code 会话",
    summary: null,
    summaryUpdatedAt: null,
    visibility: "private",
    status: "idle",
    cwd: config.workspaceRoot,
    claudeSessionId: null,
    toolApprovals: { onceTools: [], alwaysTools: [], alwaysServers: [] },
    archivedAt: null,
    pinnedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
  const welcomeMessage: Message = {
    id: "message_welcome",
    sessionId: welcomeSession.id,
    senderType: "system",
    senderId: null,
    content: "服务端已启动。发送消息后，系统会在团队工作区中运行 Claude Code。",
    metadata: {},
    createdAt,
    updatedAt: null,
  };
  repository.transaction(() => {
    repository.saveUser(admin);
    for (const user of demoUsers) repository.saveUser(user);
    repository.saveTeam(team);
    repository.saveTeamMember(member);
    for (const demoMember of demoMembers) repository.saveTeamMember(demoMember);
    repository.saveAgent(agent);
    repository.createSession(welcomeSession);
    repository.appendMessage(welcomeMessage);
    repository.appendAuditLog({
      id: createId("audit"),
      userId: admin.id,
      action: "system.initialized",
      targetType: "system",
      targetId: "platform",
      metadata: {},
      createdAt,
    });
  });
  ensureClaudeConfig(repository, config);
  await applyExplicitEnvironmentResets(repository, config);
}

async function createDemoUsers(createdAt: number): Promise<User[]> {
  const passwordHash = await hashPassword("password");
  return [
    { id: "user_alice", username: "alice", passwordHash, displayName: "Alice Chen", email: "alice@example.com", role: "member", status: "active", createdAt, updatedAt: createdAt },
    { id: "user_bob", username: "bob", passwordHash, displayName: "Bob Lin", email: "bob@example.com", role: "member", status: "active", createdAt, updatedAt: createdAt },
    { id: "user_viewer", username: "viewer", passwordHash, displayName: "Viewer", email: "viewer@example.com", role: "member", status: "active", createdAt, updatedAt: createdAt },
  ];
}

async function applyExplicitEnvironmentResets(repository: PersistenceRepository, config: AppConfig): Promise<void> {
  const updatedAt = Date.now();
  if (process.env.RESET_ADMIN_PASSWORD === "true") {
    const admin = repository.getUserByUsername("admin");
    if (admin) {
      repository.saveUser({ ...admin, passwordHash: await hashPassword(config.adminPassword), updatedAt });
      repository.revokeAuthSessionsForUser(admin.id);
      repository.appendAuditLog({
        id: createId("audit"),
        userId: admin.id,
        action: "user.admin_password_reset_from_env",
        targetType: "user",
        targetId: admin.id,
        metadata: {},
        createdAt: updatedAt,
      });
    }
  }

  if (process.env.RESET_DEFAULT_TEAM_WORKSPACE === "true" && process.env.WORKSPACE_ROOT) {
    const team = repository.getTeam("team_platform");
    if (team) repository.saveTeam({ ...team, workspacePath: config.workspaceRoot, updatedAt });
    const welcome = repository.getSession("session_welcome");
    if (welcome) repository.saveSession({ ...welcome, cwd: config.workspaceRoot, updatedAt });
  }
}

function ensureClaudeConfig(repository: PersistenceRepository, config: AppConfig): ClaudeConfig {
  const existing = repository.getClaudeConfig();
  if (existing) return existing;
  const value: ClaudeConfig = {
    command: config.claudeCommand,
    args: config.claudeArgs.join(" "),
    workspaceRoot: config.workspaceRoot,
    modelContextTokens: config.modelContextTokens,
    autoCompactRatio: config.autoCompactRatio,
    autoCompactEnabled: config.autoCompactEnabled,
    mcpToolAllowlist: config.mcpToolAllowlist,
    enabled: true,
    available: false,
    version: "unknown",
    latencyMs: 0,
    authenticated: false,
    lastCheckAt: null,
    healthMessage: null,
    updatedAt: Date.now(),
  };
  repository.saveClaudeConfig(value);
  return value;
}

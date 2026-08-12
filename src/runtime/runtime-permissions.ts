import type { Options as ClaudeOptions, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeConfig, Message, Permission, PermissionDecision, ToolApprovals } from "../domain/models.js";
import { evaluatePermissionDecision, type PermissionDecision as SafePermissionDecision } from "../security/permissions.js";
import type {
  CreateMessageInput,
  PermissionResolution,
  RuntimeEvent,
  SessionRuntimeStore,
} from "./runtime-contracts.js";
import { isToolApproved, parseMcpToolName, permissionUpdates, toJsonObject, toJsonValue } from "./runtime-helpers.js";
import type { ActiveRuntime } from "./runtime-state.js";

export interface RuntimePermissionBrokerOptions {
  store: SessionRuntimeStore;
  getRuntime: (sessionId: string) => ActiveRuntime | undefined;
  publish: (event: RuntimeEvent) => Promise<void>;
  createMessage: (input: CreateMessageInput) => Promise<Message>;
  now: () => number;
  idFactory: () => string;
  permissionTtlMs: number;
}

/** Owns the SDK permission handshake and its compare-and-set persistence. */
export class RuntimePermissionBroker {
  constructor(private readonly options: RuntimePermissionBrokerOptions) {}

  async decide(permissionId: string, decision: unknown, decidedBy: string): Promise<PermissionResolution> {
    const permission = await this.options.store.getPermission(permissionId);
    if (!permission) return { ok: false, reason: "not_found" };
    const evaluated = evaluatePermissionDecision(permission, decision, this.options.now());
    if (!evaluated.ok) return { ok: false, reason: evaluated.reason };
    const toolDecision: PermissionDecision = evaluated.decision === "approved" ? "allow_once" : evaluated.decision;
    const runtime = this.options.getRuntime(permission.sessionId);
    const resolver = runtime?.pendingPermissionResolvers.get(permission.id);
    if (!runtime || !resolver) return { ok: false, reason: "runtime_missing" };
    const persisted = await this.options.store.decidePermission(
      permission.id,
      toolDecision,
      evaluated.status,
      decidedBy,
      evaluated.decidedAt,
    );
    if (!persisted) return { ok: false, reason: "already_decided" };
    runtime.pendingPermissionResolvers.delete(permission.id);

    if (evaluated.status === "approved") {
      const session = await this.options.store.getSession(permission.sessionId);
      if (session) {
        const approvals = applyApproval(session.toolApprovals, permission, toolDecision);
        await this.options.store.updateToolApprovals(session.id, approvals);
        runtime.session.toolApprovals = approvals;
      }
      resolver({
        behavior: "allow",
        updatedInput: permission.toolInput,
        updatedPermissions: permissionUpdates(permission, toolDecision),
        ...(permission.toolUseId ? { toolUseID: permission.toolUseId } : {}),
        decisionClassification: toolDecision === "allow_once" ? "user_temporary" : "user_permanent",
      });
    } else {
      resolver({
        behavior: "deny",
        message: "User denied permission",
        ...(permission.toolUseId ? { toolUseID: permission.toolUseId } : {}),
        decisionClassification: "user_reject",
      });
    }
    await this.options.store.updateSession(permission.sessionId, { status: "running", updatedAt: this.options.now() });
    await this.options.store.updateAgent(permission.agentId, { status: "running", updatedAt: this.options.now() });
    await this.options.publish({ type: "permission.updated", sessionId: permission.sessionId, permission: persisted });
    await this.options.publish({ type: "session.status.changed", sessionId: permission.sessionId, status: "running" });
    return { ok: true, permission: persisted };
  }

  async request(
    runtime: ActiveRuntime,
    config: ClaudeConfig,
    toolName: string,
    input: Record<string, unknown>,
    sdkOptions: Parameters<NonNullable<ClaudeOptions["canUseTool"]>>[2],
  ): Promise<PermissionResult> {
    if (toolName === "AskUserQuestion") {
      return { behavior: "allow", updatedInput: input, toolUseID: sdkOptions.toolUseID, decisionClassification: "user_temporary" };
    }
    const parsed = parseMcpToolName(toolName);
    await this.options.store.recordToolInventory(toolName, parsed.serverName || null);
    if (isToolApproved(runtime.session, config, toolName)) {
      return { behavior: "allow", updatedInput: input, toolUseID: sdkOptions.toolUseID, decisionClassification: "user_permanent" };
    }

    const permission = await this.options.store.createPermission({
      id: this.options.idFactory(),
      sessionId: runtime.session.id,
      agentId: runtime.agent.id,
      requestedByUserId: runtime.session.createdBy,
      type: "mcp_tool",
      risk: ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName) ? "critical" : toolName.startsWith("mcp__") ? "medium" : "low",
      summary: sdkOptions.title || `Claude Code 请求使用 ${parsed.serverName ? `${parsed.serverName} / ` : ""}${sdkOptions.displayName || parsed.toolName}`,
      payload: runtime.payload.prompt,
      turnId: runtime.turnId,
      status: "pending",
      expiresAt: this.options.now() + this.options.permissionTtlMs,
      toolName,
      serverName: parsed.serverName || null,
      toolInput: toJsonObject(input),
      toolUseId: sdkOptions.toolUseID,
      sdkPermission: true,
      permissionSuggestions: (sdkOptions.suggestions ?? []).map(toJsonValue),
      reason: sdkOptions.description || sdkOptions.decisionReason || "Claude Code 请求使用该工具。",
      fallbackResume: false,
      metadata: {
        ...(sdkOptions.blockedPath ? { blockedPath: sdkOptions.blockedPath } : {}),
        ...(sdkOptions.agentID ? { agentId: sdkOptions.agentID } : {}),
      },
    });
    await this.options.store.updateSession(runtime.session.id, { status: "waiting_permission", updatedAt: this.options.now() });
    await this.options.store.updateAgent(runtime.agent.id, { status: "waiting", updatedAt: this.options.now() });
    await this.options.createMessage({
      sessionId: runtime.session.id,
      senderType: "tool",
      senderId: runtime.agent.id,
      content: `${permission.summary}\n${permission.reason ?? ""}`,
      metadata: { type: "permission_request", permissionId: permission.id, toolName, serverName: parsed.serverName, turnId: runtime.turnId },
    });
    return new Promise<PermissionResult>((resolvePermission) => {
      runtime.pendingPermissionResolvers.set(permission.id, resolvePermission);
      const expiry = setTimeout(() => {
        if (!runtime.pendingPermissionResolvers.delete(permission.id)) return;
        void this.options.store.expirePermission(permission.id, this.options.now())
          .then((expired) => expired ? this.options.publish({ type: "permission.updated", sessionId: runtime.session.id, permission: expired }) : undefined)
          .finally(() => resolvePermission({ behavior: "deny", message: "Permission request expired.", toolUseID: sdkOptions.toolUseID, decisionClassification: "user_reject" }));
      }, Math.max(1, permission.expiresAt - this.options.now()));
      expiry.unref();
      sdkOptions.signal.addEventListener("abort", () => {
        if (!runtime.pendingPermissionResolvers.delete(permission.id)) return;
        clearTimeout(expiry);
        void this.options.store.expirePermission(permission.id, this.options.now())
          .then((expired) => expired ? this.options.publish({ type: "permission.updated", sessionId: runtime.session.id, permission: expired }) : undefined)
          .finally(() => resolvePermission({ behavior: "deny", message: "Permission request was aborted.", toolUseID: sdkOptions.toolUseID, decisionClassification: "user_reject" }));
      }, { once: true });
      void this.options.publish({ type: "permission.created", sessionId: runtime.session.id, permission })
        .then(() => this.options.publish({ type: "session.status.changed", sessionId: runtime.session.id, status: "waiting_permission" }))
        .catch(() => {
          clearTimeout(expiry);
          if (runtime.pendingPermissionResolvers.delete(permission.id)) {
            resolvePermission({ behavior: "deny", message: "Permission request could not be published.", toolUseID: sdkOptions.toolUseID, decisionClassification: "user_reject" });
          }
        });
    });
  }
}

function applyApproval(current: ToolApprovals, permission: Permission, decision: SafePermissionDecision): ToolApprovals {
  const next: ToolApprovals = {
    onceTools: [...current.onceTools],
    alwaysTools: [...current.alwaysTools],
    alwaysServers: [...current.alwaysServers],
  };
  const add = (values: string[], value: string | null): void => {
    if (value && !values.includes(value)) values.push(value);
  };
  if (decision === "allow_once") add(next.onceTools, permission.toolName);
  if (decision === "allow_always_tool") add(next.alwaysTools, permission.toolName);
  if (decision === "allow_always_server") {
    add(next.alwaysServers, permission.serverName);
    add(next.alwaysTools, permission.toolName);
  }
  return next;
}

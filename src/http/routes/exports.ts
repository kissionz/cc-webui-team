import { canSeeSession, type ConversationSession, type JsonObject, type Message, type User } from "../../domain/index.js";
import type { PersistenceRepository } from "../../persistence/index.js";
import { HttpError, sendDownload } from "../core.js";
import { inputEnum } from "../validation.js";
import type { RouteDefinition, RouteRequest } from "./shared.js";
import { routeId } from "./shared.js";

export interface ExportRoutesOptions {
  repository: PersistenceRepository;
  now: () => number;
  audit: (userId: string | null, action: string, targetType: string, targetId: string, metadata: JsonObject) => void;
}

export class ExportRoutes {
  readonly definitions: readonly RouteDefinition[];

  constructor(private readonly options: ExportRoutesOptions) {
    this.definitions = [
      { method: "GET", path: /^\/api\/sessions\/([^/]+)\/export$/, handle: (input) => this.exportSession(input) },
    ];
  }

  private exportSession({ response, url, auth, match }: RouteRequest): void {
    const sessionId = routeId(match, 1);
    const session = this.options.repository.getSession(sessionId);
    if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "会话不存在。");
    if (!canSeeSession(this.options.repository, auth.user, session)) throw new HttpError(403, "FORBIDDEN", "你没有导出此会话的权限。");
    const format = inputEnum(url.searchParams.get("format") ?? "json", ["json", "markdown"] as const, "format");
    const messages = collectMessages(this.options.repository, session.id);
    this.options.audit(auth.user.id, "session.exported", "session", session.id, { format, messageCount: messages.length });
    const safeTitle = session.title.replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 80) || session.id;
    if (format === "markdown") {
      sendDownload(response, `${safeTitle}.md`, sessionMarkdown(session, messages, auth.user), "text/markdown; charset=utf-8");
      return;
    }
    const payload = {
      schemaVersion: 1,
      exportedAt: this.options.now(),
      session,
      messages,
      permissions: this.options.repository.listPermissions(session.id),
      fileChanges: this.options.repository.listFileChanges(session.id),
    };
    sendDownload(response, `${safeTitle}.json`, JSON.stringify(payload, null, 2), "application/json; charset=utf-8");
  }
}

function collectMessages(repository: PersistenceRepository, sessionId: string): Message[] {
  const messages: Message[] = [];
  let cursor: string | null = null;
  do {
    const page = repository.listMessages(sessionId, { limit: 200, cursor });
    messages.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return messages.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function sessionMarkdown(session: ConversationSession, messages: Message[], exportedBy: User): string {
  const lines = [
    `# ${session.title}`,
    "",
    `- Session: \`${session.id}\``,
    `- Team: \`${session.teamId}\``,
    `- Visibility: ${session.visibility}`,
    `- Exported by: ${exportedBy.displayName}`,
    "",
  ];
  for (const message of messages) {
    const label = message.senderType === "user" ? "User" : message.senderType === "agent" ? "Claude" : message.senderType === "tool" ? "Tool" : "System";
    lines.push(`## ${label} · ${new Date(message.createdAt).toISOString()}`, "", message.content, "");
  }
  return lines.join("\n");
}

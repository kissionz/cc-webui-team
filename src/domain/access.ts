import type { ConversationSession, Permission, TeamRole, User } from "./models.js";

export interface AccessReader {
  getTeamRole(teamId: string, userId: string): TeamRole | null;
}

export function isSystemAdmin(user: Pick<User, "role">): boolean {
  return user.role === "admin";
}

export function canSeeTeam(reader: AccessReader, user: User, teamId: string): boolean {
  return isSystemAdmin(user) || reader.getTeamRole(teamId, user.id) !== null;
}

export function canWriteTeam(reader: AccessReader, user: User, teamId: string): boolean {
  const role = reader.getTeamRole(teamId, user.id);
  return isSystemAdmin(user) || role === "owner" || role === "admin" || role === "member";
}

export function canManageTeam(reader: AccessReader, user: User, teamId: string): boolean {
  const role = reader.getTeamRole(teamId, user.id);
  return isSystemAdmin(user) || role === "owner" || role === "admin";
}

export function canManageTeamSessions(reader: AccessReader, user: User, teamId: string): boolean {
  return canManageTeam(reader, user, teamId);
}

export function canSeeSession(reader: AccessReader, user: User, session: ConversationSession): boolean {
  return (
    canSeeTeam(reader, user, session.teamId) &&
    (canManageTeamSessions(reader, user, session.teamId) ||
      session.createdBy === user.id ||
      session.visibility === "team")
  );
}

export function canWriteSession(reader: AccessReader, user: User, session: ConversationSession): boolean {
  return (
    canWriteTeam(reader, user, session.teamId) &&
    (canManageTeamSessions(reader, user, session.teamId) || session.createdBy === user.id)
  );
}

export function canAskSession(reader: AccessReader, user: User, session: ConversationSession): boolean {
  return canWriteTeam(reader, user, session.teamId) && session.createdBy === user.id;
}

export function canApprovePermission(
  reader: AccessReader,
  user: User,
  session: ConversationSession,
  permission: Permission,
): boolean {
  const role = reader.getTeamRole(session.teamId, user.id);
  return (
    isSystemAdmin(user) ||
    role === "owner" ||
    role === "admin"
  );
}

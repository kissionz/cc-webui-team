import type { AppState, FileChange, Member, Message, PaginationState, Permission, Session, SessionGroup } from "./types.js";
import { api } from "./api.js";

type TeamParts = { rail?: boolean; chat?: boolean; right?: boolean };
export interface SessionStoreDeps {
  state(): AppState;
  now(): number;
  dayMs: number;
  uiMemory: { openSessionGroups: Map<string, boolean> };
  scheduleTeamRender(parts: TeamParts, delay?: number): void;
}

export function createSessionStore(deps: SessionStoreDeps) {
  const state = new Proxy({} as AppState, {
    get: (_target, key: keyof AppState) => deps.state()[key],
    set: (_target, key: PropertyKey, value) => Reflect.set(deps.state() as object, key, value),
  });
  const { now, dayMs: DAY_MS, uiMemory, scheduleTeamRender } = deps;

function sessionQuery(cursor?: string | null): string {
  const params = new URLSearchParams({ teamId: state.selectedTeamId, limit: "60", archived: state.sessionArchiveFilter });
  if (state.sessionSearch) params.set("q", state.sessionSearch);
  if (state.sessionStatusFilter !== "all") params.set("status", state.sessionStatusFilter);
  if (state.sessionMemberFilter !== "all") params.set("createdBy", state.sessionMemberFilter);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

async function loadSessions({ reset = false }: { reset?: boolean } = {}): Promise<void> {
  if (!state.selectedTeamId || state.sessionPagination.loading) return;
  state.sessionPagination = { ...state.sessionPagination, loading: true };
  scheduleTeamRender({ rail: true }, 0);
  try {
    const cursor = reset ? null : state.sessionPagination.nextCursor;
    const data = await api<{ sessions: Session[]; nextCursor?: string | null }>(`/api/sessions?${sessionQuery(cursor)}`);
    const otherTeams = state.sessions.filter((session) => session.teamId !== state.selectedTeamId);
    const current = reset ? data.sessions : [...state.sessions.filter((session) => session.teamId === state.selectedTeamId), ...data.sessions];
    state.sessions = [...otherTeams, ...dedupeById(current)];
    state.sessionPagination = { nextCursor: data.nextCursor || null, loading: false, initialized: true };
    normalizeSelectedSession();
  } catch (error) {
    state.sessionPagination = { ...state.sessionPagination, loading: false, initialized: true };
    throw error;
  }
}

function normalizeSelectedSession(): void {
  const visible = state.sessions.filter((session) => session.teamId === state.selectedTeamId);
  if (!visible.some((session) => session.id === state.selectedSessionId)) state.selectedSessionId = visible[0]?.id || "";
}

async function loadMessages(sessionId: string, { reset = false }: { reset?: boolean } = {}): Promise<void> {
  const page = state.messagePagination[sessionId] || { nextCursor: null, loading: false, initialized: false };
  if (page.loading || (!reset && page.initialized && !page.nextCursor)) return;
  state.messagePagination[sessionId] = { ...page, loading: true };
  scheduleTeamRender({ chat: true }, 0);
  try {
    const params = new URLSearchParams({ limit: "80" });
    if (!reset && page.nextCursor) params.set("cursor", page.nextCursor);
    const data = await api<{ messages: Message[]; nextCursor?: string | null; permissions?: Permission[]; fileChanges?: FileChange[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`);
    const others = state.messages.filter((message) => message.sessionId !== sessionId);
    const existing = reset ? [] : state.messages.filter((message) => message.sessionId === sessionId);
    state.messages = [...others, ...dedupeById([...data.messages, ...existing]).sort((a, b) => a.createdAt - b.createdAt)];
    if (data.permissions) state.permissions = [...state.permissions.filter((permission) => permission.sessionId !== sessionId), ...data.permissions];
    if (data.fileChanges) state.fileChanges = [...state.fileChanges.filter((change) => change.sessionId !== sessionId), ...data.fileChanges];
    state.messagePagination[sessionId] = { nextCursor: data.nextCursor || null, loading: false, initialized: true };
  } catch (error) {
    state.messagePagination[sessionId] = { ...page, loading: false, initialized: true };
    throw error;
  }
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  if (!item?.id) return items;
  const exists = items.some((existing) => existing.id === item.id);
  return exists ? items.map((existing) => (existing.id === item.id ? item : existing)) : [...items, item];
}

function sessionTimestamp(session?: Session): number {
  return Number(session?.updatedAt || session?.createdAt || 0);
}

function sortSessionsNewestFirst(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const timeDifference = sessionTimestamp(b) - sessionTimestamp(a);
    if (timeDifference) return timeDifference;
    return String(b.id || "").localeCompare(String(a.id || ""));
  });
}

function groupSessionsByTime(sessions: Session[], referenceTime = now()): SessionGroup[] {
  const today = new Date(referenceTime);
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();
  const groups: SessionGroup[] = [
    { id: "today", label: "今天", minimum: todayStart, defaultExpanded: true, sessions: [] },
    { id: "past-7-days", label: "过去7天", minimum: todayStart - DAY_MS * 7, defaultExpanded: true, sessions: [] },
    { id: "past-30-days", label: "过去30天", minimum: todayStart - DAY_MS * 30, defaultExpanded: false, sessions: [] },
    { id: "older", label: "更久", minimum: Number.NEGATIVE_INFINITY, defaultExpanded: false, sessions: [] },
  ];

  sortSessionsNewestFirst(sessions).forEach((session) => {
    const timestamp = sessionTimestamp(session);
    const group = groups.find((item) => timestamp >= item.minimum) || groups.at(-1);
    if (group) group.sessions.push(session);
  });

  return groups.filter((group) => group.sessions.length);
}

function sessionGroupKey(teamId: string, groupId: string): string {
  return `${teamId}:${groupId}`;
}

function isSessionGroupExpanded(teamId: string, group: SessionGroup, activeSession?: Session): boolean {
  const key = sessionGroupKey(teamId, group.id);
  if (uiMemory.openSessionGroups.has(key)) return uiMemory.openSessionGroups.get(key) ?? false;
  if (group.sessions.some((session) => session.id === activeSession?.id)) return true;
  return group.defaultExpanded;
}

function upsertMember(items: Member[], member: Member): Member[] {
  if (!member?.teamId || !member?.userId) return items;
  const exists = items.some((item) => item.teamId === member.teamId && item.userId === member.userId);
  return exists
    ? items.map((item) => (item.teamId === member.teamId && item.userId === member.userId ? member : item))
    : [...items, member];
}

  return {
    sessionQuery, loadSessions, normalizeSelectedSession, loadMessages, dedupeById, upsertById,
    sortSessionsNewestFirst, groupSessionsByTime, sessionGroupKey, isSessionGroupExpanded, upsertMember,
  };
}

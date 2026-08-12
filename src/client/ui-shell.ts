import type { AppState, FocusInfo, HtmlValue, ScrollPosition, Session, Team, UiSnapshot } from "./types.js";
import { createLiveState } from "./live-state.js";

type TeamParts = { rail: boolean; chat: boolean; right: boolean };
export interface UiShellDeps {
  state(): AppState;
  adminViews: { settings(): string; users(): string; audit(): string };
  renderLogin(error?: string): void;
  renderTeams(): string;
  renderTeamDetail(): string;
  renderTeamRail(team: Team, session?: Session): string;
  renderChat(team: Team, session?: Session): string;
  renderRightRail(team: Team, session?: Session): string;
  renderMessage(message: { id: string }): string;
  renderModal(kind: string, teamId?: string): string;
  renderPermissionOverlay(): string;
  activeModal(): string;
  modalTeamId(): string;
  renderToasts(): void;
  sortSessionsNewestFirst(sessions: Session[]): Session[];
  uiMemory: { composerDrafts: Map<string, string>; openTurnEvents: Map<string, boolean> };
}

export function createUiShell(deps: UiShellDeps) {
  const state = createLiveState(deps.state);
  const { adminViews, renderLogin, renderTeams, renderTeamDetail, renderTeamRail, renderChat, renderRightRail,
    renderMessage, renderModal, renderPermissionOverlay, renderToasts, sortSessionsNewestFirst, uiMemory } = deps;
  const activeModal = deps.activeModal;
  const modalTeamId = deps.modalTeamId;

function appElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>("#app");
  if (!element) throw new Error("应用挂载节点不存在");
  return element;
}

function openRenderedDialog(): void {
  const dialog = document.querySelector<HTMLDialogElement>("[data-modal-dialog]");
  if (!dialog || dialog.open) return;
  dialog.showModal();
  window.setTimeout(() => dialog.querySelector<HTMLElement>("input, select, textarea, button")?.focus(), 0);
}

function render(): void {
  const snapshot = captureUiSnapshot();
  if (!state.currentUserId) {
    renderLogin();
    return;
  }
  let html = "";
  if (state.activeView === "settings") html = adminViews.settings();
  else if (state.activeView === "users") html = adminViews.users();
  else if (state.activeView === "audit") html = adminViews.audit();
  else if (state.activeView === "team") html = renderTeamDetail();
  else html = renderTeams();
  appElement().innerHTML = html + renderModal(activeModal(), modalTeamId()) + renderPermissionOverlay();
  restoreUiSnapshot(snapshot);
  openRenderedDialog();
  renderToasts();
}

function renderTeamParts(parts: Partial<TeamParts> = {}): void {
  if (!state.currentUserId || state.activeView !== "team") {
    render();
    return;
  }
  const team = state.teams.find((item) => item.id === state.selectedTeamId) || state.teams[0];
  if (!team) {
    render();
    return;
  }
  const sessions = sortSessionsNewestFirst(state.sessions.filter((session) => session.teamId === team.id));
  const session = state.sessions.find((item) => item.id === state.selectedSessionId && item.teamId === team.id) || sessions[0];
  if (session && state.selectedSessionId !== session.id) state.selectedSessionId = session.id;
  const snapshot = captureUiSnapshot();
  const rail = document.querySelector("#team-rail");
  const chat = document.querySelector("#chat-panel");
  const right = document.querySelector("#right-rail");
  if (parts.rail && rail) rail.outerHTML = renderTeamRail(team, session);
  if (parts.chat && chat) chat.outerHTML = renderChat(team, session);
  if (parts.right && right) right.outerHTML = renderRightRail(team, session);
  if ((parts.rail && !rail) || (parts.chat && !chat) || (parts.right && !right)) {
    render();
    return;
  }
  restoreUiSnapshot(snapshot);
}

function patchVisibleMessage(messageId: string): boolean {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message || state.activeView !== "team" || message.sessionId !== state.selectedSessionId) return false;
  const element = document.querySelector(`[data-message-id="${cssEscape(messageId)}"]`);
  if (!element) return false;
  const snapshot = captureUiSnapshot();
  const html = renderMessage(message).trim();
  if (html) element.outerHTML = html;
  else element.remove();
  restoreUiSnapshot(snapshot);
  return true;
}

function captureUiSnapshot(): UiSnapshot {
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const activeInfo = active
    ? {
        selector: focusSelector(active),
        start: typeof active.selectionStart === "number" ? active.selectionStart : null,
        end: typeof active.selectionEnd === "number" ? active.selectionEnd : null,
      }
    : null;
  document.querySelectorAll<HTMLTextAreaElement>("[data-session-draft]").forEach((field) => {
    if (field.dataset.sessionDraft) uiMemory.composerDrafts.set(field.dataset.sessionDraft, field.value);
  });
  document.querySelectorAll<HTMLDetailsElement>("[data-turn-events]").forEach((details) => {
    if (details.dataset.turnEvents) uiMemory.openTurnEvents.set(details.dataset.turnEvents, details.open);
  });
  const stream = document.querySelector<HTMLElement>("#chat-stream");
  const streamDistanceFromBottom = stream ? stream.scrollHeight - stream.scrollTop - stream.clientHeight : 0;
  const scrolls = scrollSnapshot();
  return {
    view: state.activeView,
    sessionId: state.selectedSessionId,
    activeInfo,
    streamWasNearBottom: stream ? streamDistanceFromBottom < 96 : true,
    scrolls,
  };
}

function restoreUiSnapshot(snapshot: UiSnapshot = {}): void {
  restoreScrollSnapshot(snapshot);
  restoreFocus(snapshot.activeInfo);
}

function scrollSnapshot(): Record<string, ScrollPosition> {
  const selectors = ["#chat-stream", ".session-section .session-list", ".team-layout > .panel:last-child .side-stack", ".sidebar", ".main"];
  const snapshot: Record<string, ScrollPosition> = {};
  selectors.forEach((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return;
    snapshot[selector] = {
      top: element.scrollTop,
      left: element.scrollLeft,
      distanceFromBottom: element.scrollHeight - element.scrollTop - element.clientHeight,
    };
  });
  return snapshot;
}

function restoreScrollSnapshot(snapshot: UiSnapshot = {}): void {
  Object.entries(snapshot.scrolls || {}).forEach(([selector, value]: [string, ScrollPosition]) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return;
    if (selector === "#chat-stream" && snapshot.view === state.activeView && snapshot.sessionId === state.selectedSessionId) {
      element.scrollTop = snapshot.streamWasNearBottom ? element.scrollHeight : Math.max(0, element.scrollHeight - element.clientHeight - value.distanceFromBottom);
      element.scrollLeft = value.left || 0;
      return;
    }
    element.scrollTop = value.top || 0;
    element.scrollLeft = value.left || 0;
  });
}

function focusSelector(element: HTMLElement): string {
  if (element.matches("[data-session-draft]")) return `[data-session-draft="${cssEscape(element.dataset.sessionDraft || "")}"]`;
  if (element.id) return `#${cssEscape(element.id)}`;
  const name = element.getAttribute("name");
  const form = element.closest<HTMLFormElement>("form");
  if (name && form?.dataset.form) return `form[data-form="${cssEscape(form.dataset.form)}"] [name="${cssEscape(name)}"]`;
  return "";
}

function restoreFocus(activeInfo?: FocusInfo | null): void {
  if (!activeInfo?.selector) return;
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(activeInfo.selector);
  if (!element || element.disabled) return;
  element.focus({ preventScroll: true });
  if (typeof element.setSelectionRange === "function" && activeInfo.start !== null && activeInfo.end !== null) {
    element.setSelectionRange(activeInfo.start, activeInfo.end);
  }
}

function cssEscape(value: HtmlValue): string {
  if (CSS.escape) return CSS.escape(String(value));
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

  return { appElement, openRenderedDialog, render, renderTeamParts, patchVisibleMessage, captureUiSnapshot, restoreUiSnapshot, cssEscape };
}

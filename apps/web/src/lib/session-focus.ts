export type SessionFocusTarget = "row" | "actions";
export type SessionRowRevealIntent = { current: string | null };

export const FOCUS_SESSION_COMPOSER_EVENT = "opengeni:focus-session-composer";

export type SessionComposerFocusIntent = {
  workspaceId: string;
  sessionId: string;
  nonce: number;
};

let pendingComposerFocusIntent: SessionComposerFocusIntent | null = null;
let composerFocusNonce = 0;

/**
 * Record one explicit desktop rail-click intent before route navigation.
 * Route refreshes, deep links, polling, and background state changes never call
 * this seam, so they cannot acquire composer focus accidentally.
 */
export function requestSessionComposerFocus(workspaceId: string, sessionId: string): void {
  pendingComposerFocusIntent = {
    workspaceId,
    sessionId,
    nonce: ++composerFocusNonce,
  };
  globalThis.dispatchEvent?.(
    new CustomEvent<SessionComposerFocusIntent>(FOCUS_SESSION_COMPOSER_EVENT, {
      detail: pendingComposerFocusIntent,
    }),
  );
}

/** Consume only the exact destination's one-shot rail-click intent. */
export function consumeSessionComposerFocusIntent(
  workspaceId: string,
  sessionId: string,
): SessionComposerFocusIntent | null {
  const intent = pendingComposerFocusIntent;
  if (!intent || intent.workspaceId !== workspaceId || intent.sessionId !== sessionId) {
    return null;
  }
  pendingComposerFocusIntent = null;
  return intent;
}

/** Test/teardown seam. Production callers should consume rather than clear. */
export function clearSessionComposerFocusIntent(): void {
  pendingComposerFocusIntent = null;
}

/**
 * A rail click may replace focus only while focus still belongs to that click.
 * Any dialog or unrelated focused control wins over the navigation convenience.
 */
export function shouldFocusSessionComposer(
  active: HTMLElement | null,
  sessionId: string,
  body: HTMLElement | null,
  dialogOpen: boolean,
): boolean {
  if (dialogOpen) return false;
  if (!active || active === body || !active.isConnected) return true;
  return (
    active.closest<HTMLElement>("[data-session-row]")?.getAttribute("data-session-row") ===
    sessionId
  );
}

export function sessionComposerFocusIntentIsEligible(input: {
  viewportWidth: number;
  coarsePointer: boolean;
  terminal: boolean;
  requiresAction: boolean;
  pendingHumanInput: boolean;
  pendingApproval: boolean;
}): boolean {
  return (
    input.viewportWidth >= 1024 &&
    !input.coarsePointer &&
    !input.terminal &&
    !input.requiresAction &&
    !input.pendingHumanInput &&
    !input.pendingApproval
  );
}

/** Reader-owned rail movement supersedes an unfulfilled programmatic reveal. */
export function cancelSessionRowRevealIntent(intent: SessionRowRevealIntent): void {
  intent.current = null;
}

/**
 * Reveal one explicitly requested row and consume the request. Re-running this
 * during polling, pagination, or title/status churn is a no-op until a caller
 * records a new route/"Show path" intent.
 */
export function consumeSessionRowRevealIntent(
  root: HTMLElement,
  intent: SessionRowRevealIntent,
): HTMLElement | null {
  const sessionId = intent.current;
  if (!sessionId) return null;
  const row = [...root.querySelectorAll<HTMLElement>("[data-session-row]")].find(
    (candidate) => candidate.dataset.sessionRow === sessionId,
  );
  if (!row) return null;
  intent.current = null;
  row.scrollIntoView({ block: "nearest" });
  return row;
}

/**
 * Boundary navigation is a visual no-op when the requested index is already
 * focused. It must not leave an intent behind for a later list refresh to
 * interpret as a request to move DOM focus back to the row.
 */
export function shouldRecordSessionRowFocusIntent(
  requestedIndex: number | null,
  currentIndex: number,
): boolean {
  return requestedIndex !== null && requestedIndex !== currentIndex;
}

/**
 * Roving focus may move real DOM focus only for an explicit keyboard-navigation
 * intent. A pin or project move can reorder/remount the same row while
 * preserving its focus index; that derived change must not steal focus from a
 * restored row actions trigger.
 */
export function shouldMoveSessionRowFocus(
  intentSessionId: string | null,
  renderedSessionId: string | null,
): boolean {
  return intentSessionId !== null && intentSessionId === renderedSessionId;
}

export function sessionFocusAttribute(
  target: SessionFocusTarget,
): "data-session-row" | "data-session-actions" {
  return target === "actions" ? "data-session-actions" : "data-session-row";
}

function isSessionMenuElement(element: HTMLElement, sessionId: string): boolean {
  const menu = element.closest<HTMLElement>(
    '[role="menu"], [data-radix-menu-content], [data-radix-dropdown-menu-content]',
  );
  return menu?.getAttribute("data-session-menu") === sessionId;
}

function isRadixFocusGuard(element: HTMLElement): boolean {
  return element.getAttribute("data-radix-focus-guard") !== null;
}

function belongsToSession(element: HTMLElement, sessionId: string): boolean {
  return (
    element.getAttribute("data-session-row") === sessionId ||
    element.getAttribute("data-session-actions") === sessionId
  );
}

/**
 * Decide whether a group-remount focus restore may replace the active element.
 * An unrelated input, button, or menu is never displaced; only focus lost to
 * the operation's own remount/ Radix close path is eligible.
 */
export function shouldRestoreSessionFocus(
  active: HTMLElement | null,
  destination: HTMLElement,
  sessionId: string,
  body: HTMLElement | null,
): boolean {
  if (!destination.isConnected || active === destination) {
    return false;
  }
  if (!active || active === body || !active.isConnected) {
    return true;
  }
  if (isRadixFocusGuard(active) || isSessionMenuElement(active, sessionId)) {
    return true;
  }
  return belongsToSession(active, sessionId);
}

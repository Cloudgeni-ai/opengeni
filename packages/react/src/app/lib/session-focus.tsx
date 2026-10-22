export type SessionFocusTarget = "row" | "actions";
export type SessionRowRevealIntent = { current: string | null };

export const FOCUS_SESSION_COMPOSER_EVENT = "opengeni:focus-session-composer";

/**
 * Who asked for the composer: a click on the chat's sidebar row, or a keyboard
 * jump (the command menu, Control+Tab). Opening or reloading a chat with
 * nothing focused asks too, without an intent ("load").
 */
export type SessionComposerFocusSource = "rail" | "keyboard" | "load";

export type SessionComposerFocusIntent = {
  workspaceId: string;
  sessionId: string;
  nonce: number;
  source: SessionComposerFocusSource;
};

// One pending intent per app, keyed by its UI event target (the page's
// `window` in the web app, its own target in each embedded app), so a click in
// one app never focuses another app's composer.
let pendingComposerFocusIntents = new WeakMap<EventTarget, SessionComposerFocusIntent>();
let composerFocusNonce = 0;

/**
 * Record one explicit desktop navigation intent (a sidebar row click or a
 * keyboard jump) before route navigation. Polling and background state changes
 * never call this seam, so they cannot acquire composer focus.
 */
export function requestSessionComposerFocus(
  events: EventTarget,
  workspaceId: string,
  sessionId: string,
  source: Exclude<SessionComposerFocusSource, "load"> = "rail",
): void {
  const intent = { workspaceId, sessionId, nonce: ++composerFocusNonce, source };
  pendingComposerFocusIntents.set(events, intent);
  events.dispatchEvent(
    new CustomEvent<SessionComposerFocusIntent>(FOCUS_SESSION_COMPOSER_EVENT, { detail: intent }),
  );
}

/** Consume only the exact destination's one-shot rail-click intent. */
export function consumeSessionComposerFocusIntent(
  events: EventTarget,
  workspaceId: string,
  sessionId: string,
): SessionComposerFocusIntent | null {
  const intent = pendingComposerFocusIntents.get(events);
  if (!intent || intent.workspaceId !== workspaceId || intent.sessionId !== sessionId) {
    return null;
  }
  pendingComposerFocusIntents.delete(events);
  return intent;
}

/** Test/teardown seam. Production callers should consume rather than clear. */
export function clearSessionComposerFocusIntent(): void {
  pendingComposerFocusIntents = new WeakMap();
}

/**
 * Whether the composer may take focus now. Any open dialog wins. A keyboard
 * jump replaces whatever the previous chat had focused. A rail click replaces
 * only focus that still belongs to that click (its own row). Opening or
 * reloading a chat takes focus only when nothing is focused.
 */
export function shouldFocusSessionComposer(
  active: HTMLElement | null,
  sessionId: string,
  body: HTMLElement | null,
  dialogOpen: boolean,
  source: SessionComposerFocusSource = "rail",
): boolean {
  if (dialogOpen) return false;
  if (!active || active === body || !active.isConnected) return true;
  if (source === "keyboard") return true;
  if (source === "load") return false;
  return (
    active.closest<HTMLElement>("[data-session-row]")?.getAttribute("data-session-row") ===
    sessionId
  );
}

const COMPOSER_FOCUS_WAIT_MS = 3_000;
const DIALOG_SELECTOR = '[aria-modal="true"], [role="dialog"][data-state="open"]';

/**
 * Focus the chat's composer once it can take focus: the command menu may still
 * be closing and the composer may still be loading its draft (disabled). Gives
 * up when focus moves elsewhere in the meantime or after a few seconds.
 * Returns a cancel function.
 */
export function focusSessionComposerWhenReady(input: {
  textarea: () => HTMLTextAreaElement | null | undefined;
  sessionId: string;
  source: SessionComposerFocusSource;
  doc?: Document;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}): () => void {
  const doc = input.doc ?? document;
  const now = input.now ?? (() => Date.now());
  const requestFrame =
    input.requestFrame ?? ((callback) => globalThis.requestAnimationFrame(callback));
  const cancelFrame = input.cancelFrame ?? ((handle) => globalThis.cancelAnimationFrame(handle));
  const deadline = now() + COMPOSER_FOCUS_WAIT_MS;
  let frame = 0;
  let cancelled = false;
  const attempt = () => {
    if (cancelled || now() > deadline) return;
    const textarea = input.textarea();
    const dialogOpen = Boolean(doc.querySelector(DIALOG_SELECTOR));
    if (!textarea || textarea.disabled || dialogOpen) {
      frame = requestFrame(attempt);
      return;
    }
    const active = (doc.activeElement as HTMLElement | null) ?? null;
    if (active === textarea) return;
    if (shouldFocusSessionComposer(active, input.sessionId, doc.body, false, input.source)) {
      textarea.focus({ preventScroll: true });
    }
  };
  frame = requestFrame(attempt);
  return () => {
    cancelled = true;
    cancelFrame(frame);
  };
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

/** Completes only the focus obligation represented by this committed layout. */
export function createSessionFocusCompletion(
  pending: { current: { operation: number; settled: boolean } | null },
  restore: () => void,
): () => void {
  const operation = pending.current?.operation;
  const settled = pending.current?.settled;
  return () => {
    restore();
    if (pending.current?.operation === operation && settled) {
      pending.current = null;
    }
  };
}

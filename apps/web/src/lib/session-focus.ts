export type SessionFocusTarget = "row" | "actions";

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
 * Decide whether a pin-operation focus restore may replace the active element.
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

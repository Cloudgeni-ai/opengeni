export const CAPABILITY_FOCUS_TARGET_SELECTOR = "[data-capability-focus-target]";

/**
 * Find the visible, focusable control for a capability after its catalog row
 * moves between Browse and Enabled. The data attribute is deliberately kept
 * on the actual control rather than a presentational card wrapper.
 */
export function findCapabilityFocusTarget(capabilityId: string | null): HTMLElement | null {
  if (!capabilityId || typeof document === "undefined") return null;

  for (const target of document.querySelectorAll<HTMLElement>(CAPABILITY_FOCUS_TARGET_SELECTOR)) {
    if (target.dataset.capabilityId !== capabilityId || !isUsableFocusTarget(target)) continue;
    return target;
  }
  return null;
}

/**
 * Guard focus restoration against a matching control that is hidden, removed,
 * disabled, or otherwise excluded from the accessibility tree.
 */
export function isUsableFocusTarget(target: HTMLElement | null): target is HTMLElement {
  if (!target?.isConnected || target.hidden) return false;
  if (target.closest('[hidden], [aria-hidden="true"]')) return false;
  if (target.matches(":disabled")) return false;

  const view = target.ownerDocument.defaultView;
  if (view) {
    const style = view.getComputedStyle(target);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Focus the newly rendered capability control, or an explicit visible route
 * region when the control is not available (for example, a filtered result).
 */
export function focusCapabilitySuccessor(
  capabilityId: string | null,
  fallback: HTMLElement | null,
): boolean {
  const target = findCapabilityFocusTarget(capabilityId);
  const destination = target ?? (isUsableFocusTarget(fallback) ? fallback : null);
  if (!destination) return false;

  destination.focus();
  return destination.ownerDocument.activeElement === destination;
}

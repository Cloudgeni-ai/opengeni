import {
  OPENGENI_USER_ACTIVITY_ACTIVE,
  OPENGENI_USER_ACTIVITY_HEADER,
  OPENGENI_USER_ACTIVITY_WINDOW_MS,
} from "@opengeni/contracts";

/**
 * Marks API requests made while the person is actually using the console, so
 * the server's presence analytics never count an idle open tab, background
 * polling, or a long-lived stream. Active means the tab is visible and the
 * person loaded it, focused it, or interacted with it within the window.
 */
const INTERACTION_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "focus"] as const;

let lastInteractionAt = 0;
let installed = false;

function markInteraction(): void {
  lastInteractionAt = Date.now();
}

function install(): void {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;
  // Loading the console is itself a deliberate visit.
  markInteraction();
  for (const event of INTERACTION_EVENTS) {
    window.addEventListener(event, markInteraction, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") markInteraction();
  });
}

/** The activity header for one request, or nothing while the person is idle. */
export function userActivityHeaders(now: number = Date.now()): Record<string, string> {
  install();
  if (typeof document === "undefined" || document.visibilityState !== "visible") return {};
  if (now - lastInteractionAt > OPENGENI_USER_ACTIVITY_WINDOW_MS) return {};
  return { [OPENGENI_USER_ACTIVITY_HEADER]: OPENGENI_USER_ACTIVITY_ACTIVE };
}

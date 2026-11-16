// Opengeni Console's sign-in handoff, browser side. A person signed out on a
// Console host continues with the app host's sign-in (see
// apps/api/src/routes/console-sign-in.ts). Kept free of React so the decision
// that prevents sign-in loops is unit-tested on its own.

import {
  CONSOLE_SIGN_IN_API_PATH,
  CONSOLE_SIGN_IN_DEFAULT_RETURN,
  CONSOLE_SIGN_IN_OUTCOME_PARAM,
  consoleSignInReturnPath,
  type ConsoleSignInOutcome,
} from "@opengeni/contracts/console-sign-in";

/** Console's request to the app host's `/console-sign-in` page, as it arrives in the URL. */
export type ConsoleSignInSearch = { console?: string; challenge?: string; return?: string };

export function parseConsoleSignInSearch(search: Record<string, unknown>): ConsoleSignInSearch {
  const text = (key: keyof ConsoleSignInSearch) =>
    typeof search[key] === "string" && search[key] ? { [key]: search[key] as string } : {};
  return { ...text("console"), ...text("challenge"), ...text("return") };
}

/** Set by Console's Sign out: wait for Continue instead of signing straight back in. */
export const CONSOLE_SIGNED_OUT_KEY = "opengeni.consoleSignIn:signedOut";
/** When this browser last started a handoff. */
export const CONSOLE_AUTO_START_KEY = "opengeni.consoleSignIn:autoStartedAt";
/** Within this long of the last handoff, a signed-out page waits for Continue. */
export const CONSOLE_AUTO_START_COOLDOWN_MS = 60_000;

/**
 * What Console's signed-out page does:
 * - `continue`: start the handoff right away (the person sees no sign-in);
 * - `choose`: show Continue, after Sign out, a failed handoff, or a handoff
 *   that just ran and still left the person signed out (never a loop);
 * - `fallback`: show Console's own email and Google sign-in, when this
 *   deployment can't hand off, or the address carries a result of that
 *   sign-in (`?error=`, `?mode=signup`).
 */
export type ConsoleSignedOutStep = "continue" | "choose" | "fallback";

export function consoleSignInOutcome(search: string): ConsoleSignInOutcome | null {
  const value = new URLSearchParams(search).get(CONSOLE_SIGN_IN_OUTCOME_PARAM);
  return value === "failed" || value === "unavailable" ? value : null;
}

export function consoleSignedOutStep(input: {
  search: string;
  signedOut: boolean;
  lastAutoStartedAt: number | null;
  now: number;
}): ConsoleSignedOutStep {
  const params = new URLSearchParams(input.search);
  const outcome = consoleSignInOutcome(input.search);
  if (outcome === "unavailable") return "fallback";
  if (params.has("error") || params.get("mode")?.toLowerCase() === "signup") return "fallback";
  if (outcome === "failed" || input.signedOut) return "choose";
  if (
    input.lastAutoStartedAt !== null &&
    input.now - input.lastAutoStartedAt >= 0 &&
    input.now - input.lastAutoStartedAt < CONSOLE_AUTO_START_COOLDOWN_MS
  ) {
    return "choose";
  }
  return "continue";
}

/** The Console page to come back to: this one when it is a Console page, else Overview. */
export function consoleSignInReturnFor(pathname: string, search: string): string {
  if (pathname !== CONSOLE_SIGN_IN_DEFAULT_RETURN && !pathname.startsWith("/console/")) {
    return CONSOLE_SIGN_IN_DEFAULT_RETURN;
  }
  return consoleSignInReturnPath(`${pathname}${search}`);
}

/** The Console host's own start route, which sends the browser on to the app's sign-in. */
export function consoleSignInStartUrl(apiBaseUrl: string, returnPath: string): string {
  return `${apiBaseUrl}${CONSOLE_SIGN_IN_API_PATH}/start?${new URLSearchParams({ return: returnPath })}`;
}

function local(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readConsoleSignInMemory(): {
  signedOut: boolean;
  lastAutoStartedAt: number | null;
} {
  const storage = local();
  try {
    const started = Number(storage?.getItem(CONSOLE_AUTO_START_KEY) ?? Number.NaN);
    return {
      signedOut: storage?.getItem(CONSOLE_SIGNED_OUT_KEY) === "1",
      lastAutoStartedAt: Number.isFinite(started) ? started : null,
    };
  } catch {
    return { signedOut: false, lastAutoStartedAt: null };
  }
}

/** Console's Sign out: the next signed-out page waits for Continue. */
export function rememberConsoleSignedOut(): void {
  try {
    local()?.setItem(CONSOLE_SIGNED_OUT_KEY, "1");
  } catch {
    // Nothing to remember without storage.
  }
}

/** A handoff starts: Sign out no longer holds, and the cooldown begins. */
export function rememberConsoleSignInStarted(now = Date.now()): void {
  try {
    const storage = local();
    storage?.removeItem(CONSOLE_SIGNED_OUT_KEY);
    storage?.setItem(CONSOLE_AUTO_START_KEY, String(now));
  } catch {
    // Nothing to remember without storage.
  }
}

import type { FeedbackRecentError } from "@opengeni/sdk";

// The last few failures on this device (failed server requests and app errors),
// kept in memory only. A feedback report attaches them so whoever reads it sees
// what went wrong without asking. Nothing is stored or sent unless the person
// sends a report.

export const RECENT_ERRORS_LIMIT = 10;

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

let entries: FeedbackRecentError[] = [];
let currentScreen: string | null = null;

/** The screen in view, kept current by the feedback host. */
export function setFeedbackScreen(screen: string | null): void {
  currentScreen = screen;
}

export function feedbackScreen(): string | null {
  return currentScreen;
}

export function recordRecentError(input: {
  message: string;
  title?: string | undefined;
  code?: string | undefined;
  status?: number | undefined;
}): void {
  const message = input.message.trim() || "Error";
  entries = [
    ...entries,
    {
      at: new Date().toISOString(),
      message: clip(message, 1000),
      ...(input.title?.trim() ? { title: clip(input.title.trim(), 200) } : {}),
      ...(input.code?.trim() ? { code: clip(input.code.trim(), 120) } : {}),
      ...(input.status !== undefined && Number.isInteger(input.status)
        ? { status: input.status }
        : {}),
      ...(currentScreen ? { screen: clip(currentScreen, 500) } : {}),
    },
  ].slice(-RECENT_ERRORS_LIMIT);
}

/** Oldest first, as they happened. */
export function recentErrors(): readonly FeedbackRecentError[] {
  return entries;
}

/** The request's method and path, without the host or query (which can carry tokens). */
function describeRequest(input: RequestInfo | URL, init?: RequestInit): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let path = raw;
  try {
    path = new URL(raw).pathname;
  } catch {
    path = raw.split("?")[0] ?? raw;
  }
  const method =
    init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Wraps the app's fetch so failed server requests are remembered for feedback.
 * Sign-in expiry (401) is routine and left out, as is sending feedback itself.
 */
export function recordingFailedRequests<
  F extends (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<{ ok: boolean; status: number }>,
>(fetchImpl: F): F {
  const recording = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = describeRequest(input, init);
    const isFeedback = request.includes("/feedback");
    try {
      const response = await fetchImpl(input, init);
      if (!response.ok && response.status !== 401 && !isFeedback)
        recordRecentError({
          message: `${request} failed (${response.status})`,
          status: response.status,
        });
      return response;
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      if (!aborted && !isFeedback)
        recordRecentError({
          message: `${request} failed: ${error instanceof Error ? error.message : String(error)}`,
          code: "network",
        });
      throw error;
    }
  };
  return recording as F;
}

type GlobalErrorUtils = {
  getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
};

let recordingAppErrors = false;

/** Remembers uncaught app errors too, then hands them to the usual handler. */
export function recordUncaughtErrors(): void {
  const utils = (globalThis as { ErrorUtils?: GlobalErrorUtils }).ErrorUtils;
  if (recordingAppErrors || !utils) return;
  recordingAppErrors = true;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    recordRecentError({
      title: isFatal ? "App crashed" : "App error",
      message: error instanceof Error ? error.message : String(error),
    });
    previous(error, isFatal);
  });
}

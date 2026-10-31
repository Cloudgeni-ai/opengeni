import type {
  FeedbackBreadcrumb,
  FeedbackRecentError,
  FeedbackRecentException,
  FeedbackRecentRequest,
} from "@opengeni/sdk";

// What happened on this device just before a report, kept in memory only: the
// last failures (failed server requests and app errors), the latest server
// requests with the server's reference for each, uncaught errors with their
// stack, and the screens and app states the person moved through. A feedback
// report attaches them so whoever reads it sees what went wrong without
// asking. Nothing is stored or sent unless the person sends a report.

export const RECENT_ERRORS_LIMIT = 10;
export const RECENT_REQUESTS_LIMIT = 20;
export const RECENT_EXCEPTIONS_LIMIT = 10;
export const BREADCRUMBS_LIMIT = 30;
/** The API's reference for one request, which finds its server logs. */
const CORRELATION_HEADER = "x-opengeni-correlation-id";

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

let entries: FeedbackRecentError[] = [];
let requests: FeedbackRecentRequest[] = [];
let exceptions: FeedbackRecentException[] = [];
let breadcrumbs: FeedbackBreadcrumb[] = [];
let currentScreen: string | null = null;

/** The screen in view, kept current by the feedback host; each change is a step. */
export function setFeedbackScreen(screen: string | null): void {
  currentScreen = screen;
  if (screen) recordBreadcrumb("navigation", screen);
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

/** Remember a step: a screen opened, the app going to the background or coming back. */
export function recordBreadcrumb(kind: FeedbackBreadcrumb["kind"], label: string): void {
  const text = clip(label.trim(), 200);
  if (!text) return;
  const last = breadcrumbs.at(-1);
  if (last?.kind === kind && last.label === text) return;
  breadcrumbs = [...breadcrumbs, { at: new Date().toISOString(), kind, label: text }].slice(
    -BREADCRUMBS_LIMIT,
  );
}

/** Remember an error nobody caught, with its stack. */
export function recordException(input: {
  kind: FeedbackRecentException["kind"];
  message: string;
  stack?: string | undefined;
}): void {
  const stack = input.stack?.trim();
  exceptions = [
    ...exceptions,
    {
      at: new Date().toISOString(),
      kind: input.kind,
      message: clip(input.message.trim() || "Unknown error", 1000),
      ...(stack ? { stack: clip(stack, 4000) } : {}),
    },
  ].slice(-RECENT_EXCEPTIONS_LIMIT);
}

/** The latest requests, uncaught errors and steps, oldest first in each list. */
export function feedbackTrail(): {
  recentRequests: readonly FeedbackRecentRequest[];
  recentExceptions: readonly FeedbackRecentException[];
  breadcrumbs: readonly FeedbackBreadcrumb[];
} {
  return { recentRequests: requests, recentExceptions: exceptions, breadcrumbs };
}

/** Tests only. */
export function clearFeedbackRecords(): void {
  entries = [];
  requests = [];
  exceptions = [];
  breadcrumbs = [];
  currentScreen = null;
}

const SESSION_SCREEN =
  /^\/session\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

/** The chat a screen shows, such as /session/<id>. */
export function sessionIdInScreen(screen: string | null | undefined): string | undefined {
  return screen ? SESSION_SCREEN.exec(screen)?.[1]?.toLowerCase() : undefined;
}

/** The request's method and path, without the host or query (which can carry tokens). */
function requestParts(
  input: RequestInfo | URL,
  init?: RequestInit,
): { method: string; path: string } {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let path = raw;
  try {
    path = new URL(raw).pathname;
  } catch {
    path = raw.split("?")[0] ?? raw;
  }
  const method =
    init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
  return { method: method.toUpperCase(), path: path || "/" };
}

function rememberRequest(entry: {
  at: string;
  method: string;
  path: string;
  status: number;
  startedAt: number;
  correlationId?: string | null | undefined;
}): void {
  const correlationId = entry.correlationId?.trim();
  requests = [
    ...requests,
    {
      at: entry.at,
      method: /^[A-Z]{1,10}$/u.test(entry.method) ? entry.method : "GET",
      path: clip(entry.path, 300),
      status: entry.status >= 0 && entry.status <= 999 ? Math.trunc(entry.status) : 0,
      durationMs: Math.max(0, Math.min(86_400_000, Date.now() - entry.startedAt)),
      ...(correlationId ? { correlationId: clip(correlationId, 128) } : {}),
    },
  ].slice(-RECENT_REQUESTS_LIMIT);
}

/**
 * Wraps the app's fetch so the latest server requests are remembered for
 * feedback, and failed ones also as errors. Sign-in expiry (401) is routine
 * and not an error; requests the app cancelled and sending feedback itself are
 * left out.
 */
export function recordingRequests<
  F extends (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<{
    ok: boolean;
    status: number;
    headers?: { get(name: string): string | null } | undefined;
  }>,
>(fetchImpl: F): F {
  const recording = async (input: RequestInfo | URL, init?: RequestInit) => {
    const { method, path } = requestParts(input, init);
    const request = `${method} ${path}`;
    const isFeedback = /\/feedback$/u.test(path);
    const at = new Date().toISOString();
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(input, init);
      if (isFeedback) return response;
      rememberRequest({
        at,
        method,
        path,
        status: response.status,
        startedAt,
        correlationId: response.headers?.get(CORRELATION_HEADER),
      });
      if (!response.ok && response.status !== 401)
        recordRecentError({
          message: `${request} failed (${response.status})`,
          status: response.status,
        });
      return response;
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      if (!aborted && !isFeedback) {
        rememberRequest({ at, method, path, status: 0, startedAt });
        recordRecentError({
          message: `${request} failed: ${error instanceof Error ? error.message : String(error)}`,
          code: "network",
        });
      }
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
    recordException({
      kind: "error",
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    previous(error, isFatal);
  });
}

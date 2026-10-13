// First-party web error beacon. It reports a closed error kind, the matched
// route PATTERN (never the page URL), the bundle revision, and the error's
// diagnostics (name, message, stack, and React's component stack for a render
// failure) to `POST /v1/client-errors`, which increments
// `opengeni_client_errors_total{kind}` and logs the report. The diagnostics
// are scrubbed of obvious credentials and URL query strings and bounded per
// field before they leave the browser; they are error text, which can
// occasionally quote user content. No cookie or credential is sent with the
// request. This is error diagnostics, not consent-controlled product analytics
// (see apps/web/docs/browser-analytics.md). The wire grammar and the scrubbing
// are shared with the API route and the public log projection through
// @opengeni/contracts.
import {
  CLIENT_ERRORS_PATH,
  CLIENT_ERROR_KINDS,
  projectClientErrorDetail,
  type ClientErrorDetail,
  type ClientErrorKind,
  type ClientErrorReport,
} from "@opengeni/contracts/client-error-report";
import { rootRouteId } from "@tanstack/react-router";

import { clientRevision, clientRoutePattern } from "./client-route-pattern";

export {
  CLIENT_ERRORS_PATH,
  CLIENT_ERROR_KINDS,
  type ClientErrorDetail,
  type ClientErrorKind,
  type ClientErrorReport,
};
export { clientRevision, clientRoutePattern };

/** The leaf route's pattern, or `unknown` when only the root matched (not found). */
export function routePatternFromMatches(
  matches: ReadonlyArray<{ routeId: string; fullPath: string }>,
): string {
  const leaf = matches.at(-1);
  return leaf && leaf.routeId !== rootRouteId ? clientRoutePattern(leaf.fullPath) : "unknown";
}

/**
 * The leaf pattern of a matched route branch, as `router.getMatchedRoutes`
 * returns it for a location that may still be loading.
 */
export function routePatternFromRoutes(
  routes: ReadonlyArray<{ id: string; fullPath: string }>,
): string {
  const leaf = routes.at(-1);
  return leaf && leaf.id !== rootRouteId ? clientRoutePattern(leaf.fullPath) : "unknown";
}

const CHUNK_LOAD_MESSAGE_PATTERNS = [
  /failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
  /unable to preload css/i, // Vite preload helper
  /failed to load module script/i, // HTML served for a removed asset
  /loading (?:css )?chunk \S+ failed/i,
];

/**
 * A lazy route or module that can no longer be fetched, which after a deploy
 * usually means the tab still references hashed assets that were replaced.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  return (
    typeof message === "string" &&
    CHUNK_LOAD_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/** What a catch site knows beyond the thrown value. */
export type ClientErrorContext = {
  /** React's component stack, for a failure caught by an error boundary. */
  componentStack?: string | null;
  /** Where the browser located an uncaught error that carried no error object. */
  location?: { filename?: string; lineno?: number; colno?: number };
};

function stringProperty(value: object, key: string): string | undefined {
  try {
    const property = (value as Record<string, unknown>)[key];
    return typeof property === "string" ? property : undefined;
  } catch {
    // A hostile getter or a revoked proxy.
    return undefined;
  }
}

function describeNonError(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return String(value);
  try {
    const json = JSON.stringify(value);
    if (json && json !== "{}") return json.slice(0, 2_048);
  } catch {
    // Cyclic or otherwise unserializable.
  }
  return Object.prototype.toString.call(value);
}

/**
 * The diagnostics of a caught value, scrubbed and bounded with the shared
 * contract projection. An `Error` (or anything shaped like one, such as a
 * `DOMException`) gives its name, message and stack. Any other thrown or
 * rejected value is described as `NonError` with a short rendering of the
 * value. An uncaught error without an error object (a cross-origin or
 * `ErrorEvent`-only failure) contributes its source location as the stack.
 */
export function clientErrorDetail(
  error: unknown,
  context: ClientErrorContext = {},
): ClientErrorDetail | undefined {
  let name: string | undefined;
  let message: string | undefined;
  let stack: string | undefined;
  if (error && typeof error === "object" && typeof stringProperty(error, "message") === "string") {
    name = stringProperty(error, "name") ?? error.constructor?.name;
    message = stringProperty(error, "message");
    stack = stringProperty(error, "stack");
  } else {
    name = "NonError";
    message = describeNonError(error);
  }
  const location = context.location;
  if (!stack && location?.filename) {
    stack = `at ${location.filename}:${location.lineno ?? 0}:${location.colno ?? 0}`;
  }
  return projectClientErrorDetail({
    name,
    message,
    stack,
    componentStack: context.componentStack ?? undefined,
  });
}

/** The name and first message line: what makes two failures the same failure. */
function errorSignature(detail: ClientErrorDetail | undefined): string {
  if (!detail) return "";
  return `${detail.name ?? ""}: ${(detail.message ?? "").split("\n", 1)[0]!.slice(0, 200)}`;
}

export type ClientErrorReporter = {
  report(kind: ClientErrorKind, route: string, detail?: ClientErrorDetail): boolean;
};

export type ClientErrorReporterOptions = {
  send: (body: string) => void;
  revision: string;
  now?: () => number;
  /** Suppress a repeat of the same kind, route and error within this window. */
  dedupeWindowMs?: number;
  /** At most this many reports per `rateWindowMs`, across all kinds. */
  maxReportsPerWindow?: number;
  rateWindowMs?: number;
};

/**
 * Client-side dedupe and rate limit. A render loop or a noisy listener can
 * throw hundreds of times a second; one report per kind, route and error
 * (name and first message line) per minute and ten reports per ten minutes is
 * enough to count failures and see each distinct one.
 */
export function createClientErrorReporter(
  options: ClientErrorReporterOptions,
): ClientErrorReporter {
  const now = options.now ?? Date.now;
  const dedupeWindowMs = options.dedupeWindowMs ?? 60_000;
  const maxReportsPerWindow = options.maxReportsPerWindow ?? 10;
  const rateWindowMs = options.rateWindowMs ?? 10 * 60_000;
  const revision = clientRevision(options.revision);
  const lastReportedAt = new Map<string, number>();
  let sentAt: number[] = [];
  return {
    report(kind, route, detail) {
      const at = now();
      const pattern = clientRoutePattern(route);
      const key = `${kind} ${pattern} ${errorSignature(detail)}`;
      const previous = lastReportedAt.get(key);
      if (previous !== undefined && at - previous < dedupeWindowMs) return false;
      sentAt = sentAt.filter((sent) => at - sent < rateWindowMs);
      if (sentAt.length >= maxReportsPerWindow) return false;
      sentAt.push(at);
      lastReportedAt.set(key, at);
      const report: ClientErrorReport = {
        kind,
        route: pattern,
        revision,
        ...(detail ? { error: detail } : {}),
      };
      try {
        options.send(JSON.stringify(report));
      } catch {
        // Reporting must never become a second failure.
      }
      return true;
    },
  };
}

export type BeaconSenderOptions = {
  /**
   * Where `online` is observed. When set, a report that could not be
   * delivered (the browser was offline, or the request failed) is queued and
   * retried once when the browser comes back online.
   */
  retryTarget?: Pick<Window, "addEventListener">;
  /** Whether the browser currently reports connectivity. Defaults to `navigator.onLine`. */
  isOnline?: () => boolean;
  /** Most reports held for the retry. Older ones are dropped first. */
  maxPending?: number;
};

/**
 * Fire-and-forget delivery. A text/plain body with no credentials or custom
 * headers is a simple request: no preflight, no cookies, and `keepalive` lets
 * it finish when the user reloads straight from the error page. With a
 * `retryTarget`, an undeliverable report gets exactly one more attempt when
 * the browser is next online; it is never retried twice.
 */
export function beaconSender(
  url: string,
  fetchImpl: typeof fetch | undefined = globalThis.fetch,
  options: BeaconSenderOptions = {},
): (body: string) => void {
  const isOnline =
    options.isOnline ??
    (() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  const maxPending = options.maxPending ?? 20;
  let pending: string[] = [];
  const post = (body: string) =>
    fetchImpl!(url, {
      method: "POST",
      body,
      credentials: "omit",
      keepalive: true,
      headers: { "content-type": "text/plain;charset=UTF-8" },
    });
  const hold = (body: string) => {
    if (!options.retryTarget) return;
    pending.push(body);
    if (pending.length > maxPending) pending = pending.slice(-maxPending);
  };
  options.retryTarget?.addEventListener("online", () => {
    const retry = pending;
    pending = [];
    for (const body of retry) void post(body).catch(() => undefined);
  });
  return (body) => {
    if (!fetchImpl) return;
    if (options.retryTarget && !isOnline()) {
      hold(body);
      return;
    }
    void post(body).catch(() => hold(body));
  };
}

let defaultReporter: ClientErrorReporter | null = null;

/** Install the process-wide reporter. Tests and non-browser hosts leave it unset. */
export function setClientErrorReporter(reporter: ClientErrorReporter | null): void {
  defaultReporter = reporter;
}

export function reportClientError(
  kind: ClientErrorKind,
  route: string,
  detail?: ClientErrorDetail,
): void {
  defaultReporter?.report(kind, route, detail);
}

type Report = (kind: ClientErrorKind, route: string, detail?: ClientErrorDetail) => void;

// Set once this document has failed to load one of its lazy modules. After a
// deploy that means the tab still references hashed assets that were replaced,
// so it is running an older build until it reloads.
let chunkLoadFailureObserved = false;

/** Whether this document has already failed to load a lazy module. */
export function hasObservedChunkLoadFailure(): boolean {
  return chunkLoadFailureObserved;
}

/** Tests only. A real document clears this state by reloading. */
export function resetChunkLoadFailureState(): void {
  chunkLoadFailureObserved = false;
}

/**
 * Record a lazy-module load failure. The first one in a document is reported
 * once as `chunk_load`; the document then counts as running a replaced build.
 */
export function noteChunkLoadFailure(
  route: () => string,
  report: Report = reportClientError,
  error?: unknown,
) {
  if (chunkLoadFailureObserved) return;
  chunkLoadFailureObserved = true;
  report("chunk_load", route(), error === undefined ? undefined : clientErrorDetail(error));
}

/**
 * Report a failure caught by a route boundary or a global listener. Once the
 * document has observed a chunk-load failure it reports nothing further: the
 * `chunk_load` report already counted it, and what follows is its consequence.
 * In particular, when the recovery listener cancels `vite:preloadError`, Vite
 * resolves the failed import to `undefined` and the router then fails with an
 * ordinary `TypeError` while the recovery reload is in flight; counting that
 * as `route_error` would raise the route-error rate on every deploy.
 */
export function reportCaughtClientError(
  error: unknown,
  kind: Exclude<ClientErrorKind, "chunk_load">,
  route: () => string,
  report: Report = reportClientError,
  context: ClientErrorContext = {},
): void {
  if (chunkLoadFailureObserved) return;
  if (isChunkLoadError(error)) {
    noteChunkLoadFailure(route, report, error);
    return;
  }
  report(kind, route(), clientErrorDetail(error, context));
}

/**
 * Vite dispatches `vite:preloadError` for every lazy module or stylesheet it
 * cannot load, before the import settles and before the recovery listener in
 * `vite-preload-recovery.ts` decides whether to reload. It is therefore the
 * one signal that covers both the recovered and the unrecoverable case.
 * Install it before the recovery listener so the beacon starts before a
 * reload is requested.
 */
export function installVitePreloadErrorReporting(options: {
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  routePattern: () => string;
  report?: Report;
}): () => void {
  // Vite puts the import error on the event as `payload`.
  const onPreloadError = (event: Event) =>
    noteChunkLoadFailure(
      options.routePattern,
      options.report,
      (event as Event & { payload?: unknown }).payload,
    );
  options.target.addEventListener("vite:preloadError", onPreloadError);
  return () => options.target.removeEventListener("vite:preloadError", onPreloadError);
}

function isBenignWindowError(event: ErrorEvent): boolean {
  const message = typeof event.message === "string" ? event.message : "";
  // Layout notifications the browser raises for ResizeObserver callbacks that
  // settle on the next frame. They are not failures.
  if (/^ResizeObserver loop/i.test(message)) return true;
  // Opaque cross-origin script errors (extensions, third-party scripts) carry
  // no error object and nothing the app can act on.
  return !event.error && /^Script error\.?$/i.test(message);
}

function isAbort(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Report uncaught window errors and unhandled promise rejections. Route render
 * failures are reported by the router's `defaultOnCatch` instead, because
 * React error boundaries swallow them before they reach `window`.
 */
export function installGlobalClientErrorReporting(options: {
  target: Pick<Window, "addEventListener" | "removeEventListener">;
  routePattern: () => string;
  report?: Report;
}): () => void {
  const report = options.report ?? reportClientError;
  const onError = (event: Event) => {
    const errorEvent = event as ErrorEvent;
    if (isBenignWindowError(errorEvent)) return;
    // Without an error object the event's own message is the best description.
    const error = errorEvent.error ?? { name: "ErrorEvent", message: String(errorEvent.message) };
    reportCaughtClientError(error, "window_error", options.routePattern, report, {
      location: {
        filename: errorEvent.filename,
        lineno: errorEvent.lineno,
        colno: errorEvent.colno,
      },
    });
  };
  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    if (isAbort(reason)) return;
    reportCaughtClientError(reason, "unhandled_rejection", options.routePattern, report);
  };
  options.target.addEventListener("error", onError);
  options.target.addEventListener("unhandledrejection", onRejection);
  return () => {
    options.target.removeEventListener("error", onError);
    options.target.removeEventListener("unhandledrejection", onRejection);
  };
}

// Minimal first-party web error beacon. It reports only a closed error kind,
// the matched route PATTERN (never the concrete URL), and the bundle revision
// to `POST /v1/client-errors`, which increments
// `opengeni_client_errors_total{kind}`. No message, stack, URL, identifier,
// cookie, or user content leaves the browser, so it is operational telemetry
// rather than consent-controlled product analytics (see
// apps/web/docs/browser-analytics.md). The wire grammar is shared with the API
// route and the public log projection through @opengeni/contracts.
import {
  CLIENT_ERROR_REVISION_PATTERN,
  CLIENT_ERROR_ROUTE_PATTERN,
  CLIENT_ERRORS_PATH,
  CLIENT_ERROR_KINDS,
  type ClientErrorKind,
  type ClientErrorReport,
} from "@opengeni/contracts/client-error-report";
import { rootRouteId } from "@tanstack/react-router";

export { CLIENT_ERRORS_PATH, CLIENT_ERROR_KINDS, type ClientErrorKind, type ClientErrorReport };

/** Reduce a router `fullPath` to the reportable pattern, or `unknown`. */
export function clientRoutePattern(fullPath: string | undefined | null): string {
  if (!fullPath) return "unknown";
  const trimmed = fullPath.length > 1 ? fullPath.replace(/\/+$/, "") : fullPath;
  return CLIENT_ERROR_ROUTE_PATTERN.test(trimmed) ? trimmed : "unknown";
}

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

export function clientRevision(value: string | undefined | null): string {
  return value && CLIENT_ERROR_REVISION_PATTERN.test(value) ? value : "unknown";
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

export type ClientErrorReporter = {
  report(kind: ClientErrorKind, route: string): boolean;
};

export type ClientErrorReporterOptions = {
  send: (body: string) => void;
  revision: string;
  now?: () => number;
  /** Suppress a repeat of the same kind and route within this window. */
  dedupeWindowMs?: number;
  /** At most this many reports per `rateWindowMs`, across all kinds. */
  maxReportsPerWindow?: number;
  rateWindowMs?: number;
};

/**
 * Client-side dedupe and rate limit. A render loop or a noisy listener can
 * throw hundreds of times a second; one report per kind and route per minute
 * and ten reports per ten minutes is enough signal for a counter.
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
    report(kind, route) {
      const at = now();
      const pattern = clientRoutePattern(route);
      const key = `${kind} ${pattern}`;
      const previous = lastReportedAt.get(key);
      if (previous !== undefined && at - previous < dedupeWindowMs) return false;
      sentAt = sentAt.filter((sent) => at - sent < rateWindowMs);
      if (sentAt.length >= maxReportsPerWindow) return false;
      sentAt.push(at);
      lastReportedAt.set(key, at);
      const report: ClientErrorReport = { kind, route: pattern, revision };
      try {
        options.send(JSON.stringify(report));
      } catch {
        // Reporting must never become a second failure.
      }
      return true;
    },
  };
}

/**
 * Fire-and-forget delivery. A text/plain body with no credentials or custom
 * headers is a simple request: no preflight, no cookies, and `keepalive` lets
 * it finish when the user reloads straight from the error page.
 */
export function beaconSender(
  url: string,
  fetchImpl: typeof fetch | undefined = globalThis.fetch,
): (body: string) => void {
  return (body) => {
    if (!fetchImpl) return;
    void fetchImpl(url, {
      method: "POST",
      body,
      credentials: "omit",
      keepalive: true,
      headers: { "content-type": "text/plain;charset=UTF-8" },
    }).catch(() => undefined);
  };
}

let defaultReporter: ClientErrorReporter | null = null;

/** Install the process-wide reporter. Tests and non-browser hosts leave it unset. */
export function setClientErrorReporter(reporter: ClientErrorReporter | null): void {
  defaultReporter = reporter;
}

export function reportClientError(kind: ClientErrorKind, route: string): void {
  defaultReporter?.report(kind, route);
}

type Report = (kind: ClientErrorKind, route: string) => void;

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
export function noteChunkLoadFailure(route: () => string, report: Report = reportClientError) {
  if (chunkLoadFailureObserved) return;
  chunkLoadFailureObserved = true;
  report("chunk_load", route());
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
): void {
  if (chunkLoadFailureObserved) return;
  if (isChunkLoadError(error)) {
    noteChunkLoadFailure(route, report);
    return;
  }
  report(kind, route());
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
  const onPreloadError = () => noteChunkLoadFailure(options.routePattern, options.report);
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
    reportCaughtClientError(errorEvent.error, "window_error", options.routePattern, report);
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

// Minimal first-party web error beacon. It reports only a closed error kind,
// the matched route PATTERN (never the concrete URL), and the bundle revision
// to `POST /v1/client-errors`, which increments
// `opengeni_client_errors_total{kind}`. No message, stack, URL, identifier,
// cookie, or user content leaves the browser, so it is operational telemetry
// rather than consent-controlled product analytics (see
// apps/web/docs/browser-analytics.md). Keep the grammar in lockstep with
// apps/api/src/routes/client-errors.ts.
import { rootRouteId } from "@tanstack/react-router";

export const CLIENT_ERRORS_PATH = "/v1/client-errors";

export const CLIENT_ERROR_KINDS = [
  "route_error",
  "unhandled_rejection",
  "window_error",
  "chunk_load",
] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

export type ClientErrorReport = { kind: ClientErrorKind; route: string; revision: string };

const ROUTE_SEGMENT = String.raw`(?:[a-z]+(?:-[a-z]+)*|\$[A-Za-z][A-Za-z0-9]{0,31})`;
const CLIENT_ROUTE_PATTERN = new RegExp(String.raw`^(?:unknown|/|(?:/${ROUTE_SEGMENT}){1,12})$`);
const CLIENT_REVISION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Reduce a router `fullPath` to the reportable pattern, or `unknown`. */
export function clientRoutePattern(fullPath: string | undefined | null): string {
  if (!fullPath) return "unknown";
  const trimmed = fullPath.length > 1 ? fullPath.replace(/\/+$/, "") : fullPath;
  return CLIENT_ROUTE_PATTERN.test(trimmed) ? trimmed : "unknown";
}

/** The leaf route's pattern, or `unknown` when only the root matched (not found). */
export function routePatternFromMatches(
  matches: ReadonlyArray<{ routeId: string; fullPath: string }>,
): string {
  const leaf = matches.at(-1);
  return leaf && leaf.routeId !== rootRouteId ? clientRoutePattern(leaf.fullPath) : "unknown";
}

export function clientRevision(value: string | undefined | null): string {
  return value && CLIENT_REVISION_PATTERN.test(value) ? value : "unknown";
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
  report?: (kind: ClientErrorKind, route: string) => void;
}): () => void {
  const report = options.report ?? reportClientError;
  const onError = (event: Event) => {
    const errorEvent = event as ErrorEvent;
    if (isBenignWindowError(errorEvent)) return;
    report(
      isChunkLoadError(errorEvent.error) ? "chunk_load" : "window_error",
      options.routePattern(),
    );
  };
  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    if (isAbort(reason)) return;
    report(isChunkLoadError(reason) ? "chunk_load" : "unhandled_rejection", options.routePattern());
  };
  options.target.addEventListener("error", onError);
  options.target.addEventListener("unhandledrejection", onRejection);
  return () => {
    options.target.removeEventListener("error", onError);
    options.target.removeEventListener("unhandledrejection", onRejection);
  };
}

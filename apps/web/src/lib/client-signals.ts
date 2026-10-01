// Content-free operational signals sent through the first-party beacon
// (`POST /v1/client-errors`, see client-error-reporting.ts). Like the error
// beacon this is not consent-gated product analytics: every report is a
// closed value from @opengeni/contracts/client-error-report plus the matched
// route PATTERN (or the closed page label) and the bundle revision. No URL,
// identifier, message, request or response content ever leaves the browser.
//
// - request failures: a key product mutation that never got an HTTP response
//   (`opengeni_client_request_failures_total{action,reason}`)
// - live-stream health (`opengeni_client_stream_events_total{stream,event}`),
//   produced by stream-health.ts
// - web vitals (`opengeni_client_web_vital{metric,page}`), produced by the
//   lazily loaded web-vitals-reporting.ts
import {
  CLIENT_WEB_VITAL_MAX_VALUE,
  type ClientPage,
  type ClientRequestAction,
  type ClientRequestFailureReason,
  type ClientSignalReport,
  type ClientStream,
  type ClientStreamEvent,
  type ClientWebVitalMetric,
} from "@opengeni/contracts/client-error-report";

import { clientRevision, clientRoutePattern } from "./client-route-pattern";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_PROVIDER_SEGMENTS = new Set(["codex", "supergrok", "ai-gateway", "openrouter"]);
const MODEL_CONNECT_LEAVES = new Set(["connect", "start", "credentials", "accounts", "import"]);

/**
 * Classify a same-origin API request as one of the closed key actions, or
 * null. Only the method and the path shape are read; ids in the path are
 * matched, never reported.
 */
export function clientRequestAction(pathname: string, method: string): ClientRequestAction | null {
  const verb = method.toUpperCase();
  const parts = pathname.split("/").filter(Boolean);
  const scope = parts[1];
  const rest = parts.slice(3);
  if (parts[0] !== "v1") return null;
  // Organization model-provider keys are saved with an idempotent PUT.
  if (
    verb === "PUT" &&
    scope === "organizations" &&
    UUID.test(parts[2] ?? "") &&
    rest.length === 2 &&
    rest[0] === "model-providers"
  ) {
    return "connect_model";
  }
  if (verb !== "POST") return null;
  if (pathname === "/v1/billing/checkout") return "checkout_start";
  if ((scope !== "workspaces" && scope !== "organizations") || !UUID.test(parts[2] ?? "")) {
    return null;
  }
  if (scope === "workspaces" && rest[0] === "sessions") {
    if (rest.length === 1) return "create_session";
    if (!UUID.test(rest[1] ?? "")) return null;
    const tail = rest.slice(2);
    if (tail.length === 1 && tail[0] === "events") return "send_message";
    if (tail.length === 1 && tail[0] === "steer") return "steer_message";
    if (tail.length === 3 && tail[0] === "queue" && tail[2] === "steer") return "steer_message";
    if (tail.length === 2 && tail[0] === "composer-draft" && tail[1] === "submit") {
      return "composer_submit";
    }
    if (tail.length === 1 && tail[0] === "retry") return "retry_turn";
    return null;
  }
  if (MODEL_PROVIDER_SEGMENTS.has(rest[0] ?? "")) {
    return MODEL_CONNECT_LEAVES.has(rest.at(-1) ?? "") ? "connect_model" : null;
  }
  if (scope === "workspaces" && isIntegrationConnectPath(rest)) return "connect_integration";
  return null;
}

/** Workspace integration connection creates and OAuth/app-install starts. */
function isIntegrationConnectPath(rest: readonly string[]): boolean {
  if (rest.length === 1 && rest[0] === "connections") return true;
  if (rest.length === 2 && rest[0] === "social" && rest[1] === "connections") return true;
  if (rest.length === 1 && rest[0] === "mcp-servers") return true;
  if (rest[0] === "integrations" && ["start", "connect", "install"].includes(rest.at(-1) ?? "")) {
    return true;
  }
  return false;
}

/**
 * Why a request produced no HTTP response, or null when it should not be
 * counted. An `AbortError` is a cancellation the user or the app initiated
 * (navigation, account change, a superseded request) and is never counted.
 */
export function clientRequestFailureReason(
  error: unknown,
  online: boolean,
): ClientRequestFailureReason | null {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === "AbortError") return null;
  if (name === "TimeoutError") return online ? "timeout" : "offline";
  // Browsers reject fetch with a TypeError for every transport failure (DNS,
  // refused or reset connection, CORS, offline). Anything else is not a
  // transport failure.
  if (!(error instanceof TypeError)) return null;
  return online ? "network" : "offline";
}

export type ClientSignalReporter = {
  requestFailure(action: ClientRequestAction, reason: ClientRequestFailureReason): boolean;
  stream(stream: ClientStream, event: ClientStreamEvent): boolean;
  webVital(metric: ClientWebVitalMetric, page: ClientPage, value: number): boolean;
};

export type ClientSignalReporterOptions = {
  send: (body: string) => void;
  revision: string;
  routePattern: () => string;
  now?: () => number;
  /** Suppress a repeat of the same request-failure or stream signal within this window. */
  dedupeWindowMs?: number;
  /** At most this many request-failure and stream reports per `rateWindowMs`. */
  maxReportsPerWindow?: number;
  rateWindowMs?: number;
};

/**
 * Client-side bounds. A flapping network can fail every request and drop
 * every stream many times a minute; one report per signal key per 30 seconds
 * and twenty per ten minutes is enough for a counter. Each web vital is
 * reported at most once per document.
 */
export function createClientSignalReporter(
  options: ClientSignalReporterOptions,
): ClientSignalReporter {
  const now = options.now ?? Date.now;
  const dedupeWindowMs = options.dedupeWindowMs ?? 30_000;
  const maxReportsPerWindow = options.maxReportsPerWindow ?? 20;
  const rateWindowMs = options.rateWindowMs ?? 10 * 60_000;
  const revision = clientRevision(options.revision);
  const lastReportedAt = new Map<string, number>();
  const reportedVitals = new Set<ClientWebVitalMetric>();
  let sentAt: number[] = [];
  const send = (report: ClientSignalReport) => {
    try {
      options.send(JSON.stringify(report));
    } catch {
      // Reporting must never become a second failure.
    }
  };
  const admit = (key: string) => {
    const at = now();
    const previous = lastReportedAt.get(key);
    if (previous !== undefined && at - previous < dedupeWindowMs) return false;
    sentAt = sentAt.filter((sent) => at - sent < rateWindowMs);
    if (sentAt.length >= maxReportsPerWindow) return false;
    sentAt.push(at);
    lastReportedAt.set(key, at);
    return true;
  };
  const route = () => {
    try {
      return clientRoutePattern(options.routePattern());
    } catch {
      return "unknown";
    }
  };
  return {
    requestFailure(action, reason) {
      if (!admit(`request_failure ${action} ${reason}`)) return false;
      send({ signal: "request_failure", action, reason, route: route(), revision });
      return true;
    },
    stream(stream, event) {
      if (!admit(`stream ${stream} ${event}`)) return false;
      send({ signal: "stream", stream, event, route: route(), revision });
      return true;
    },
    webVital(metric, page, value) {
      if (reportedVitals.has(metric)) return false;
      if (!Number.isFinite(value) || value < 0 || value > CLIENT_WEB_VITAL_MAX_VALUE[metric]) {
        return false;
      }
      reportedVitals.add(metric);
      send({
        signal: "web_vital",
        metric,
        page,
        value: Math.round(value * 10_000) / 10_000,
        revision,
      });
      return true;
    },
  };
}

let defaultReporter: ClientSignalReporter | null = null;

/** Install the process-wide reporter. Tests and non-browser hosts leave it unset. */
export function setClientSignalReporter(reporter: ClientSignalReporter | null): void {
  defaultReporter = reporter;
}

/**
 * Count a key request that failed before any HTTP response. Called by the
 * console's fetch boundary with the request's path and method; requests that
 * are not key actions and cancellations are ignored.
 */
export function noteClientRequestFailure(
  pathname: string | null,
  method: string,
  error: unknown,
  online: boolean = typeof navigator === "undefined" || navigator.onLine !== false,
): void {
  try {
    if (!defaultReporter || !pathname) return;
    const action = clientRequestAction(pathname, method);
    const reason = action ? clientRequestFailureReason(error, online) : null;
    if (action && reason) defaultReporter.requestFailure(action, reason);
  } catch {
    // Telemetry must never affect transport.
  }
}

export function reportClientStreamEvent(stream: ClientStream, event: ClientStreamEvent): void {
  defaultReporter?.stream(stream, event);
}

export function reportClientWebVital(
  metric: ClientWebVitalMetric,
  page: ClientPage,
  value: number,
): void {
  defaultReporter?.webVital(metric, page, value);
}

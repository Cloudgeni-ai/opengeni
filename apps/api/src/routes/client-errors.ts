// Minimal first-party web-client error beacon.
//
// The browser reports only a closed error kind, the matched route PATTERN
// (never a concrete URL), and its bundle revision. No message, stack, URL,
// identifier, user content, or credential is accepted, and the route admits
// anonymous callers so a failure before sign-in is still counted. Each
// accepted report increments one closed-label counter and writes one bounded
// structured log line. This is an operational lower bound, not exception
// capture: blocked requests, closed tabs, and the per-process admission bound
// all drop reports. Because the route is anonymous, any HTTP client that omits
// or forges `Origin` can still send reports up to the admission ceiling, so
// alert on rates and ratios, not on absolute counts.
//
// The same route admits closed operational signals discriminated by a
// `signal` field: key requests that failed before any HTTP response
// (`opengeni_client_request_failures_total{action,reason}`), live-stream health
// (`opengeni_client_stream_events_total{stream,event}`), and web vitals
// (`opengeni_client_web_vital{metric,page}`). They carry the same closed-value
// guarantees and have their own per-key admission buckets, so a burst of one
// signal never spends the error kinds' budget.
import type { Settings } from "@opengeni/config";
import {
  CLIENT_ERROR_KINDS,
  CLIENT_ERROR_REPORT_MAX_BYTES,
  CLIENT_ERROR_REVISION_PATTERN,
  CLIENT_ERROR_ROUTE_PATTERN,
  CLIENT_ERRORS_PATH,
  CLIENT_PAGES,
  CLIENT_REQUEST_ACTIONS,
  CLIENT_REQUEST_FAILURE_REASONS,
  CLIENT_SIGNALS,
  CLIENT_STREAM_EVENTS,
  CLIENT_STREAMS,
  CLIENT_WEB_VITAL_MAX_VALUE,
  CLIENT_WEB_VITAL_METRICS,
  type ClientErrorKind,
  type ClientSignal,
} from "@opengeni/contracts/client-error-report";
import type { Observability } from "@opengeni/observability";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { isAllowedBrowserOrigin } from "../http/cors";
import { createKeyedAdmission, type KeyedAdmission } from "../http/keyed-admission";

export {
  CLIENT_ERROR_KINDS,
  CLIENT_ERROR_REPORT_MAX_BYTES,
  CLIENT_ERRORS_PATH,
  type ClientErrorKind,
};

const CLIENT_ERROR_REJECTION_REASONS = ["invalid", "too_large", "origin", "rate_limited"] as const;
type ClientErrorRejectionReason = (typeof CLIENT_ERROR_REJECTION_REASONS)[number];

export const ClientErrorReport = z
  .object({
    kind: z.enum(CLIENT_ERROR_KINDS),
    route: z.string().regex(CLIENT_ERROR_ROUTE_PATTERN),
    revision: z.string().regex(CLIENT_ERROR_REVISION_PATTERN),
  })
  .strict();
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;

const route = z.string().regex(CLIENT_ERROR_ROUTE_PATTERN);
const revision = z.string().regex(CLIENT_ERROR_REVISION_PATTERN);

export const ClientSignalReport = z.discriminatedUnion("signal", [
  z
    .object({
      signal: z.literal("request_failure"),
      action: z.enum(CLIENT_REQUEST_ACTIONS),
      reason: z.enum(CLIENT_REQUEST_FAILURE_REASONS),
      route,
      revision,
    })
    .strict(),
  z
    .object({
      signal: z.literal("stream"),
      stream: z.enum(CLIENT_STREAMS),
      event: z.enum(CLIENT_STREAM_EVENTS),
      route,
      revision,
    })
    .strict(),
  z
    .object({
      signal: z.literal("web_vital"),
      metric: z.enum(CLIENT_WEB_VITAL_METRICS),
      page: z.enum(CLIENT_PAGES),
      value: z.number().finite().nonnegative(),
      revision,
    })
    .strict()
    .refine((report) => report.value <= CLIENT_WEB_VITAL_MAX_VALUE[report.metric]),
]);
export type ClientSignalReport = z.infer<typeof ClientSignalReport>;
export type ClientBeaconReport = ClientErrorReport | ClientSignalReport;

const CLIENT_ERRORS_METRIC = {
  name: "opengeni_client_errors_total",
  help: "Web client errors reported by browsers, by closed kind. Admission is bounded per API process, so this is a lower bound.",
} as const;
const CLIENT_ERROR_REJECTIONS_METRIC = {
  name: "opengeni_client_error_reports_rejected_total",
  help: 'Web client error reports the API refused, by closed reason and kind ("unknown" when the body was not read or not valid).',
} as const;

const CLIENT_REQUEST_FAILURES_METRIC = {
  name: "opengeni_client_request_failures_total",
  help: "Key web client requests that failed before any HTTP response, by closed action and reason (network, timeout, offline). Admission is bounded per API process, so this is a lower bound.",
} as const;
const CLIENT_STREAM_EVENTS_METRIC = {
  name: "opengeni_client_stream_events_total",
  help: "Web client live-stream health events, by stream (session, workspace) and closed event (reconnect, reconnect_exhausted, long_disconnect). Admission is bounded per API process, so this is a lower bound.",
} as const;
const CLIENT_WEB_VITAL_METRIC = {
  name: "opengeni_client_web_vital",
  help: "Web vitals reported by browsers, by metric and closed page label. lcp, inp and ttfb are seconds; cls is the unitless layout-shift score.",
} as const;
/**
 * Bucket bounds cover the published good/poor thresholds of every metric:
 * CLS 0.1/0.25, INP 0.2/0.5 s, TTFB 0.8/1.8 s, LCP 2.5/4 s.
 */
export const CLIENT_WEB_VITAL_BUCKETS = [
  0.01, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 0.8, 1, 1.8, 2.5, 4, 6, 10, 20, 60,
];

export type ClientErrorAdmission = KeyedAdmission<ClientErrorKind>;
/** Keyed by `<signal>:<closed dimension>`, a finite set of buckets. */
export type ClientSignalAdmission = KeyedAdmission<string>;

/** Same bounds as the error kinds: one bucket per closed signal key. */
export function createClientSignalAdmission(
  options: { capacity?: number; refillPerSecond?: number; now?: () => number } = {},
): ClientSignalAdmission {
  return createKeyedAdmission<string>(options);
}

function signalAdmissionKey(report: ClientSignalReport): string {
  switch (report.signal) {
    case "request_failure":
      return `request_failure:${report.action}`;
    case "stream":
      return `stream:${report.stream}:${report.event}`;
    case "web_vital":
      return `web_vital:${report.metric}`;
  }
}

/**
 * One token bucket per closed kind bounds counter inflation and log volume
 * from any caller, including an anonymous one, without per-client state.
 */
export function createClientErrorAdmission(
  options: { capacity?: number; refillPerSecond?: number; now?: () => number } = {},
): ClientErrorAdmission {
  return createKeyedAdmission<ClientErrorKind>(options);
}

export function parseClientErrorReport(body: string | null): ClientErrorReport | null {
  const report = parseClientBeaconReport(body);
  return report && !isClientSignalReport(report) ? report : null;
}

/** Parse any accepted beacon body: an error report or a closed signal report. */
export function parseClientBeaconReport(body: string | null): ClientBeaconReport | null {
  if (body === null || new TextEncoder().encode(body).byteLength > CLIENT_ERROR_REPORT_MAX_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const error = ClientErrorReport.safeParse(value);
  if (error.success) return error.data;
  const signal = ClientSignalReport.safeParse(value);
  return signal.success ? signal.data : null;
}

export function isClientSignalReport(report: ClientBeaconReport): report is ClientSignalReport {
  return "signal" in report;
}

/**
 * The exact beacon request. The app-wide request-body limit skips it because
 * the route enforces its own 512-byte limit on the streamed body; the generic
 * ceiling would otherwise buffer a chunked body of many megabytes on an
 * anonymous route before this one could refuse it.
 */
export function isClientErrorReportRequest(method: string, pathname: string): boolean {
  return method === "POST" && pathname === CLIENT_ERRORS_PATH;
}

export function registerClientErrorRoutes(
  app: Hono,
  deps: {
    observability: Observability;
    settings: Pick<Settings, "corsAllowOriginRegex" | "publicBaseUrl" | "webBaseUrl">;
    admission?: ClientErrorAdmission;
    signalAdmission?: ClientSignalAdmission;
  },
): void {
  const { observability, settings } = deps;
  const admission = deps.admission ?? createClientErrorAdmission();
  const signalAdmission = deps.signalAdmission ?? createClientSignalAdmission();
  // Publish the finite series at zero so the first failure after a deploy is
  // an increase from a baseline rather than a series appearing from nothing.
  for (const kind of CLIENT_ERROR_KINDS) {
    observability.incrementCounter({ ...CLIENT_ERRORS_METRIC, labels: { kind }, amount: 0 });
    observability.incrementCounter({
      ...CLIENT_ERROR_REJECTIONS_METRIC,
      labels: { reason: "rate_limited", kind },
      amount: 0,
    });
  }
  for (const action of CLIENT_REQUEST_ACTIONS) {
    for (const reason of CLIENT_REQUEST_FAILURE_REASONS) {
      observability.incrementCounter({
        ...CLIENT_REQUEST_FAILURES_METRIC,
        labels: { action, reason },
        amount: 0,
      });
    }
  }
  for (const stream of CLIENT_STREAMS) {
    for (const event of CLIENT_STREAM_EVENTS) {
      observability.incrementCounter({
        ...CLIENT_STREAM_EVENTS_METRIC,
        labels: { stream, event },
        amount: 0,
      });
    }
  }
  // A rate-limited signal report is counted under its signal name as `kind`.
  for (const signal of CLIENT_SIGNALS) {
    observability.incrementCounter({
      ...CLIENT_ERROR_REJECTIONS_METRIC,
      labels: { reason: "rate_limited", kind: signal },
      amount: 0,
    });
  }
  for (const reason of CLIENT_ERROR_REJECTION_REASONS) {
    if (reason === "rate_limited") continue;
    observability.incrementCounter({
      ...CLIENT_ERROR_REJECTIONS_METRIC,
      labels: { reason, kind: "unknown" },
      amount: 0,
    });
  }
  // A rate-limited refusal keeps its kind, so accepted plus rejected is the
  // true per-kind arrival rate even while a bucket is empty.
  const reject = (
    c: Context,
    reason: ClientErrorRejectionReason,
    status: 400 | 403 | 413 | 429,
    kind: ClientErrorKind | ClientSignal | "unknown" = "unknown",
  ) => {
    observability.incrementCounter({ ...CLIENT_ERROR_REJECTIONS_METRIC, labels: { reason, kind } });
    c.header("cache-control", "no-store");
    return c.body(null, status);
  };

  app.post(
    CLIENT_ERRORS_PATH,
    // Enforced on the streamed body, so a chunked request without a
    // Content-Length is refused after 512 bytes rather than buffered.
    bodyLimit({
      maxSize: CLIENT_ERROR_REPORT_MAX_BYTES,
      onError: (c) => reject(c, "too_large", 413),
    }),
    async (c) => {
      c.header("cache-control", "no-store");
      // Browsers always send Origin on this cross- or same-origin POST. A
      // foreign page therefore cannot spend the admission budget or inflate
      // the counter through its visitors' browsers.
      const origin = c.req.header("origin");
      if (origin !== undefined && !isAllowedBrowserOrigin(origin, settings)) {
        return reject(c, "origin", 403);
      }
      const report = parseClientBeaconReport(await c.req.text().catch(() => null));
      if (!report) return reject(c, "invalid", 400);
      if (isClientSignalReport(report)) {
        if (!signalAdmission.admit(signalAdmissionKey(report))) {
          return reject(c, "rate_limited", 429, report.signal);
        }
        recordClientSignal(observability, report);
        return c.body(null, 204);
      }
      if (!admission.admit(report.kind)) return reject(c, "rate_limited", 429, report.kind);
      observability.incrementCounter({ ...CLIENT_ERRORS_METRIC, labels: { kind: report.kind } });
      observability.warn("Web client error reported", {
        surface: "web",
        reason: report.kind,
        clientRoute: report.route,
        clientRevision: report.revision,
      });
      return c.body(null, 204);
    },
  );
}

function recordClientSignal(observability: Observability, report: ClientSignalReport): void {
  switch (report.signal) {
    case "request_failure":
      observability.incrementCounter({
        ...CLIENT_REQUEST_FAILURES_METRIC,
        labels: { action: report.action, reason: report.reason },
      });
      observability.warn("Web client request failed before a response", {
        surface: "web",
        op: report.action,
        reason: report.reason,
        clientRoute: report.route,
        clientRevision: report.revision,
      });
      return;
    case "stream":
      observability.incrementCounter({
        ...CLIENT_STREAM_EVENTS_METRIC,
        labels: { stream: report.stream, event: report.event },
      });
      // An ordinary reconnect is routine; only a stream that gave up or stayed
      // down is worth a log line.
      if (report.event !== "reconnect") {
        observability.warn("Web client live stream degraded", {
          surface: "web",
          op: report.stream,
          reason: report.event,
          clientRoute: report.route,
          clientRevision: report.revision,
        });
      }
      return;
    case "web_vital":
      observability.observeHistogram({
        ...CLIENT_WEB_VITAL_METRIC,
        labels: { metric: report.metric, page: report.page },
        value: report.value,
        buckets: CLIENT_WEB_VITAL_BUCKETS,
      });
      return;
  }
}

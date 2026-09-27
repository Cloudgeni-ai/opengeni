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
import type { Settings } from "@opengeni/config";
import {
  CLIENT_ERROR_KINDS,
  CLIENT_ERROR_REPORT_MAX_BYTES,
  CLIENT_ERROR_REVISION_PATTERN,
  CLIENT_ERROR_ROUTE_PATTERN,
  CLIENT_ERRORS_PATH,
  type ClientErrorKind,
} from "@opengeni/contracts/client-error-report";
import type { Observability } from "@opengeni/observability";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { isAllowedBrowserOrigin } from "../http/cors";

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

const CLIENT_ERRORS_METRIC = {
  name: "opengeni_client_errors_total",
  help: "Web client errors reported by browsers, by closed kind. Admission is bounded per API process, so this is a lower bound.",
} as const;
const CLIENT_ERROR_REJECTIONS_METRIC = {
  name: "opengeni_client_error_reports_rejected_total",
  help: 'Web client error reports the API refused, by closed reason and kind ("unknown" when the body was not read or not valid).',
} as const;

export type ClientErrorAdmission = { admit(kind: ClientErrorKind): boolean };

/**
 * One token bucket per closed kind bounds counter inflation and log volume
 * from any caller, including an anonymous one, without per-client state.
 */
export function createClientErrorAdmission(
  options: { capacity?: number; refillPerSecond?: number; now?: () => number } = {},
): ClientErrorAdmission {
  const capacity = options.capacity ?? 30;
  const refillPerMs = (options.refillPerSecond ?? 0.5) / 1_000;
  const now = options.now ?? Date.now;
  const buckets = new Map<ClientErrorKind, { tokens: number; updatedAt: number }>();
  return {
    admit(kind) {
      const at = now();
      const bucket = buckets.get(kind) ?? { tokens: capacity, updatedAt: at };
      bucket.tokens = Math.min(
        capacity,
        bucket.tokens + Math.max(0, at - bucket.updatedAt) * refillPerMs,
      );
      bucket.updatedAt = at;
      buckets.set(kind, bucket);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}

export function parseClientErrorReport(body: string | null): ClientErrorReport | null {
  if (body === null || new TextEncoder().encode(body).byteLength > CLIENT_ERROR_REPORT_MAX_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = ClientErrorReport.safeParse(value);
  return parsed.success ? parsed.data : null;
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
  },
): void {
  const { observability, settings } = deps;
  const admission = deps.admission ?? createClientErrorAdmission();
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
    kind: ClientErrorKind | "unknown" = "unknown",
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
      const report = parseClientErrorReport(await c.req.text().catch(() => null));
      if (!report) return reject(c, "invalid", 400);
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

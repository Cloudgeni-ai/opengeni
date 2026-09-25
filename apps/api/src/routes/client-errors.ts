import type { Observability } from "@opengeni/observability";
import type { Hono } from "hono";
import { z } from "zod";

/**
 * Minimal first-party web-client error beacon.
 *
 * The browser reports only a closed error kind, the matched route PATTERN
 * (never a concrete URL), and its bundle revision. No message, stack, URL,
 * identifier, user content, or credential is accepted, and the route admits
 * anonymous callers so a failure before sign-in is still counted. Each
 * accepted report increments one closed-label counter and writes one bounded
 * structured log line. This is an operational lower bound, not exception
 * capture: blocked requests, closed tabs, and the per-process admission bound
 * all drop reports.
 */
export const CLIENT_ERRORS_PATH = "/v1/client-errors";

export const CLIENT_ERROR_KINDS = [
  "route_error",
  "unhandled_rejection",
  "window_error",
  "chunk_load",
] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

const CLIENT_ERROR_REJECTION_REASONS = ["invalid", "too_large", "rate_limited"] as const;
type ClientErrorRejectionReason = (typeof CLIENT_ERROR_REJECTION_REASONS)[number];

/** Largest accepted report body. A valid report is well under 256 bytes. */
export const CLIENT_ERROR_REPORT_MAX_BYTES = 512;

/**
 * A route pattern is `/`, `unknown`, or `/`-separated segments that are each
 * either a lowercase literal (`variable-sets`) or a `$param` placeholder. The
 * grammar excludes digits in literals, so a concrete id cannot pass as one.
 */
const ROUTE_SEGMENT = String.raw`(?:[a-z]+(?:-[a-z]+)*|\$[A-Za-z][A-Za-z0-9]{0,31})`;
const CLIENT_ROUTE_PATTERN = new RegExp(String.raw`^(?:unknown|/|(?:/${ROUTE_SEGMENT}){1,12})$`);
const CLIENT_REVISION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const ClientErrorReport = z
  .object({
    kind: z.enum(CLIENT_ERROR_KINDS),
    route: z.string().max(160).regex(CLIENT_ROUTE_PATTERN),
    revision: z.string().regex(CLIENT_REVISION_PATTERN),
  })
  .strict();
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;

const CLIENT_ERRORS_METRIC = {
  name: "opengeni_client_errors_total",
  help: "Web client errors reported by browsers, by closed kind. Admission is bounded per API process, so this is a lower bound.",
} as const;
const CLIENT_ERROR_REJECTIONS_METRIC = {
  name: "opengeni_client_error_reports_rejected_total",
  help: "Web client error reports the API refused, by closed reason.",
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

export function registerClientErrorRoutes(
  app: Hono,
  deps: { observability: Observability; admission?: ClientErrorAdmission },
): void {
  const { observability } = deps;
  const admission = deps.admission ?? createClientErrorAdmission();
  // Publish the finite series at zero so the first failure after a deploy is
  // an increase from a baseline rather than a series appearing from nothing.
  for (const kind of CLIENT_ERROR_KINDS) {
    observability.incrementCounter({ ...CLIENT_ERRORS_METRIC, labels: { kind }, amount: 0 });
  }
  for (const reason of CLIENT_ERROR_REJECTION_REASONS) {
    observability.incrementCounter({
      ...CLIENT_ERROR_REJECTIONS_METRIC,
      labels: { reason },
      amount: 0,
    });
  }
  const reject = (reason: ClientErrorRejectionReason) =>
    observability.incrementCounter({ ...CLIENT_ERROR_REJECTIONS_METRIC, labels: { reason } });

  app.post(CLIENT_ERRORS_PATH, async (c) => {
    c.header("cache-control", "no-store");
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > CLIENT_ERROR_REPORT_MAX_BYTES) {
      reject("too_large");
      return c.body(null, 413);
    }
    const report = parseClientErrorReport(await c.req.text().catch(() => null));
    if (!report) {
      reject("invalid");
      return c.body(null, 400);
    }
    if (!admission.admit(report.kind)) {
      reject("rate_limited");
      return c.body(null, 429);
    }
    observability.incrementCounter({ ...CLIENT_ERRORS_METRIC, labels: { kind: report.kind } });
    observability.warn("Web client error reported", {
      surface: "web",
      reason: report.kind,
      clientRoute: report.route,
      clientRevision: report.revision,
    });
    return c.body(null, 204);
  });
}

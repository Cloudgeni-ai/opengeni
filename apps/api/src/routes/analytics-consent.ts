// Content-free analytics consent beacon.
//
// When a person answers the web console's optional-analytics banner, the
// browser reports only the closed decision (`granted` or `denied`). Each
// accepted report increments `opengeni_analytics_consent_total{decision}`, so
// product reports can state how much of the audience the consent-gated
// analytics providers never see. The body carries no identifier, URL, cookie,
// or user content, the browser sends it with `credentials: "omit"`, and the
// route writes no log line. It admits anonymous callers because the banner is
// answered before sign-in too. Any HTTP client that omits `Origin` can still
// send reports up to the admission ceiling, so read the counter as a ratio of
// decisions, not as a count of people.
import type { Settings } from "@opengeni/config";
import {
  ANALYTICS_CONSENT_DECISIONS,
  ANALYTICS_CONSENT_PATH,
  ANALYTICS_CONSENT_REPORT_MAX_BYTES,
  type AnalyticsConsentDecision,
} from "@opengeni/contracts/analytics-consent-report";
import type { Observability } from "@opengeni/observability";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { isAllowedBrowserOrigin } from "../http/cors";
import { createKeyedAdmission, type KeyedAdmission } from "../http/keyed-admission";

export { ANALYTICS_CONSENT_DECISIONS, ANALYTICS_CONSENT_PATH, type AnalyticsConsentDecision };

const REJECTION_REASONS = ["invalid", "too_large", "origin", "rate_limited"] as const;
type RejectionReason = (typeof REJECTION_REASONS)[number];

export const AnalyticsConsentReport = z
  .object({ decision: z.enum(ANALYTICS_CONSENT_DECISIONS) })
  .strict();
export type AnalyticsConsentReport = z.infer<typeof AnalyticsConsentReport>;

const CONSENT_METRIC = {
  name: "opengeni_analytics_consent_total",
  help: "Answers to the web console's optional-analytics banner, by closed decision. Admission is bounded per API process, so this is a lower bound.",
} as const;
const REJECTIONS_METRIC = {
  name: "opengeni_analytics_consent_reports_rejected_total",
  help: "Analytics consent reports the API refused, by closed reason.",
} as const;

export type AnalyticsConsentAdmission = KeyedAdmission<AnalyticsConsentDecision>;

export function parseAnalyticsConsentReport(body: string | null): AnalyticsConsentReport | null {
  if (
    body === null ||
    new TextEncoder().encode(body).byteLength > ANALYTICS_CONSENT_REPORT_MAX_BYTES
  ) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = AnalyticsConsentReport.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The exact beacon request. The app-wide request-body limit skips it because
 * the route enforces its own small limit on the streamed body.
 */
export function isAnalyticsConsentReportRequest(method: string, pathname: string): boolean {
  return method === "POST" && pathname === ANALYTICS_CONSENT_PATH;
}

export function registerAnalyticsConsentRoutes(
  app: Hono,
  deps: {
    observability: Observability;
    settings: Pick<Settings, "corsAllowOriginRegex" | "publicBaseUrl" | "webBaseUrl">;
    admission?: AnalyticsConsentAdmission;
  },
): void {
  const { observability, settings } = deps;
  // Consent answers are rare (once per browser), so a small burst and a slow
  // refill still cover a launch-day spike on each API process.
  const admission =
    deps.admission ??
    createKeyedAdmission<AnalyticsConsentDecision>({ capacity: 60, refillPerSecond: 1 });
  // Publish every finite series at zero so the first answer after a deploy is
  // an increase from a baseline rather than a series appearing from nothing.
  for (const decision of ANALYTICS_CONSENT_DECISIONS) {
    observability.incrementCounter({ ...CONSENT_METRIC, labels: { decision }, amount: 0 });
  }
  for (const reason of REJECTION_REASONS) {
    observability.incrementCounter({ ...REJECTIONS_METRIC, labels: { reason }, amount: 0 });
  }
  const reject = (c: Context, reason: RejectionReason, status: 400 | 403 | 413 | 429) => {
    observability.incrementCounter({ ...REJECTIONS_METRIC, labels: { reason } });
    c.header("cache-control", "no-store");
    return c.body(null, status);
  };

  app.post(
    ANALYTICS_CONSENT_PATH,
    bodyLimit({
      maxSize: ANALYTICS_CONSENT_REPORT_MAX_BYTES,
      onError: (c) => reject(c, "too_large", 413),
    }),
    async (c) => {
      c.header("cache-control", "no-store");
      // Browsers always send Origin on this POST, so a foreign page cannot
      // inflate the counter through its visitors' browsers.
      const origin = c.req.header("origin");
      if (origin !== undefined && !isAllowedBrowserOrigin(origin, settings)) {
        return reject(c, "origin", 403);
      }
      const report = parseAnalyticsConsentReport(await c.req.text().catch(() => null));
      if (!report) return reject(c, "invalid", 400);
      if (!admission.admit(report.decision)) return reject(c, "rate_limited", 429);
      observability.incrementCounter({ ...CONSENT_METRIC, labels: { decision: report.decision } });
      return c.body(null, 204);
    },
  );
}

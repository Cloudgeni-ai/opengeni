import { describe, expect, test } from "bun:test";
import { ANALYTICS_CONSENT_REPORT_MAX_BYTES } from "@opengeni/contracts/analytics-consent-report";
import { createObservability } from "@opengeni/observability";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { Hono } from "hono";

import { createApp, isApiContractProtectedMutation, routeLabel } from "../src/app";
import { createKeyedAdmission } from "../src/http/keyed-admission";
import {
  ANALYTICS_CONSENT_DECISIONS,
  type AnalyticsConsentDecision,
  parseAnalyticsConsentReport,
  registerAnalyticsConsentRoutes,
} from "../src/routes/analytics-consent";

const observabilitySettings = {
  serviceName: "opengeni",
  environment: "test",
  deploymentRevision: "revision-test",
  observabilityStructuredLogs: true,
  observabilityMetricsEnabled: true,
  observabilityOtlpEndpoint: "",
  observabilityOtlpHeaders: "",
};

const originSettings = {
  corsAllowOriginRegex: String.raw`^https?://(localhost|127\.0\.0\.1)(:\d+)?$`,
  publicBaseUrl: "https://app.opengeni.test",
};

const CONSENT = "opengeni_analytics_consent_total";
const REJECTED = "opengeni_analytics_consent_reports_rejected_total";

function post(app: Hono | ReturnType<typeof createApp>, body: string, headers = {}) {
  return app.request("/v1/analytics-consent", {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", ...headers },
    body,
  });
}

function metricValue(metrics: string, name: string, labels: string): number | null {
  const line = metrics
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name}{`) && candidate.includes(labels));
  return line ? Number(line.split(" ").at(-1)) : null;
}

async function quietly<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (message?: unknown) => warnings.push(String(message));
  // Request-completion info lines are not under test here.
  console.log = () => undefined;
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
}

describe("analytics consent report contract", () => {
  test("accepts only the closed decision", () => {
    for (const decision of ANALYTICS_CONSENT_DECISIONS) {
      expect(parseAnalyticsConsentReport(JSON.stringify({ decision }))).toEqual({ decision });
    }
    for (const body of [
      null,
      "",
      "not json",
      JSON.stringify({}),
      JSON.stringify({ decision: "maybe" }),
      JSON.stringify({ decision: "GRANTED" }),
      JSON.stringify({ decision: "granted", userId: "user-1" }),
      JSON.stringify({ decision: "denied", url: "https://app.opengeni.test/?token=x" }),
      JSON.stringify({
        decision: "granted",
        padding: "x".repeat(ANALYTICS_CONSENT_REPORT_MAX_BYTES),
      }),
    ]) {
      expect(parseAnalyticsConsentReport(body)).toBeNull();
    }
  });
});

describe("POST /v1/analytics-consent", () => {
  test("counts each decision from zero and writes no log line", async () => {
    const observability = createObservability(observabilitySettings, { component: "api" });
    const app = new Hono();
    registerAnalyticsConsentRoutes(app, { observability, settings: originSettings });

    const baseline = await observability.prometheusMetrics();
    for (const decision of ANALYTICS_CONSENT_DECISIONS) {
      expect(metricValue(baseline, CONSENT, `decision="${decision}"`)).toBe(0);
    }
    for (const reason of ["invalid", "too_large", "origin", "rate_limited"]) {
      expect(metricValue(baseline, REJECTED, `reason="${reason}"`)).toBe(0);
    }

    const { result: statuses, warnings } = await quietly(async () => [
      (
        await post(app, JSON.stringify({ decision: "denied" }), {
          origin: originSettings.publicBaseUrl,
        })
      ).status,
      (await post(app, JSON.stringify({ decision: "granted" }))).status,
      (await post(app, JSON.stringify({ decision: "denied" }))).status,
    ]);
    expect(statuses).toEqual([204, 204, 204]);
    expect(warnings).toEqual([]);
    const metrics = await observability.prometheusMetrics();
    expect(metricValue(metrics, CONSENT, 'decision="denied"')).toBe(2);
    expect(metricValue(metrics, CONSENT, 'decision="granted"')).toBe(1);
  });

  test("refuses invalid, oversized, foreign, and over-budget reports without counting them", async () => {
    const observability = createObservability(observabilitySettings, { component: "api" });
    const app = new Hono();
    registerAnalyticsConsentRoutes(app, {
      observability,
      settings: originSettings,
      admission: createKeyedAdmission<AnalyticsConsentDecision>({
        capacity: 1,
        refillPerSecond: 0,
        now: () => 0,
      }),
    });

    await quietly(async () => {
      expect((await post(app, JSON.stringify({ decision: "granted", id: "x" }))).status).toBe(400);
      expect(
        (
          await post(app, "x".repeat(16), {
            "content-length": String(ANALYTICS_CONSENT_REPORT_MAX_BYTES + 1),
          })
        ).status,
      ).toBe(413);
      expect(
        (
          await post(app, JSON.stringify({ decision: "granted" }), {
            origin: "https://attacker.example",
          })
        ).status,
      ).toBe(403);
      expect((await post(app, JSON.stringify({ decision: "granted" }))).status).toBe(204);
      const limited = await post(app, JSON.stringify({ decision: "granted" }));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("cache-control")).toBe("no-store");
      // Each decision has its own budget.
      expect((await post(app, JSON.stringify({ decision: "denied" }))).status).toBe(204);
    });

    const metrics = await observability.prometheusMetrics();
    expect(metricValue(metrics, CONSENT, 'decision="granted"')).toBe(1);
    expect(metricValue(metrics, CONSENT, 'decision="denied"')).toBe(1);
    for (const reason of ["invalid", "too_large", "origin", "rate_limited"]) {
      expect(metricValue(metrics, REJECTED, `reason="${reason}"`)).toBe(1);
    }
  });

  test("refuses a streamed body over the limit without buffering it", async () => {
    const observability = createObservability(observabilitySettings, { component: "api" });
    const app = createApp({
      settings: { ...testSettings(), ...originSettings },
      db: {} as never,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
      managedAuth: null,
      observability,
    });
    let pulledChunks = 0;
    const chunk = new TextEncoder().encode("x".repeat(64));
    // No Content-Length: the declared-length check cannot see this body.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulledChunks += 1;
        if (pulledChunks > 256) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const { result: response } = await quietly(() =>
      app.request("/v1/analytics-consent", {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(pulledChunks).toBeLessThan(8);
    const metrics = await observability.prometheusMetrics();
    expect(metricValue(metrics, REJECTED, 'reason="too_large"')).toBe(1);
  });

  test("is reachable anonymously behind the deployment key and across API contract changes", async () => {
    expect(isApiContractProtectedMutation("POST", "/v1/analytics-consent")).toBe(false);
    expect(routeLabel("/v1/analytics-consent")).toBe("/v1/analytics-consent");

    const observability = createObservability(observabilitySettings, { component: "api" });
    const app = createApp({
      settings: { ...testSettings(), authRequired: true, accessKey: "deployment-key" },
      db: {} as never,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
      managedAuth: null,
      observability,
    });

    const { result: response } = await quietly(() =>
      post(app, JSON.stringify({ decision: "granted" })),
    );
    expect(response.status).toBe(204);
    expect(
      metricValue(await observability.prometheusMetrics(), CONSENT, 'decision="granted"'),
    ).toBe(1);
    // Only the beacon's POST is public; other methods keep the deployment key.
    const { result: read } = await quietly(() => app.request("/v1/analytics-consent"));
    expect(read.status).toBe(401);
  });
});

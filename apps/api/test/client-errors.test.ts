import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { Hono } from "hono";

import { createApp, isApiContractProtectedMutation, routeLabel } from "../src/app";
import {
  CLIENT_ERROR_KINDS,
  CLIENT_ERROR_REPORT_MAX_BYTES,
  createClientErrorAdmission,
  createClientSignalAdmission,
  parseClientBeaconReport,
  parseClientErrorReport,
  registerClientErrorRoutes,
} from "../src/routes/client-errors";

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

const validReport = {
  kind: "chunk_load",
  route: "/workspaces/$workspaceId/sessions/$sessionId",
  revision: "0123456789abcdef0123456789abcdef01234567",
};

function post(app: Hono | ReturnType<typeof createApp>, body: string, headers = {}) {
  return app.request("/v1/client-errors", {
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

async function captureWarnings<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (message?: unknown) => lines.push(String(message));
  // Request-completion info lines are not under test here.
  console.log = () => undefined;
  try {
    return { result: await run(), lines };
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
}

describe("client error report contract", () => {
  test("accepts only the closed kind, a route pattern, and a revision token", () => {
    expect(parseClientErrorReport(JSON.stringify(validReport))).toEqual(validReport as never);
    for (const kind of CLIENT_ERROR_KINDS) {
      expect(parseClientErrorReport(JSON.stringify({ ...validReport, kind }))?.kind).toBe(kind);
    }
    for (const route of ["/", "unknown", "/workspaces/$workspaceId/variable-sets", "/billing"]) {
      expect(parseClientErrorReport(JSON.stringify({ ...validReport, route }))?.route).toBe(route);
    }
  });

  test("rejects content, concrete paths, extra fields, and oversized bodies", () => {
    const rejected = [
      null,
      "not json",
      JSON.stringify({ ...validReport, kind: "console_error" }),
      JSON.stringify({ ...validReport, message: "TypeError: secret" }),
      JSON.stringify({ ...validReport, stack: "at x (y.js:1:1)" }),
      JSON.stringify({ ...validReport, route: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7" }),
      JSON.stringify({ ...validReport, route: "https://app.example.test/workspaces" }),
      JSON.stringify({ ...validReport, route: "/workspaces?token=abc" }),
      JSON.stringify({ ...validReport, route: "/Workspaces/$workspaceId" }),
      JSON.stringify({ ...validReport, revision: "rev with spaces" }),
      JSON.stringify({ ...validReport, revision: "r".repeat(65) }),
      JSON.stringify({ kind: "route_error", route: "/" }),
      JSON.stringify({ ...validReport, route: `/${"a".repeat(CLIENT_ERROR_REPORT_MAX_BYTES)}` }),
    ];
    for (const body of rejected) expect(parseClientErrorReport(body)).toBeNull();
  });

  test("admission is a per-kind token bucket that refills over time", () => {
    let now = 0;
    const admission = createClientErrorAdmission({
      capacity: 2,
      refillPerSecond: 1,
      now: () => now,
    });
    expect(admission.admit("route_error")).toBe(true);
    expect(admission.admit("route_error")).toBe(true);
    expect(admission.admit("route_error")).toBe(false);
    // Other kinds keep their own budget, so a noisy kind cannot hide a deploy break.
    expect(admission.admit("chunk_load")).toBe(true);
    now += 1_000;
    expect(admission.admit("route_error")).toBe(true);
    expect(admission.admit("route_error")).toBe(false);
  });
});

describe("POST /v1/client-errors", () => {
  test("counts an accepted report and logs only its closed fields", async () => {
    const observability = createObservability(observabilitySettings, { component: "api" });
    const app = new Hono();
    registerClientErrorRoutes(app, { observability, settings: originSettings });

    const baseline = await observability.prometheusMetrics();
    for (const kind of CLIENT_ERROR_KINDS) {
      expect(metricValue(baseline, "opengeni_client_errors_total", `kind="${kind}"`)).toBe(0);
    }

    const { result: response, lines } = await captureWarnings(() =>
      post(app, JSON.stringify(validReport), { origin: "https://app.opengeni.test" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const metrics = await observability.prometheusMetrics();
    expect(metricValue(metrics, "opengeni_client_errors_total", 'kind="chunk_load"')).toBe(1);
    expect(metricValue(metrics, "opengeni_client_errors_total", 'kind="route_error"')).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "warn",
      message: "Web client error reported",
      surface: "web",
      reason: "chunk_load",
      clientRoute: validReport.route,
      clientRevision: validReport.revision,
    });
  });

  test("refuses invalid, oversized, and over-budget reports without counting them", async () => {
    const observability = createObservability(observabilitySettings, { component: "api" });
    const app = new Hono();
    registerClientErrorRoutes(app, {
      observability,
      settings: originSettings,
      admission: createClientErrorAdmission({ capacity: 1, refillPerSecond: 0, now: () => 0 }),
    });
    const rejected = "opengeni_client_error_reports_rejected_total";
    const baseline = await observability.prometheusMetrics();
    for (const reason of ["invalid", "too_large", "origin"]) {
      expect(metricValue(baseline, rejected, `kind="unknown",reason="${reason}"`)).toBe(0);
    }
    for (const kind of CLIENT_ERROR_KINDS) {
      expect(metricValue(baseline, rejected, `kind="${kind}",reason="rate_limited"`)).toBe(0);
    }

    const { lines } = await captureWarnings(async () => {
      expect((await post(app, JSON.stringify({ ...validReport, message: "x" }))).status).toBe(400);
      expect(
        (
          await post(app, "x".repeat(64), {
            "content-length": String(CLIENT_ERROR_REPORT_MAX_BYTES + 1),
          })
        ).status,
      ).toBe(413);
      expect((await post(app, JSON.stringify(validReport))).status).toBe(204);
      const limited = await post(app, JSON.stringify(validReport));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("cache-control")).toBe("no-store");
    });

    const metrics = await observability.prometheusMetrics();
    expect(metricValue(metrics, "opengeni_client_errors_total", 'kind="chunk_load"')).toBe(1);
    expect(metricValue(metrics, rejected, 'kind="unknown",reason="invalid"')).toBe(1);
    expect(metricValue(metrics, rejected, 'kind="unknown",reason="too_large"')).toBe(1);
    // A rate-limited refusal keeps its kind, so accepted plus refused is the
    // true per-kind arrival rate while the bucket is empty.
    expect(metricValue(metrics, rejected, 'kind="chunk_load",reason="rate_limited"')).toBe(1);
    expect(metricValue(metrics, rejected, 'kind="route_error",reason="rate_limited"')).toBe(0);
    expect(lines).toHaveLength(1);
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
    const chunk = new TextEncoder().encode("x".repeat(256));
    // No Content-Length: the declared-length check cannot see this body.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulledChunks += 1;
        if (pulledChunks > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const { result: response } = await captureWarnings(() =>
      app.request("/v1/client-errors", {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    // Refused after the third 256-byte chunk, not after reading all 16 KiB.
    expect(pulledChunks).toBeLessThan(8);
    const metrics = await observability.prometheusMetrics();
    expect(
      metricValue(
        metrics,
        "opengeni_client_error_reports_rejected_total",
        'kind="unknown",reason="too_large"',
      ),
    ).toBe(1);
    expect(metricValue(metrics, "opengeni_client_errors_total", 'kind="chunk_load"')).toBe(0);
  });

  test("accepts the deployment's own web origins and refuses foreign pages", async () => {
    const observability = createObservability(observabilitySettings, { component: "api" });
    const app = new Hono();
    registerClientErrorRoutes(app, {
      observability,
      settings: { ...originSettings, webBaseUrl: "http://127.0.0.1:3000" },
    });
    const { result: statuses } = await captureWarnings(async () => {
      const byOrigin: Record<string, number> = {};
      for (const origin of [
        "https://app.opengeni.test",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "https://attacker.example",
        "https://app.opengeni.test.attacker.example",
        "null",
        "not a url",
      ]) {
        byOrigin[origin] = (await post(app, JSON.stringify(validReport), { origin })).status;
      }
      // Non-browser clients send no Origin; the admission bound still applies.
      byOrigin["(none)"] = (await post(app, JSON.stringify(validReport))).status;
      return byOrigin;
    });
    expect(statuses).toEqual({
      "https://app.opengeni.test": 204,
      "http://127.0.0.1:3000": 204,
      "http://localhost:5173": 204,
      "https://attacker.example": 403,
      "https://app.opengeni.test.attacker.example": 403,
      null: 403,
      "not a url": 403,
      "(none)": 204,
    });
    const metrics = await observability.prometheusMetrics();
    expect(
      metricValue(
        metrics,
        "opengeni_client_error_reports_rejected_total",
        'kind="unknown",reason="origin"',
      ),
    ).toBe(4);
    expect(metricValue(metrics, "opengeni_client_errors_total", 'kind="chunk_load"')).toBe(4);
  });

  test("is reachable anonymously behind the deployment key and across API contract changes", async () => {
    expect(isApiContractProtectedMutation("POST", "/v1/client-errors")).toBe(false);
    expect(routeLabel("/v1/client-errors")).toBe("/v1/client-errors");

    const observability = createObservability(observabilitySettings, { component: "api" });
    const app = createApp({
      settings: { ...testSettings(), authRequired: true, accessKey: "deployment-key" },
      db: {} as never,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
      managedAuth: null,
      observability,
    });

    const { result: response } = await captureWarnings(() =>
      post(app, JSON.stringify({ ...validReport, kind: "route_error" })),
    );
    expect(response.status).toBe(204);
    expect(
      metricValue(
        await observability.prometheusMetrics(),
        "opengeni_client_errors_total",
        'kind="route_error"',
      ),
    ).toBe(1);
    // Only the beacon's POST is public; other methods keep the deployment key.
    const { result: read } = await captureWarnings(() => app.request("/v1/client-errors"));
    expect(read.status).toBe(401);
  });
});

const revision = "0123456789abcdef0123456789abcdef01234567";
const requestFailure = {
  signal: "request_failure",
  action: "send_message",
  reason: "offline",
  route: "/workspaces/$workspaceId/sessions/$sessionId",
  revision,
};
const streamEvent = {
  signal: "stream",
  stream: "session",
  event: "long_disconnect",
  route: "/workspaces/$workspaceId/sessions/$sessionId",
  revision,
};
const webVital = { signal: "web_vital", metric: "lcp", page: "sessions", value: 2.4, revision };

describe("client signal report contract", () => {
  test("accepts closed request-failure, stream and web-vital reports", () => {
    for (const report of [requestFailure, streamEvent, webVital]) {
      expect(parseClientBeaconReport(JSON.stringify(report))).toEqual(report as never);
      // A signal report is never mistaken for an error report.
      expect(parseClientErrorReport(JSON.stringify(report))).toBeNull();
    }
    expect(
      parseClientBeaconReport(JSON.stringify({ ...webVital, metric: "cls", value: 0.12 })),
    ).not.toBeNull();
  });

  test("rejects open values, content, ids and out-of-range vitals", () => {
    const rejected = [
      { ...requestFailure, action: "delete_everything" },
      { ...requestFailure, reason: "TypeError: Failed to fetch" },
      { ...requestFailure, route: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7" },
      { ...requestFailure, url: "https://api.example.test/v1" },
      { ...requestFailure, kind: "route_error" },
      { ...streamEvent, stream: "terminal" },
      { ...streamEvent, event: "error" },
      { ...webVital, page: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7" },
      { ...webVital, metric: "fcp" },
      { ...webVital, value: -1 },
      { ...webVital, value: 601 },
      { ...webVital, metric: "cls", value: 101 },
      { ...webVital, value: "2.4" },
      { ...webVital, route: "/" },
      { signal: "unknown", revision },
    ];
    for (const body of rejected) expect(parseClientBeaconReport(JSON.stringify(body))).toBeNull();
  });
});

describe("POST /v1/client-errors signal reports", () => {
  test("increments the closed signal series and the web-vital histogram", async () => {
    const observability = createObservability(observabilitySettings, { component: "api" });
    const app = new Hono();
    registerClientErrorRoutes(app, { observability, settings: originSettings });
    const baseline = await observability.prometheusMetrics();
    expect(
      metricValue(
        baseline,
        "opengeni_client_request_failures_total",
        'action="send_message",reason="offline"',
      ),
    ).toBe(0);
    expect(
      metricValue(
        baseline,
        "opengeni_client_stream_events_total",
        'event="long_disconnect",stream="session"',
      ),
    ).toBe(0);

    const { lines } = await captureWarnings(async () => {
      for (const report of [requestFailure, streamEvent, webVital]) {
        const response = await post(app, JSON.stringify(report), {
          origin: "https://app.opengeni.test",
        });
        expect(response.status).toBe(204);
      }
    });
    const metrics = await observability.prometheusMetrics();
    expect(
      metricValue(
        metrics,
        "opengeni_client_request_failures_total",
        'action="send_message",reason="offline"',
      ),
    ).toBe(1);
    expect(
      metricValue(
        metrics,
        "opengeni_client_stream_events_total",
        'event="long_disconnect",stream="session"',
      ),
    ).toBe(1);
    expect(
      metricValue(metrics, "opengeni_client_web_vital_count", 'metric="lcp",page="sessions"'),
    ).toBe(1);
    expect(
      metricValue(metrics, "opengeni_client_web_vital_sum", 'metric="lcp",page="sessions"'),
    ).toBe(2.4);
    expect(metricValue(metrics, "opengeni_client_web_vital_bucket", 'le="2.5"')).toBe(1);
    // Error counters are untouched by signals.
    expect(metricValue(metrics, "opengeni_client_errors_total", 'kind="route_error"')).toBe(0);
    // Request failure and degraded stream log their closed fields; vitals do not log.
    expect(lines.map((line) => JSON.parse(line).message)).toEqual([
      "Web client request failed before a response",
      "Web client live stream degraded",
    ]);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      op: "send_message",
      reason: "offline",
      clientRoute: requestFailure.route,
    });
  });

  test("signals use their own per-key admission buckets", async () => {
    const observability = createObservability(observabilitySettings, { component: "api" });
    const app = new Hono();
    registerClientErrorRoutes(app, {
      observability,
      settings: originSettings,
      signalAdmission: createClientSignalAdmission({ capacity: 1, refillPerSecond: 0 }),
    });
    const send = (report: object) =>
      captureWarnings(() => post(app, JSON.stringify(report))).then(({ result }) => result.status);
    expect(await send(requestFailure)).toBe(204);
    expect(await send(requestFailure)).toBe(429);
    // Another action and the error kinds keep their budgets.
    expect(await send({ ...requestFailure, action: "create_session" })).toBe(204);
    expect(await send(validReport)).toBe(204);
    const metrics = await observability.prometheusMetrics();
    expect(
      metricValue(
        metrics,
        "opengeni_client_error_reports_rejected_total",
        'kind="request_failure",reason="rate_limited"',
      ),
    ).toBe(1);
  });
});

describe("signal reports through the full API app", () => {
  test("an anonymous signal reaches Prometheus on an auth-required deployment", async () => {
    const observability = createObservability(observabilitySettings, { component: "api" });
    const app = createApp({
      settings: { ...testSettings(), authRequired: true, accessKey: "deployment-key" },
      db: {} as never,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
      managedAuth: null,
      observability,
    });
    const { result: response } = await captureWarnings(() =>
      post(app, JSON.stringify({ ...requestFailure, action: "create_session", reason: "network" })),
    );
    expect(response.status).toBe(204);
    const { result: metrics } = await captureWarnings(() =>
      app.request("/metrics", { headers: { authorization: "Bearer deployment-key" } }),
    );
    expect(metrics.status).toBe(200);
    const exposition = await metrics.text();
    expect(
      metricValue(
        exposition,
        "opengeni_client_request_failures_total",
        'action="create_session",reason="network"',
      ),
    ).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import { SandboxBackend } from "@opengeni/contracts";
import {
  createObservability,
  logStartupDependencyRetry,
  parseHeaders,
  sandboxOperationMetricObserver,
} from "../src";

const settings = {
  serviceName: "opengeni",
  environment: "test",
  observabilityStructuredLogs: true,
  observabilityMetricsEnabled: true,
  observabilityOtlpEndpoint: "http://collector:4318",
  observabilityOtlpHeaders: "authorization=Bearer test,x-scope=local",
};

describe("observability", () => {
  test("exposes the generic metrics and debug public methods", () => {
    const obs = createObservability(settings, { component: "worker", now: () => 1 });
    expect(typeof obs.setGauge).toBe("function");
    expect(typeof obs.incrementCounter).toBe("function");
    expect(typeof obs.observeHistogram).toBe("function");
    expect(typeof obs.debug).toBe("function");
  });

  test("renders prometheus metrics with resource and request labels", async () => {
    const obs = createObservability(settings, { component: "api", now: () => 1 });
    obs.recordHttpRequest({
      method: "GET",
      route: "/healthz",
      status: 200,
      durationSeconds: 0.012,
    });

    const metrics = await obs.prometheusMetrics();
    expect(metrics).toContain("opengeni_http_requests_total");
    expect(metrics).toContain('service="opengeni"');
    expect(metrics).toContain('environment="test"');
    expect(metrics).toContain('route="/healthz"');
    expect(metrics).toContain("opengeni_http_request_duration_seconds_bucket");
    expect(metrics).toContain("opengeni_build_info");
    expect(metrics).toContain("opengeni_process_cpu_user_seconds_total");
  });

  test("registers generic counters gauges and histograms with bounded labels", async () => {
    const obs = createObservability(settings, { component: "worker", now: () => 1 });
    obs.incrementCounter({
      name: "opengeni_model_calls_total",
      help: "Total model calls.",
      labels: { provider: "openai", outcome: "completed" },
    });
    obs.setGauge({
      name: "opengeni_turns_inflight",
      help: "In-flight turns.",
      value: 2,
    });
    obs.observeHistogram({
      name: "opengeni_model_call_duration_seconds",
      help: "Model call duration.",
      labels: { provider: "openai" },
      value: 0.25,
    });

    const metrics = await obs.prometheusMetrics();
    expect(metrics).toContain("opengeni_model_calls_total");
    expect(metrics).toContain('provider="openai"');
    expect(metrics).toContain('outcome="completed"');
    expect(metrics).toContain("opengeni_turns_inflight");
    expect(metrics).toContain("opengeni_model_call_duration_seconds_bucket");
  });

  test("rejects inconsistent metric label registrations", () => {
    const obs = createObservability(settings, { component: "worker", now: () => 1 });
    obs.incrementCounter({ name: "opengeni_turns_total", labels: { outcome: "completed" } });

    expect(() =>
      obs.incrementCounter({ name: "opengeni_turns_total", labels: { status: "idle" } }),
    ).toThrow("already registered");
  });

  test("records routed sandbox operations with bounded labels", async () => {
    const obs = createObservability(settings, { component: "worker", now: () => 1 });
    const observe = sandboxOperationMetricObserver(obs);
    observe({ backend: "modal", op: "execCommand", outcome: "ok", durationMs: 250 });
    observe({ backend: "modal", op: "listDir", outcome: "not_found", durationMs: 5 });
    observe({
      backend: "sb-user-controlled-provider-id",
      op: "readFile:/private/path",
      outcome: "failed",
      durationMs: 10,
    });

    const metrics = await obs.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_sandbox_operations_total\{[^}]*backend="modal"[^}]*op="execCommand"[^}]*outcome="ok"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_operations_total\{[^}]*backend="unknown"[^}]*op="unknown"[^}]*outcome="failed"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_operations_total\{[^}]*backend="modal"[^}]*op="listDir"[^}]*outcome="not_found"[^}]*\} 1\b/,
    );
    expect(metrics).not.toContain("sb-user-controlled-provider-id");
    expect(metrics).not.toContain("/private/path");
    expect(metrics).toContain("opengeni_sandbox_operation_duration_seconds_bucket");
  });

  test("recognizes every public sandbox backend without collapsing it", async () => {
    const obs = createObservability(settings, { component: "worker", now: () => 1 });
    const observe = sandboxOperationMetricObserver(obs);
    for (const backend of SandboxBackend.options) {
      observe({ backend, op: "exec", outcome: "ok", durationMs: 1 });
    }

    const metrics = await obs.prometheusMetrics();
    for (const backend of SandboxBackend.options) {
      expect(metrics).toContain(`backend="${backend}"`);
    }
  });

  test("counts observer failures without leaking them into sandbox execution", async () => {
    const obs = createObservability(settings, { component: "worker", now: () => 1 });
    obs.incrementCounter({
      name: "opengeni_sandbox_operations_total",
      labels: { incompatible_test_label: "seed" },
    });

    expect(() =>
      sandboxOperationMetricObserver(obs)({
        backend: "modal",
        op: "exec",
        outcome: "ok",
        durationMs: 1,
      }),
    ).not.toThrow();

    const metrics = await obs.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_observability_observer_errors_total\{[^}]*observer="sandbox_operation"[^}]*\} 1\b/,
    );
  });

  test("exports OTLP JSON spans", async () => {
    const exported: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    const obs = createObservability(settings, {
      component: "worker",
      now: () => 1,
      exporter: async (url, body, headers) => {
        exported.push({ url, body, headers });
      },
    });

    const span = obs.startSpan("worker.run_agent_segment", {
      "opengeni.session_id": "session-1",
      workspaceId: "workspace-1",
      turn_id: "turn-1",
      sourceKey: "source-1",
    });
    span.end({ attributes: { status: "idle", account_id: "account-1" } });
    await Bun.sleep(0);

    expect(exported).toHaveLength(1);
    expect(exported[0]!.url).toBe("http://collector:4318/v1/traces");
    expect(exported[0]!.headers.authorization).toBe("Bearer test");
    expect(exported[0]!.body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe(
      "worker.run_agent_segment",
    );
    const rendered = JSON.stringify(exported[0]!.body);
    for (const identifier of ["session-1", "workspace-1", "turn-1", "source-1", "account-1"]) {
      expect(rendered).not.toContain(identifier);
    }
  });

  test("projects span errors and drops unknown attributes before OTLP export", async () => {
    const exported: Array<{ body: any }> = [];
    const obs = createObservability(settings, {
      component: "api",
      exporter: async (_url, body) => {
        exported.push({ body });
      },
    });
    const error = Object.assign(
      new Error("PRIVATE proxy body Bearer super-secret-provider-token"),
      {
        name: "PRIVATE_ERROR_CLASS_SENTINEL",
        code: "PRIVATE_ERROR_CODE_SENTINEL",
        status: 502,
      },
    );

    const span = obs.startSpan("HTTP POST /v1/sessions", {});
    span.end({ error, attributes: { "custom.large": "x".repeat(2_000) } });
    await Bun.sleep(0);

    expect(exported).toHaveLength(1);
    const body = exported[0]!.body;
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(JSON.stringify(body)).not.toContain("super-secret-provider-token");
    expect(JSON.stringify(body)).not.toContain("PRIVATE_ERROR_CODE_SENTINEL");
    const spanBody = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(spanBody.status).toEqual({ code: 2, message: "HTTP 502" });
    expect(spanBody.attributes).toContainEqual({
      key: "error.type",
      value: { stringValue: "OperationError" },
    });
    expect(spanBody.attributes).toContainEqual({
      key: "error.status_code",
      value: { intValue: 502 },
    });
    expect(spanBody.attributes).not.toContainEqual(
      expect.objectContaining({
        key: "custom.large",
      }),
    );
  });

  test("OTLP status projection tolerates hostile proxies without masking the span", async () => {
    const sentinel = "OTLP_HOSTILE_STATUS_SENTINEL_61a0c7";
    const exported: Array<{ body: any }> = [];
    const obs = createObservability(settings, {
      component: "api",
      exporter: async (_url, body) => {
        exported.push({ body });
      },
    });
    const source = new Error(`exact OTLP failure ${sentinel}`);
    const hostile = new Proxy(source, {
      get(target, property, receiver) {
        if (property === "status" || property === "statusCode") {
          throw new Error(`hostile OTLP status getter ${sentinel}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const span = obs.startSpan("worker.hostile_status", {});
    expect(() => span.end({ error: hostile })).not.toThrow();
    await Bun.sleep(0);

    expect(exported).toHaveLength(1);
    const rendered = JSON.stringify(exported[0]!.body);
    expect(rendered).not.toContain(sentinel);
    expect(rendered).toContain("operation failed");
    expect(source.message).toContain(sentinel);
  });

  test("parses OTLP headers", () => {
    expect(parseHeaders("a=b,c=d=e")).toEqual({ a: "b", c: "d=e" });
  });

  test("logs startup dependency retry events", () => {
    const observed: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      observed.push(String(message));
    };
    try {
      const obs = createObservability(
        { ...settings, observabilityStructuredLogs: false },
        { component: "api" },
      );
      logStartupDependencyRetry(obs, {
        label: "Temporal",
        attempt: 1,
        attempts: 3,
        delayMs: 100,
        error: new Error("temporarily unavailable"),
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(observed).toEqual(["Startup dependency connection failed; retrying"]);
  });

  test("public structured logs omit identifiers and arbitrary source fields", () => {
    const sentinel = "PUBLIC_LOG_SENTINEL_93fbe7";
    const observed: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => observed.push(String(message));
    try {
      const obs = createObservability(settings, { component: "api", now: () => 1 });
      obs.warn("operation failed", {
        accountId: `account-${sentinel}`,
        workspace_id: `workspace-${sentinel}`,
        "opengeni.session_id": `session-${sentinel}`,
        turnId: `turn-${sentinel}`,
        sourceKey: `source-${sentinel}`,
        consumerId: `consumer-${sentinel}`,
        error: `message-${sentinel}`,
        command: `command-${sentinel}`,
        responseBody: `body-${sentinel}`,
        endpoint: `https://provider.example/${sentinel}`,
        toolResult: `result-${sentinel}`,
        errorClass: "OperationError",
        errorCode: "worker_operation_failed",
        status: 503,
        origin: "worker",
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toContain(sentinel);
    expect(JSON.parse(observed[0]!)).toMatchObject({
      message: "operation failed",
      errorClass: "OperationError",
      errorCode: "worker_operation_failed",
      status: 503,
      origin: "worker",
    });
  });

  test("public structured logs fail closed for unknown ordinary attributes", () => {
    const sentinel = "PUBLIC_ORDINARY_ATTRIBUTE_SENTINEL_8d0cc3";
    const observed: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => observed.push(String(message));
    try {
      const obs = createObservability(settings, { component: "api", now: () => 1 });
      obs.info("fixed operational message", {
        method: "GET",
        status: 200,
        arbitraryDiagnostic: sentinel,
      });
    } finally {
      console.log = originalLog;
    }

    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toContain(sentinel);
    expect(JSON.parse(observed[0]!)).toMatchObject({
      message: "fixed operational message",
      method: "GET",
      status: 200,
    });
    expect(JSON.parse(observed[0]!)).not.toHaveProperty("arbitraryDiagnostic");
  });

  test("public structured logs admit only validated opaque sandbox correlation keys", () => {
    const observed: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => observed.push(String(message));
    try {
      const obs = createObservability(settings, { component: "worker", now: () => 1 });
      obs.info("valid", {
        sandboxLeaseKey: "slk_0123456789abcdef0123456789abcdef",
        workspaceId: "workspace-must-not-leak",
      });
      obs.info("invalid", { sandboxLeaseKey: "raw-workspace-or-group-id" });
    } finally {
      console.log = originalLog;
    }

    expect(JSON.parse(observed[0]!)).toMatchObject({
      message: "valid",
      sandboxLeaseKey: "slk_0123456789abcdef0123456789abcdef",
    });
    expect(JSON.parse(observed[0]!)).not.toHaveProperty("workspaceId");
    expect(JSON.parse(observed[1]!)).not.toHaveProperty("sandboxLeaseKey");
  });

  test("public diagnostics reject syntactically valid secret-shaped classes and codes", () => {
    const sentinel = "SECRET_SENTINEL_123";
    const SecretSentinelError = class SECRET_SENTINEL_123 extends Error {};
    const exactError = Object.assign(new SecretSentinelError(`exact ${sentinel}`), {
      name: sentinel,
      code: sentinel,
      status: 503,
      cause: { exact: sentinel },
    });
    const observed: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => observed.push(String(message));
    try {
      const obs = createObservability(settings, { component: "worker", now: () => 1 });
      obs.warn("operation failed", {
        errorClass: exactError.constructor.name,
        errorCode: exactError.code,
        status: exactError.status,
        origin: sentinel,
        arbitraryDiagnostic: sentinel,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(exactError.message).toBe(`exact ${sentinel}`);
    expect(exactError.constructor.name).toBe(sentinel);
    expect(exactError.code).toBe(sentinel);
    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toContain(sentinel);
    expect(JSON.parse(observed[0]!)).toMatchObject({
      message: "operation failed",
      errorClass: "OperationError",
      status: 503,
    });
    expect(JSON.parse(observed[0]!)).not.toHaveProperty("errorCode");
    expect(JSON.parse(observed[0]!)).not.toHaveProperty("origin");
    expect(JSON.parse(observed[0]!)).not.toHaveProperty("arbitraryDiagnostic");
  });

  test("OTLP exporter failures expose only a fixed structural diagnostic", async () => {
    const sentinel = "OTLP_EXPORT_SENTINEL_d3d7f1";
    const observed: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => observed.push(String(message));
    try {
      const obs = createObservability(settings, {
        component: "worker",
        exporter: async () => {
          throw Object.assign(new Error(`collector body ${sentinel}`), {
            name: sentinel,
            code: sentinel,
            endpoint: `https://collector.example/${sentinel}`,
          });
        },
      });
      obs.startSpan("worker.operation").end();
      await Bun.sleep(0);
    } finally {
      console.warn = originalWarn;
    }

    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toContain(sentinel);
    expect(JSON.parse(observed[0]!)).toMatchObject({
      message: "OTLP span export failed",
      errorClass: "TelemetryExportError",
      errorCode: "otlp_export_failed",
      origin: "observability",
    });
  });
});

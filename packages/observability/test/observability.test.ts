import { describe, expect, test } from "bun:test";
import { SandboxBackend } from "@opengeni/contracts";
import {
  createObservability,
  interactionAuthMetricObserver,
  interactionInterventionMetricObserver,
  interactionOperationMetricObserver,
  logStartupDependencyRetry,
  parseHeaders,
  recordTenancyCompatibilityLaneUse,
  sandboxOperationMetricObserver,
  TENANCY_COMPATIBILITY_LANES,
} from "../src";

const settings = {
  serviceName: "opengeni",
  environment: "test",
  deploymentRevision: "revision-test",
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
    expect(metrics).toContain('deployment_revision="revision-test"');
    expect(metrics).toContain('route="/healthz"');
    expect(metrics).toContain("opengeni_http_request_duration_seconds_bucket");
    expect(metrics).toContain("opengeni_build_info");
    expect(metrics).toContain("opengeni_process_cpu_user_seconds_total");
  });

  test("reports bounded configured and effective sandbox rollout state", async () => {
    const obs = createObservability(
      {
        ...settings,
        sandboxOwnershipEnabled: true,
        sandboxLazyProvisionEnabled: true,
        rigVerificationLeaseOwnershipEnabled: false,
      },
      { component: "worker-turn", now: () => 1 },
    );

    const metrics = await obs.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_sandbox_rollout_config\{[^}]*feature="ownership"[^}]*state="effective"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_rollout_config\{[^}]*feature="lazy_provision"[^}]*state="effective"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_rollout_config\{[^}]*feature="rig_verification_lease_ownership"[^}]*state="effective"[^}]*\} 0\b/,
    );
    expect(metrics).toContain('deployment_revision="revision-test"');
    expect(metrics).toContain('component="worker-turn"');
  });

  test("reports lazy provisioning as configured but ineffective without ownership", async () => {
    const obs = createObservability(
      {
        ...settings,
        sandboxOwnershipEnabled: false,
        sandboxLazyProvisionEnabled: true,
        rigVerificationLeaseOwnershipEnabled: false,
      },
      { component: "api", now: () => 1 },
    );

    const metrics = await obs.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_sandbox_rollout_config\{[^}]*feature="lazy_provision"[^}]*state="configured"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_rollout_config\{[^}]*feature="lazy_provision"[^}]*state="effective"[^}]*\} 0\b/,
    );
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

  test("records interaction operations with closed low-cardinality labels", async () => {
    const obs = createObservability(settings, { component: "api", now: () => 1 });
    const observe = interactionOperationMetricObserver(obs);
    observe({
      resource: "browser",
      operation: "act",
      mode: "semantic",
      outcome: "completed",
      durationMs: 250,
    });
    observe({
      resource: "browser",
      operation: "act",
      mode: "permission",
      outcome: "completed",
      durationMs: 5,
    });
    observe({
      resource: "browser-session-private-id",
      operation: "click:https://private.example/secret",
      mode: "locator:#private-input",
      outcome: "PRIVATE_PAGE_TEXT",
      durationMs: Number.POSITIVE_INFINITY,
    });

    const metrics = await obs.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_interaction_operations_total\{[^}]*mode="semantic"[^}]*operation="act"[^}]*outcome="completed"[^}]*resource="browser"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_interaction_operations_total\{[^}]*mode="permission"[^}]*operation="act"[^}]*outcome="completed"[^}]*resource="browser"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_interaction_operations_total\{[^}]*mode="unknown"[^}]*operation="unknown"[^}]*outcome="unknown"[^}]*resource="unknown"[^}]*\} 1\b/,
    );
    expect(metrics).toContain("opengeni_interaction_operation_duration_seconds_bucket");
    expect(metrics).not.toContain("browser-session-private-id");
    expect(metrics).not.toContain("private.example");
    expect(metrics).not.toContain("private-input");
    expect(metrics).not.toContain("PRIVATE_PAGE_TEXT");
  });

  test("records auth and human-intervention lifecycle without replay inflation", async () => {
    const obs = createObservability(settings, { component: "api", now: () => 1 });
    const observeAuth = interactionAuthMetricObserver(obs);
    const observeIntervention = interactionInterventionMetricObserver(obs);

    observeAuth({ state: "awaiting_external_action", durationMs: 25 });
    observeAuth({ state: "verified", durationMs: 10, replayed: true });
    observeAuth({ state: "private-auth-state", durationMs: 1 });
    observeIntervention({ kind: "mfa", outcome: "opened" });
    observeIntervention({ kind: "mfa", outcome: "completed", waitMs: 1_250 });
    observeIntervention({
      kind: "private-kind",
      outcome: "private-outcome",
      waitMs: 50,
      replayed: true,
    });

    const metrics = await obs.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_interaction_auth_transitions_total\{[^}]*state="awaiting_external_action"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_interaction_auth_transitions_total\{[^}]*state="unknown"[^}]*\} 1\b/,
    );
    expect(metrics).not.toContain('state="verified"');
    expect(metrics).toMatch(
      /opengeni_interaction_interventions_total\{[^}]*kind="mfa"[^}]*outcome="opened"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_interaction_interventions_total\{[^}]*kind="mfa"[^}]*outcome="completed"[^}]*\} 1\b/,
    );
    expect(metrics).toContain("opengeni_interaction_intervention_wait_seconds_bucket");
    expect(metrics).not.toContain("private-kind");
    expect(metrics).not.toContain("private-outcome");
  });

  test("isolates interaction observer registration failures", async () => {
    const obs = createObservability(settings, { component: "api", now: () => 1 });
    obs.incrementCounter({
      name: "opengeni_interaction_operations_total",
      labels: { incompatible_test_label: "seed" },
    });

    expect(() =>
      interactionOperationMetricObserver(obs)({
        resource: "browser",
        operation: "act",
        mode: "semantic",
        outcome: "completed",
        durationMs: 1,
      }),
    ).not.toThrow();

    const metrics = await obs.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_observability_observer_errors_total\{[^}]*observer="interaction_operation"[^}]*\} 1\b/,
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

    expect(observed).toEqual([
      "Startup dependency Temporal connection failed; retrying (1/3 in 100ms)",
    ]);
  });

  test("keeps safe retry context in structured startup logs", () => {
    const observed: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      observed.push(String(message));
    };
    try {
      const obs = createObservability(
        { ...settings, observabilityStructuredLogs: true },
        { component: "worker" },
      );
      logStartupDependencyRetry(obs, {
        label: "PostgreSQL runtime posture",
        attempt: 2,
        attempts: 5,
        delayMs: 250,
        error: new Error("must remain private"),
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(JSON.parse(observed[0]!)).toMatchObject({
      dependency: "PostgreSQL runtime posture",
      attempt: 2,
      attempts: 5,
      delayMs: 250,
      errorClass: "StartupDependencyError",
      errorCode: "startup_dependency_retry",
      origin: "observability",
    });
    expect(observed[0]).not.toContain("must remain private");
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

  test("public structured logs retain only grammar-validated request correlation ids", () => {
    const observed: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => observed.push(String(message));
    try {
      const obs = createObservability(settings, { component: "api", now: () => 1 });
      obs.warn("valid", {
        correlationId: "request.2026-08-19:abc_123",
        errorClass: "HttpOperationError",
        errorCode: "internal_error",
        status: 502,
        workspaceId: "workspace-must-not-leak",
      });
      obs.warn("invalid", {
        correlationId: "request id with spaces and bearer material",
        errorClass: "HttpOperationError",
        errorCode: "internal_error",
        status: 502,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(JSON.parse(observed[0]!)).toMatchObject({
      message: "valid",
      correlationId: "request.2026-08-19:abc_123",
      errorClass: "HttpOperationError",
      errorCode: "internal_error",
      status: 502,
    });
    expect(JSON.parse(observed[0]!)).not.toHaveProperty("workspaceId");
    expect(JSON.parse(observed[1]!)).not.toHaveProperty("correlationId");
  });

  test("physical cancellation logs retain duration and safe sandbox correlation", () => {
    const observed: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => observed.push(String(message));
    try {
      const obs = createObservability(settings, { component: "worker", now: () => 1 });
      obs.info("agent turn physical cancellation completed", {
        durationMs: 1_487,
        sandboxLeaseKey: "slk_0123456789abcdef0123456789abcdef",
        "opengeni.session_id": "session-must-not-leak",
        "opengeni.turn_id": "turn-must-not-leak",
        "opengeni.attempt_id": "attempt-must-not-leak",
      });
    } finally {
      console.log = originalLog;
    }

    expect(observed).toHaveLength(1);
    expect(JSON.parse(observed[0]!)).toMatchObject({
      message: "agent turn physical cancellation completed",
      durationMs: 1_487,
      sandboxLeaseKey: "slk_0123456789abcdef0123456789abcdef",
    });
    expect(observed[0]).not.toContain("must-not-leak");
  });

  test("public diagnostics retain safe operation fields and validated lease correlation", () => {
    const sentinel = "DIAGNOSTIC_PRIVATE_SENTINEL_6a44f8";
    const observed: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => observed.push(String(message));
    try {
      const obs = createObservability(settings, { component: "api", now: () => 1 });
      obs.warn("Channel-A operation failed", {
        errorClass: "SandboxChannelAOperationError",
        errorCode: "sandbox_channel_a_provider_unavailable",
        origin: "api",
        status: 503,
        backend: "modal",
        op: "git.read-batch",
        reason: "provider_unavailable",
        outcome: "failed",
        durationMs: 812,
        sandboxLeaseKey: "slk_0123456789abcdef0123456789abcdef",
        workspaceId: sentinel,
        error: sentinel,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toContain(sentinel);
    expect(JSON.parse(observed[0]!)).toMatchObject({
      message: "Channel-A operation failed",
      errorClass: "SandboxChannelAOperationError",
      errorCode: "sandbox_channel_a_provider_unavailable",
      origin: "api",
      status: 503,
      backend: "modal",
      op: "git.read-batch",
      reason: "provider_unavailable",
      outcome: "failed",
      durationMs: 812,
      sandboxLeaseKey: "slk_0123456789abcdef0123456789abcdef",
    });
    expect(JSON.parse(observed[0]!)).not.toHaveProperty("workspaceId");
    expect(JSON.parse(observed[0]!)).not.toHaveProperty("error");
  });

  test("Channel-A diagnostics reject unreviewed operational values", () => {
    const sentinel = "DIAGNOSTIC_VALUE_SENTINEL_58c2";
    const observed: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => observed.push(String(message));
    try {
      const obs = createObservability(settings, { component: "api", now: () => 1 });
      obs.warn("Channel-A operation failed", {
        errorClass: "SandboxChannelAOperationError",
        errorCode: "sandbox_channel_a_operation_failed",
        backend: sentinel,
        op: sentinel,
        outcome: sentinel,
        reason: sentinel,
        durationMs: -1,
        sandboxLeaseKey: `slk_${sentinel}`,
      });
    } finally {
      console.warn = originalWarn;
    }

    const parsed = JSON.parse(observed[0]!);
    expect(observed[0]).not.toContain(sentinel);
    expect(parsed).not.toHaveProperty("backend");
    expect(parsed).not.toHaveProperty("op");
    expect(parsed).not.toHaveProperty("outcome");
    expect(parsed).not.toHaveProperty("reason");
    expect(parsed).not.toHaveProperty("durationMs");
    expect(parsed).not.toHaveProperty("sandboxLeaseKey");
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

  test("publishes every tenancy compatibility lane at zero before any use", async () => {
    const obs = createObservability(settings, { component: "worker", now: () => 1 });
    const metrics = await obs.prometheusMetrics();
    for (const lane of TENANCY_COMPATIBILITY_LANES) {
      expect(metrics).toContain(`lane="${lane}"`);
    }
    // An operator watching the migration drain must be able to tell "this lane
    // is already dead" from "this lane was never wired up".
    expect(
      metrics
        .split("\n")
        .filter((line) => line.startsWith("opengeni_tenancy_compatibility_lane_uses_total{")),
    ).toHaveLength(TENANCY_COMPATIBILITY_LANES.length);
    expect(metrics).toContain(
      "# HELP opengeni_tenancy_compatibility_lane_uses_total " +
        "Live uses of an organization-tenancy compatibility lane, by lane.",
    );
  });

  test("counts one compatibility-lane use with the lane as its only label", async () => {
    const obs = createObservability(settings, { component: "worker", now: () => 1 });
    recordTenancyCompatibilityLaneUse(obs, "connection_pre_snapshot_ref");
    recordTenancyCompatibilityLaneUse(obs, "connection_pre_snapshot_ref");
    recordTenancyCompatibilityLaneUse(obs, "connection_legacy_user");

    const metrics = await obs.prometheusMetrics();
    const sample = (lane: string): string =>
      metrics
        .split("\n")
        .find(
          (line) =>
            line.startsWith("opengeni_tenancy_compatibility_lane_uses_total{") &&
            line.includes(`lane="${lane}"`),
        ) ?? "";
    expect(sample("connection_pre_snapshot_ref")).toMatch(/\s2$/);
    expect(sample("connection_legacy_user")).toMatch(/\s1$/);
    expect(sample("workspace_writer_unattributed")).toMatch(/\s0$/);
    // Content-free: only the reviewed lane name plus the registry's fixed
    // deployment labels. No tenant, subject, connection, or resource identity.
    const labels = sample("connection_legacy_user").slice(
      sample("connection_legacy_user").indexOf("{") + 1,
      sample("connection_legacy_user").indexOf("}"),
    );
    expect(
      labels
        .split(",")
        .map((pair) => pair.split("=")[0])
        .sort(),
    ).toEqual(["component", "deployment_revision", "environment", "lane", "service"]);
  });

  test("ignores a lane name outside the reviewed set and a missing observability", async () => {
    const obs = createObservability(settings, { component: "api", now: () => 1 });
    recordTenancyCompatibilityLaneUse(
      obs,
      "connection_id_47f0d0a1" as unknown as (typeof TENANCY_COMPATIBILITY_LANES)[number],
    );
    expect(() => recordTenancyCompatibilityLaneUse(null, "connection_legacy_user")).not.toThrow();
    expect(() =>
      recordTenancyCompatibilityLaneUse(undefined, "connection_legacy_user"),
    ).not.toThrow();

    const metrics = await obs.prometheusMetrics();
    expect(metrics).not.toContain("connection_id_47f0d0a1");
  });

  test("a compatibility-lane registry failure never escapes to the caller", () => {
    const obs = createObservability(settings, { component: "api", now: () => 1 });
    const failing = Object.create(obs) as typeof obs;
    failing.incrementCounter = () => {
      throw new Error("registry unhealthy");
    };
    expect(() =>
      recordTenancyCompatibilityLaneUse(failing, "workspace_writer_unattributed"),
    ).not.toThrow();
  });
});

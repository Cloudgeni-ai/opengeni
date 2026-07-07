import { describe, expect, test } from "bun:test";
import { createObservability, logStartupDependencyRetry, parseHeaders } from "../src";

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
    obs.recordHttpRequest({ method: "GET", route: "/healthz", status: 200, durationSeconds: 0.012 });

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

    expect(() => obs.incrementCounter({ name: "opengeni_turns_total", labels: { status: "idle" } }))
      .toThrow("already registered");
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

    const span = obs.startSpan("worker.run_agent_segment", { "opengeni.session_id": "session-1" });
    span.end({ attributes: { status: "idle" } });
    await Bun.sleep(0);

    expect(exported).toHaveLength(1);
    expect(exported[0]!.url).toBe("http://collector:4318/v1/traces");
    expect(exported[0]!.headers.authorization).toBe("Bearer test");
    expect(exported[0]!.body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("worker.run_agent_segment");
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
      const obs = createObservability({ ...settings, observabilityStructuredLogs: false }, { component: "api" });
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

    expect(observed).toEqual(["Startup dependency connection failed; retrying: temporarily unavailable"]);
  });
});

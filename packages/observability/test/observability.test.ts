import { describe, expect, test } from "bun:test";
import { createObservability, parseHeaders } from "../src";

const settings = {
  serviceName: "opengeni",
  environment: "test",
  observabilityStructuredLogs: true,
  observabilityMetricsEnabled: true,
  observabilityOtlpEndpoint: "http://collector:4318",
  observabilityOtlpHeaders: "authorization=Bearer test,x-scope=local",
};

describe("observability", () => {
  test("renders prometheus metrics with resource and request labels", () => {
    const obs = createObservability(settings, { component: "api", now: () => 1 });
    obs.recordHttpRequest({ method: "GET", route: "/healthz", status: 200, durationSeconds: 0.012 });

    const metrics = obs.prometheusMetrics();
    expect(metrics).toContain("opengeni_http_requests_total");
    expect(metrics).toContain('service="opengeni"');
    expect(metrics).toContain('environment="test"');
    expect(metrics).toContain('route="/healthz"');
    expect(metrics).toContain("opengeni_http_request_duration_seconds_bucket");
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
});

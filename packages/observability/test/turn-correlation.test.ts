import { expect, test } from "bun:test";
import { createObservability, turnExecutionTelemetryKey, withTraceContext } from "../src";

test("execution lookup keys are deterministic, scoped, delimited and domain-separated", () => {
  const key = turnExecutionTelemetryKey("workspace", "session", "attempt");
  expect(key).toMatch(/^turn_[0-9a-f]{32}$/);
  expect(turnExecutionTelemetryKey("workspace", "session", "attempt")).toBe(key);
  expect(turnExecutionTelemetryKey("other", "session", "attempt")).not.toBe(key);
  expect(turnExecutionTelemetryKey("workspace", "other", "attempt")).not.toBe(key);
  expect(turnExecutionTelemetryKey("workspace", "session", "other")).not.toBe(key);
  expect(turnExecutionTelemetryKey("ab", "c", "d")).not.toBe(
    turnExecutionTelemetryKey("a", "bc", "d"),
  );
});

test("opaque execution key links logs and exported trace without raw ids or metric labels", async () => {
  const sentinel = "private-execution-identity-sentinel";
  const key = turnExecutionTelemetryKey(sentinel, "session-secret", "attempt-secret");
  const exports: unknown[] = [];
  const logs: string[] = [];
  const obs = createObservability(
    {
      serviceName: "opengeni",
      environment: "test",
      deploymentRevision: "test",
      observabilityStructuredLogs: true,
      observabilityMetricsEnabled: true,
      observabilityOtlpEndpoint: "http://collector:4318",
      observabilityOtlpHeaders: "",
    },
    {
      component: "worker-turn",
      exporter: async (_url, body) => {
        exports.push(body);
      },
    },
  );
  const span = obs.startSpan(
    "worker.run_agent_segment",
    { correlationId: key, workspaceId: sentinel },
    { parent: null },
  );
  const original = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
  try {
    await withTraceContext(span, async () => {
      obs.info("worker execution started", { correlationId: key, sessionId: "session-secret" });
    });
  } finally {
    console.log = original;
    span.end();
  }
  await obs.flush();
  expect(JSON.parse(logs[0]!)).toMatchObject({
    correlationId: key,
    traceId: span.traceId,
    spanId: span.spanId,
  });
  const wire = JSON.stringify(exports);
  expect(wire).toContain(key);
  expect(wire).toContain(span.traceId);
  for (const value of [sentinel, "session-secret", "attempt-secret"]) {
    expect(wire).not.toContain(value);
    expect(logs.join("\n")).not.toContain(value);
  }
  expect(await obs.prometheusMetrics()).not.toContain(key);
});

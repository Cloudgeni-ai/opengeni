import { expect, test } from "bun:test";
import { createObservability, recordToolApproval, withMcpTelemetry } from "@opengeni/observability";

test("approval metrics distinguish policy, waiting and uncertain outcomes without content", async () => {
  const observer = createObservability(
    {
      serviceName: "test",
      environment: "test",
      observabilityMetricsEnabled: true,
      observabilityStructuredLogs: true,
      observabilityOtlpHeaders: "",
      observabilityOtlpEndpoint: "",
    },
    { component: "worker" },
  );
  withMcpTelemetry(observer, "PRIVATE_SCOPE_CANARY", () => {
    recordToolApproval("allow", "explicit");
    recordToolApproval("ask", "default");
    recordToolApproval("block", "ambiguous");
    recordToolApproval("waiting");
    recordToolApproval("resumed", "continuation", 2500);
    recordToolApproval("unknown");
    recordToolApproval("PRIVATE_TOOL_CANARY" as "ask", "PRIVATE_ACCOUNT_CANARY" as "default");
  });
  const metrics = await observer.prometheusMetrics();
  for (const value of ["allow", "ask", "block", "waiting", "resumed", "unknown"])
    expect(metrics).toContain(`outcome="${value}"`);
  expect(metrics).toMatch(
    /opengeni_tool_approval_wait_seconds_sum\{[^\n]*outcome="resumed"[^\n]*\} 2\.5/,
  );
  expect(metrics).not.toContain("CANARY");
  observer.incrementCounter = () => {
    throw new Error("unavailable");
  };
  expect(() => withMcpTelemetry(observer, "scope", () => recordToolApproval("ask"))).not.toThrow();
});

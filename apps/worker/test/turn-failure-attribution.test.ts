import { settledTurnFailureOrigin } from "../src/activities/agent-turn/failure-attribution";
import { expect, test } from "bun:test";
import { failureOrigin, createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
import { runtimeMetricsHooksForObservability } from "../src/observability-metrics";

test("production quota payload excludes customer quota but keeps deployment quota and uncertain transport", () => {
  const quota = agentRunFailurePayload({
    status: 429,
    message: "Rate limit exceeded: free-models-per-day",
  });
  expect(quota.code).toBe("provider_quota_exhausted");
  expect(failureOrigin({ customerManaged: true, outcome: "failed", code: quota.code })).toBe(
    "customer_provider",
  );
  expect(failureOrigin({ customerManaged: false, outcome: "failed", code: quota.code })).toBe(
    "platform",
  );
  for (const error of [
    new Error("Connection error."),
    new Error("Request timed out."),
    { status: 400, message: "Invalid tool name" },
  ]) {
    const payload = agentRunFailurePayload(error);
    expect(failureOrigin({ customerManaged: true, outcome: "failed", code: payload.code })).toBe(
      "platform",
    );
  }
});

test("model response instrumentation separates customer HTTP quota from platform defects", async () => {
  const obs = createObservability(testSettings(), { component: "worker" });
  const hooks = runtimeMetricsHooksForObservability(obs);
  for (const [provider, httpStatus] of [
    ["organization-openrouter", 429],
    ["azure-sol", 429],
    ["organization-openrouter", 400],
  ] as const) {
    hooks.onModelCall!({ provider, outcome: "failed", httpStatus, durationSeconds: 1 });
  }
  const lines = (await obs.prometheusMetrics())
    .split("\n")
    .filter((line) => line.startsWith("opengeni_model_calls_total{"));
  expect(lines).toHaveLength(3);
  expect(lines.filter((line) => line.includes('failure_origin="customer_provider"'))).toHaveLength(
    1,
  );
  expect(lines.filter((line) => line.includes('failure_origin="platform"'))).toHaveLength(2);
});

test("settlement uses frozen payer rather than external metering and actual terminal evidence", () => {
  const events = [{ type: "turn.failed", payload: { code: "provider_quota_exhausted" } }];
  for (const metering of ["external", "opengeni_credits"] as const) {
    expect(
      settledTurnFailureOrigin({ upstreamPayer: "deployment", metering }, "failed", events),
    ).toBe("platform");
  }
  for (const upstreamPayer of ["workspace", "organization", "connected_subscription"] as const) {
    const billing = { upstreamPayer, metering: "external" as const };
    expect(settledTurnFailureOrigin(billing, "failed", events)).toBe("customer_provider");
    expect(settledTurnFailureOrigin(billing, "failed", [])).toBe("platform");
    expect(settledTurnFailureOrigin(billing, "completed", events)).toBe("none");
    expect(
      settledTurnFailureOrigin(billing, "failed", [
        { type: "turn.failed", payload: { code: "provider_unavailable" } },
      ]),
    ).toBe("platform");
  }
});

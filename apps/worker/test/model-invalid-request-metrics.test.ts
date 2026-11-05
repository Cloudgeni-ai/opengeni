import { expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import { runtimeMetricsHooksForObservability } from "../src/observability-metrics";

test("provider invalid requests are counted by provider, path and code only", async () => {
  const observability = createObservability(testSettings(), { component: "worker" });
  const hooks = runtimeMetricsHooksForObservability(observability);
  for (let i = 0; i < 2; i++) {
    hooks.onModelInvalidRequest?.({
      provider: "openai",
      path: "input[].tools[].name",
      code: "invalid_string",
    });
  }
  const metrics = await observability.prometheusMetrics();
  const lines = metrics
    .split("\n")
    .filter((line) => line.startsWith("opengeni_model_invalid_requests_total{"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('provider="openai"');
  expect(lines[0]).toContain('path="input[].tools[].name"');
  expect(lines[0]).toContain('code="invalid_string"');
  expect(lines[0]).toEndWith("} 2");
});

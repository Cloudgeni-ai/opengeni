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

test("tool-name repairs and strict resends are counted by provider, API, field and outcome only", async () => {
  const observability = createObservability(testSettings(), { component: "worker" });
  const hooks = runtimeMetricsHooksForObservability(observability);
  hooks.onModelToolNameRepair?.({ provider: "openai", api: "responses", field: "history" });
  hooks.onModelToolNameRetry?.({ provider: "openai", api: "responses", outcome: "completed" });
  const metrics = (await observability.prometheusMetrics()).split("\n");
  const repairs = metrics.filter((line) =>
    line.startsWith("opengeni_model_tool_name_repairs_total{"),
  );
  expect(repairs).toHaveLength(1);
  expect(repairs[0]).toContain('provider="openai"');
  expect(repairs[0]).toContain('api="responses"');
  expect(repairs[0]).toContain('field="history"');
  expect(repairs[0]).toEndWith("} 1");
  const retries = metrics.filter((line) =>
    line.startsWith("opengeni_model_tool_name_retries_total{"),
  );
  expect(retries).toHaveLength(1);
  expect(retries[0]).toContain('outcome="completed"');
  expect(retries[0]).toEndWith("} 1");
});

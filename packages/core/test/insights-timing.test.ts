import { expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { startDatabaseTiming } from "../../db/src/database-timing";
import {
  measureInsightsPhase,
  workspaceInsightsPhaseMetricObserver,
  type InsightsPhaseObservation,
} from "../src/domain/insights-timing";

test("concurrent helper scopes stay isolated and do not leak to unobserved work", async () => {
  const events: InsightsPhaseObservation[] = [];
  const observe = (event: InsightsPhaseObservation) => {
    events.push(event);
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = measureInsightsPhase(observe, "model_bundle", async () => {
    await gate;
    startDatabaseTiming("transaction_admission")("completed");
    return "model";
  });
  const fast = measureInsightsPhase(observe, "usage_bundle", async () => {
    startDatabaseTiming("transaction_admission")("failed");
    return "usage";
  });
  expect(await fast).toBe("usage");
  release();
  expect(await slow).toBe("model");
  startDatabaseTiming("transaction_admission")("completed");
  expect(events.map(({ phase, stage, outcome }) => [phase, stage, outcome])).toEqual([
    ["usage_bundle", "transaction_admission", "failed"],
    ["usage_bundle", "helper", "completed"],
    ["model_bundle", "transaction_admission", "completed"],
    ["model_bundle", "helper", "completed"],
  ]);
});

test("metrics project only closed labels and finite seconds", () => {
  const metrics: unknown[] = [];
  const observer = workspaceInsightsPhaseMetricObserver({
    observeHistogram: (metric) => {
      metrics.push(metric);
    },
  })!;
  observer({ phase: "model_bundle", stage: "helper", outcome: "completed", durationMs: 1250 });
  observer({
    phase: "secret workspace SQL",
    stage: "secret query",
    outcome: "secret actor",
    durationMs: NaN,
  } as never);
  expect(metrics[0]).toMatchObject({
    value: 1.25,
    labels: { phase: "model_bundle", stage: "helper", outcome: "completed" },
  });
  expect(metrics[1]).toMatchObject({
    value: 0,
    labels: { phase: "unknown", stage: "unknown", outcome: "failed" },
  });
  expect(JSON.stringify(metrics)).not.toContain("secret");
  expect(workspaceInsightsPhaseMetricObserver(null)).toBeUndefined();
});

test("uses the real histogram interface and exports bounded Prometheus series", async () => {
  const observability = createObservability(
    {
      serviceName: "opengeni",
      environment: "test",
      deploymentRevision: "test",
      observabilityStructuredLogs: false,
      observabilityMetricsEnabled: true,
      observabilityOtlpEndpoint: undefined,
      observabilityOtlpHeaders: undefined,
    },
    { component: "api" },
  );
  const observe = workspaceInsightsPhaseMetricObserver(observability)!;
  observe({
    phase: "usage_bundle",
    stage: "transaction_admission",
    outcome: "completed",
    durationMs: 1250,
  });
  const metrics = await observability.prometheusMetrics();
  expect(metrics).toContain("opengeni_workspace_insights_phase_duration_seconds_bucket");
  expect(metrics).toContain('phase="usage_bundle"');
  expect(metrics).toContain('stage="transaction_admission"');
  expect(metrics).toMatch(
    /opengeni_workspace_insights_phase_duration_seconds_sum\{[^}]*\} 1\.25\b/,
  );
});

test("observer failures preserve exact success and original sync/async failures", async () => {
  const original = new Error("original");
  const result = {};
  for (const observer of [
    workspaceInsightsPhaseMetricObserver({
      observeHistogram: async () => {
        throw new Error("async exporter");
      },
    }),
    () => {
      throw new Error("observer");
    },
    async () => {
      throw new Error("async observer");
    },
    workspaceInsightsPhaseMetricObserver({
      observeHistogram: () => {
        throw new Error("exporter");
      },
    }),
  ]) {
    expect(await measureInsightsPhase(observer, "auth", async () => result)).toBe(result);
    await expect(
      measureInsightsPhase(observer, "auth", () => {
        throw original;
      }),
    ).rejects.toBe(original);
    await expect(
      measureInsightsPhase(observer, "auth", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  }
});

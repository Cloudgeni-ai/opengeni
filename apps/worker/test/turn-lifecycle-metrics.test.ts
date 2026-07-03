import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { TurnLifecycleMetrics } from "../src/observability-metrics";

describe("turn lifecycle metrics", () => {
  test("start and finish update inflight gauges and terminal totals", async () => {
    let now = 1_000;
    const observability = createObservability(testSettings(), {
      component: "worker",
      now: () => now,
    });
    const tracker = new TurnLifecycleMetrics(observability, {
      now: () => now,
      refreshIntervalMs: 60_000,
    });

    tracker.start("turn-1");
    now = 4_000;
    tracker.refreshGauges();

    let metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turns_inflight\{[^}]*\} 1/);
    expect(metrics).toMatch(/opengeni_turn_oldest_inflight_age_seconds\{[^}]*\} 3/);

    tracker.finish("turn-1", "completed");

    metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turns_inflight\{[^}]*\} 0/);
    expect(metrics).toContain("opengeni_turns_total");
    expect(metrics).toContain('outcome="completed"');
    expect(metrics).toContain("opengeni_turn_duration_seconds_bucket");
  });
});

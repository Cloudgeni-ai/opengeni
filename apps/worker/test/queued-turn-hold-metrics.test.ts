import { describe, expect, test } from "bun:test";
import { QUEUED_TURN_HOLDS, type QueuedTurnHold, type QueuedTurnHoldSummary } from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import { recordQueuedTurnHoldGauges, recordTurnsQueuedGauge } from "../src/observability-metrics";

function summary(
  partial: Partial<Record<QueuedTurnHold, QueuedTurnHoldSummary>>,
): Record<QueuedTurnHold, QueuedTurnHoldSummary> {
  return Object.fromEntries(
    QUEUED_TURN_HOLDS.map((hold) => [hold, partial[hold] ?? { count: 0, oldestAgeSeconds: 0 }]),
  ) as Record<QueuedTurnHold, QueuedTurnHoldSummary>;
}

describe("queued turn hold metrics", () => {
  test("publishes every hold class next to the unchanged total, without identities", async () => {
    const observability = createObservability(testSettings(), { component: "worker-control" });

    recordTurnsQueuedGauge(observability, 436);
    recordQueuedTurnHoldGauges(
      observability,
      summary({
        failed: { count: 418, oldestAgeSeconds: 4_913_615 },
        paused: { count: 16, oldestAgeSeconds: 4_998_296 },
        requires_action: { count: 2, oldestAgeSeconds: 4_130_518 },
      }),
    );

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turns_queued\{[^}]*\} 436/);
    expect(metrics).toMatch(/opengeni_turns_queued_by_hold\{[^}]*hold="failed"[^}]*\} 418/);
    expect(metrics).toMatch(/opengeni_turns_queued_by_hold\{[^}]*hold="paused"[^}]*\} 16/);
    expect(metrics).toMatch(/opengeni_turns_queued_by_hold\{[^}]*hold="requires_action"[^}]*\} 2/);
    expect(metrics).toMatch(/opengeni_turns_queued_by_hold\{[^}]*hold="ready"[^}]*\} 0/);
    expect(metrics).toMatch(
      /opengeni_turns_queued_oldest_age_seconds\{[^}]*hold="paused"[^}]*\} 4998296/,
    );
    for (const hold of QUEUED_TURN_HOLDS) {
      expect(metrics).toContain(`hold="${hold}"`);
    }
    expect(metrics).not.toMatch(/session_id|workspace_id|account_id/);
  });

  test("an emptied class drops back to zero on the next refresh", async () => {
    const observability = createObservability(testSettings(), { component: "worker-control" });

    recordQueuedTurnHoldGauges(
      observability,
      summary({ ready: { count: 3, oldestAgeSeconds: 9 } }),
    );
    recordQueuedTurnHoldGauges(observability, summary({}));

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turns_queued_by_hold\{[^}]*hold="ready"[^}]*\} 0/);
    expect(metrics).toMatch(/opengeni_turns_queued_oldest_age_seconds\{[^}]*hold="ready"[^}]*\} 0/);
  });

  test("publishes no split while the summary is not granted", async () => {
    const observability = createObservability(testSettings(), { component: "worker-control" });

    recordTurnsQueuedGauge(observability, 7);
    recordQueuedTurnHoldGauges(observability, null);

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turns_queued\{[^}]*\} 7/);
    expect(metrics).not.toMatch(/^opengeni_turns_queued_by_hold\{/m);
    expect(metrics).not.toMatch(/^opengeni_turns_queued_oldest_age_seconds\{/m);
  });
});

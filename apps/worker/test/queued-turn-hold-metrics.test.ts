import { describe, expect, test } from "bun:test";
import {
  CAPACITY_WAITING_TURN_PROVIDERS,
  QUEUED_TURN_HOLDS,
  type CapacityWaitingTurnProvider,
  type CapacityWaitingTurnSummary,
  type QueuedTurnHold,
  type QueuedTurnHoldSummary,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import {
  recordCapacityWaitingTurnGauges,
  recordQueuedTurnHoldGauges,
  recordTurnsQueuedGauge,
} from "../src/observability-metrics";

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
});

function waiting(
  partial: Partial<Record<CapacityWaitingTurnProvider, CapacityWaitingTurnSummary>>,
): Record<CapacityWaitingTurnProvider, CapacityWaitingTurnSummary> {
  return Object.fromEntries(
    CAPACITY_WAITING_TURN_PROVIDERS.map((provider) => [
      provider,
      partial[provider] ?? { count: 0, oldestAgeSeconds: 0 },
    ]),
  ) as Record<CapacityWaitingTurnProvider, CapacityWaitingTurnSummary>;
}

describe("capacity-waiting turn metrics", () => {
  test("publishes every provider's parked turns and oldest wait, without identities", async () => {
    const observability = createObservability(testSettings(), { component: "worker-control" });

    recordCapacityWaitingTurnGauges(
      observability,
      waiting({ codex: { count: 4, oldestAgeSeconds: 7_500 } }),
    );

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turns_waiting_capacity\{[^}]*provider="codex"[^}]*\} 4/);
    expect(metrics).toMatch(
      /opengeni_turns_waiting_capacity_oldest_age_seconds\{[^}]*provider="codex"[^}]*\} 7500/,
    );
    for (const provider of CAPACITY_WAITING_TURN_PROVIDERS) {
      expect(metrics).toMatch(
        new RegExp(`opengeni_turns_waiting_capacity\\{[^}]*provider="${provider}"`),
      );
    }
    expect(metrics).toMatch(/opengeni_turns_waiting_capacity\{[^}]*provider="claude"[^}]*\} 0/);
    expect(metrics).not.toMatch(/session_id|workspace_id|account_id/);
  });

  test("a provider whose waits ended drops back to zero on the next refresh", async () => {
    const observability = createObservability(testSettings(), { component: "worker-control" });

    recordCapacityWaitingTurnGauges(
      observability,
      waiting({ xai: { count: 2, oldestAgeSeconds: 60 } }),
    );
    recordCapacityWaitingTurnGauges(observability, waiting({}));

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turns_waiting_capacity\{[^}]*provider="xai"[^}]*\} 0/);
    expect(metrics).toMatch(
      /opengeni_turns_waiting_capacity_oldest_age_seconds\{[^}]*provider="xai"[^}]*\} 0/,
    );
  });
});

import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  initializeWorkerOutcomeMetrics,
  recordCreditBalanceGauges,
  recordWorkerDeathRecoveryMetrics,
  TurnLifecycleMetrics,
} from "../src/observability-metrics";

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

    tracker.start({ attemptId: "attempt-1" });
    now = 4_000;
    tracker.refreshGauges();

    let metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turns_inflight\{[^}]*\} 1/);
    expect(metrics).toMatch(/opengeni_turn_oldest_inflight_age_seconds\{[^}]*\} 3/);
    expect(metrics).toMatch(/opengeni_turn_oldest_no_progress_age_seconds\{[^}]*\} 3/);

    tracker.progress({ attemptId: "attempt-1" });
    now = 6_000;
    tracker.refreshGauges();
    metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turn_oldest_inflight_age_seconds\{[^}]*\} 5/);
    expect(metrics).toMatch(/opengeni_turn_oldest_no_progress_age_seconds\{[^}]*\} 2/);

    tracker.finish({ attemptId: "attempt-1", outcome: "completed" });

    metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turns_inflight\{[^}]*\} 0/);
    expect(metrics).toMatch(/opengeni_turn_oldest_no_progress_age_seconds\{[^}]*\} 0/);
    expect(metrics).toContain("opengeni_turns_total");
    expect(metrics).toContain('outcome="completed"');
    expect(metrics).toContain("opengeni_turn_duration_seconds_bucket");
  });

  test("keeps replacement attempts independent and clears unclassified predecessors", async () => {
    let now = 1_000;
    const observability = createObservability(testSettings(), {
      component: "worker",
      now: () => now,
    });
    const tracker = new TurnLifecycleMetrics(observability, {
      now: () => now,
      refreshIntervalMs: 60_000,
    });

    tracker.start({ attemptId: "attempt-1" });
    now = 5_000;
    tracker.start({ attemptId: "attempt-2" });
    now = 6_000;
    tracker.progress({ attemptId: "attempt-2" });

    // Failure settlement may itself fail after the durable control plane has
    // replaced the attempt. Physical activity finalization must still remove
    // only that predecessor without erasing the live replacement.
    tracker.finish({ attemptId: "attempt-1", outcome: null });
    now = 8_000;
    tracker.refreshGauges();

    let metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turns_inflight\{[^}]*\} 1/);
    expect(metrics).toMatch(/opengeni_turn_oldest_inflight_age_seconds\{[^}]*\} 3/);
    expect(metrics).toMatch(/opengeni_turn_oldest_no_progress_age_seconds\{[^}]*\} 2/);

    tracker.finish({ attemptId: "attempt-2", outcome: "completed" });
    metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turns_inflight\{[^}]*\} 0/);
    expect(metrics).toMatch(/opengeni_turn_oldest_no_progress_age_seconds\{[^}]*\} 0/);
  });

  test("records credit balance gauges by account", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });
    const accountA = "11111111-1111-4111-8111-111111111111";
    const accountB = "22222222-2222-4222-8222-222222222222";

    recordCreditBalanceGauges(observability, [
      { accountId: accountA, balanceMicros: 25_000 },
      { accountId: accountB, balanceMicros: -500 },
    ]);

    let metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      new RegExp(`opengeni_credit_balance_micros\\{[^}]*account_id="${accountA}"[^}]*\\} 25000`),
    );
    expect(metrics).toMatch(
      new RegExp(`opengeni_credit_balance_micros\\{[^}]*account_id="${accountB}"[^}]*\\} -500`),
    );

    recordCreditBalanceGauges(observability, [{ accountId: accountA, balanceMicros: 10_000 }]);

    metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      new RegExp(`opengeni_credit_balance_micros\\{[^}]*account_id="${accountA}"[^}]*\\} 10000`),
    );
    expect(metrics).toMatch(
      new RegExp(`opengeni_credit_balance_micros\\{[^}]*account_id="${accountB}"[^}]*\\} 0`),
    );
  });

  test("records fenced worker-death recovery and terminal exhaustion outcomes", async () => {
    const observability = createObservability(testSettings(), { component: "worker-control" });
    initializeWorkerOutcomeMetrics(observability);

    recordWorkerDeathRecoveryMetrics(observability, {
      outcome: "recovering",
      timeoutType: "HEARTBEAT",
    });
    recordWorkerDeathRecoveryMetrics(observability, {
      outcome: "exhausted",
      timeoutType: "HEARTBEAT",
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_turn_worker_death_recoveries_total\{[^}]*outcome="recovering"[^}]*timeout_type="heartbeat"[^}]*\} 1/,
    );
    expect(metrics).toMatch(
      /opengeni_turn_worker_death_recoveries_total\{[^}]*outcome="exhausted"[^}]*timeout_type="heartbeat"[^}]*\} 1/,
    );
    expect(metrics).toMatch(/opengeni_turns_total\{[^}]*outcome="recovering"[^}]*\} 1/);
    expect(metrics).toMatch(/opengeni_turns_total\{[^}]*outcome="failed"[^}]*\} 1/);
  });

  test("publishes zero outcome series before the first rare failure", async () => {
    const observability = createObservability(testSettings(), { component: "worker-turn" });

    initializeWorkerOutcomeMetrics(observability);

    const metrics = await observability.prometheusMetrics();
    for (const outcome of ["completed", "failed", "cancelled", "recovering"]) {
      expect(metrics).toMatch(
        new RegExp(`opengeni_turns_total\\{[^}]*outcome="${outcome}"[^}]*\\} 0`),
      );
    }
    for (const outcome of ["recovering", "exhausted"]) {
      for (const timeoutType of ["heartbeat", "schedule_to_start"]) {
        expect(metrics).toMatch(
          new RegExp(
            `opengeni_turn_worker_death_recoveries_total\\{[^}]*outcome="${outcome}"[^}]*timeout_type="${timeoutType}"[^}]*\\} 0`,
          ),
        );
      }
    }
  });
});

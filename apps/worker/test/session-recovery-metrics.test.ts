import { describe, expect, mock, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  recordContextCompactionPendingGauges,
  recordSessionRecoveryBacklogGauges,
  startContextCompactionPendingMonitor,
  startSessionRecoveryMonitor,
} from "../src/observability-metrics";

describe("durable context compaction metrics", () => {
  test("records bounded pending count and oldest age without identities", async () => {
    const observability = createObservability(testSettings(), { component: "worker-control" });

    recordContextCompactionPendingGauges(
      observability,
      {
        pendingCount: 2,
        oldestStartedAt: new Date("2026-09-02T00:00:00.000Z"),
      },
      Date.parse("2026-09-02T00:15:01.000Z"),
    );

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_context_compaction_pending\{[^}]*\} 2/);
    expect(metrics).toMatch(/opengeni_context_compaction_oldest_pending_age_seconds\{[^}]*\} 901/);
    expect(metrics).not.toMatch(/session_id|workspace_id|attempt_id/);
  });

  test("rebuilds pending age from the durable read after a monitor restart", async () => {
    const summary = {
      pendingCount: 1,
      oldestStartedAt: new Date("2026-09-02T00:00:00.000Z"),
    };
    const now = () => Date.parse("2026-09-02T00:20:00.000Z");

    for (let restart = 0; restart < 2; restart += 1) {
      const observability = createObservability(testSettings(), { component: "worker-control" });
      const monitor = startContextCompactionPendingMonitor({
        observability,
        read: async () => summary,
        intervalMs: 60_000,
        now,
      });
      await monitor.close();

      const metrics = await observability.prometheusMetrics();
      expect(metrics).toMatch(/opengeni_context_compaction_pending\{[^}]*\} 1/);
      expect(metrics).toMatch(
        /opengeni_context_compaction_oldest_pending_age_seconds\{[^}]*\} 1200/,
      );
      expect(metrics).toMatch(/opengeni_context_compaction_monitor_fresh\{[^}]*\} 1/);
    }
  });

  test("marks a failed durable projection read stale without failing worker health", async () => {
    const observability = createObservability(testSettings(), { component: "worker-control" });
    const warn = mock(() => undefined);
    observability.warn = warn;
    const monitor = startContextCompactionPendingMonitor({
      observability,
      read: async () => {
        throw new Error("compaction aggregate unavailable");
      },
      intervalMs: 60_000,
    });

    await monitor.close();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      error: "compaction aggregate unavailable",
    });
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_context_compaction_monitor_last_read_success\{[^}]*\} 0/);
    expect(metrics).toMatch(/opengeni_context_compaction_monitor_fresh\{[^}]*\} 0/);
  });
});

describe("durable session recovery metrics", () => {
  test("records only the bounded recovery-state labels", async () => {
    const observability = createObservability(testSettings(), { component: "worker-control" });

    recordSessionRecoveryBacklogGauges(observability, {
      quiescence_missing: 2,
      projection_stale: 4,
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_session_recovery_backlog\{[^}]*state="quiescence_missing"[^}]*\} 2/,
    );
    expect(metrics).toMatch(
      /opengeni_session_recovery_backlog\{[^}]*state="projection_stale"[^}]*\} 4/,
    );
    expect(metrics).not.toMatch(/session_id|workspace_id|attempt_id/);
  });

  test("refreshes immediately, does not overlap, and drains on close", async () => {
    const observability = createObservability(testSettings(), { component: "worker-control" });
    const first = deferred<{ quiescence_missing: number; projection_stale: number }>();
    const read = mock(() => first.promise);
    const monitor = startSessionRecoveryMonitor({ observability, read, intervalMs: 2 });

    await Bun.sleep(10);
    expect(read).toHaveBeenCalledTimes(1);
    const closing = monitor.close();
    first.resolve({ quiescence_missing: 1, projection_stale: 3 });
    await closing;
    await Bun.sleep(5);
    expect(read).toHaveBeenCalledTimes(1);

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_session_recovery_monitor_last_read_success\{[^}]*\} 1/);
    expect(metrics).toMatch(/opengeni_session_recovery_monitor_fresh\{[^}]*\} 1/);
    expect(metrics).toMatch(
      /opengeni_session_recovery_monitor_last_success_timestamp_seconds\{[^}]*\} \d+/,
    );
  });

  test("fails open for worker health while marking the projection stale", async () => {
    const observability = createObservability(testSettings(), { component: "worker-control" });
    const warn = mock(() => undefined);
    observability.warn = warn;
    const monitor = startSessionRecoveryMonitor({
      observability,
      read: async () => {
        throw new Error("aggregate unavailable");
      },
      intervalMs: 60_000,
    });

    await monitor.close();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ error: "aggregate unavailable" });
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_session_recovery_monitor_last_read_success\{[^}]*\} 0/);
    expect(metrics).toMatch(/opengeni_session_recovery_monitor_fresh\{[^}]*\} 0/);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

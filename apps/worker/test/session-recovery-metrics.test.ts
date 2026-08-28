import { describe, expect, mock, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  recordSessionRecoveryBacklogGauges,
  startSessionRecoveryMonitor,
} from "../src/observability-metrics";

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

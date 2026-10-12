import { expect, test } from "bun:test";
import { capacityWaitCandidateProviders } from "../src/subscription-core/waiter-candidates";
import { codexCapacityRefreshBackoffMs, subscriptionCoreCodexNextCheckAt } from "../src";

test("SUB-WAIT-01 candidate hints are bounded, canonical and distinct from a legacy evaluation", () => {
  expect(capacityWaitCandidateProviders(undefined)).toBeNull();
  expect(capacityWaitCandidateProviders(null)).toBeNull();
  expect(capacityWaitCandidateProviders([])).toEqual([]);
  const hints = ["second", "first", "second"];
  expect(capacityWaitCandidateProviders(hints)).toEqual(["first", "second"]);
  expect(hints).toEqual(["second", "first", "second"]);
  for (const ids of [[""], ["a,b"], ["Upper"], ["a".repeat(65)], Array(33).fill("first")])
    expect(() => capacityWaitCandidateProviders(ids)).toThrow("bounded provider identifiers");
});

test("SUB-WAIT-02 known resets never strand failover-aware waits after a lost mutation wake", () => {
  const now = new Date("2026-10-12T00:00:00Z");
  const reset = new Date(now.getTime() + 7 * 86_400_000);
  for (const refreshAttempt of [0, 1, 2, 10, 100]) {
    const result = subscriptionCoreCodexNextCheckAt({
      now,
      earliestResetAt: reset,
      healthRetryAt: null,
      refreshAttempt,
      failoverAware: true,
    });
    expect(result.resetKind).toBe("bounded_refresh");
    expect(result.nextCheckAt.getTime()).toBe(
      now.getTime() + codexCapacityRefreshBackoffMs(refreshAttempt),
    );
    expect(result.nextCheckAt.getTime() - now.getTime()).toBeLessThanOrEqual(15 * 60_000);
  }
  expect(
    subscriptionCoreCodexNextCheckAt({
      now,
      earliestResetAt: reset,
      healthRetryAt: null,
      refreshAttempt: 100,
    }),
  ).toEqual({ nextCheckAt: reset, resetKind: "authoritative" });
  const soon = new Date(now.getTime() + 1_000);
  expect(
    subscriptionCoreCodexNextCheckAt({
      now,
      earliestResetAt: soon,
      healthRetryAt: null,
      refreshAttempt: 100,
      failoverAware: true,
    }),
  ).toEqual({ nextCheckAt: soon, resetKind: "authoritative" });
  expect(
    subscriptionCoreCodexNextCheckAt({
      now,
      earliestResetAt: reset,
      healthRetryAt: soon,
      refreshAttempt: 100,
      failoverAware: true,
    }),
  ).toEqual({ nextCheckAt: soon, resetKind: "bounded_refresh" });
});

import { describe, expect, test } from "bun:test";
import {
  recordSessionUsageLimitEvent,
  SESSION_USAGE_LIMIT_EVENTS_METRIC,
  SESSION_USAGE_LIMIT_METRIC_BOUNDARIES,
  SESSION_USAGE_LIMIT_METRIC_OUTCOMES,
} from "../src/session-usage-limit-metrics";

// OPE-798 AC23: diagnostics distinguish each outcome with closed-set labels
// only; telemetry never changes an admission or settlement outcome.
describe("session usage limit metrics", () => {
  test("distinguishes reached, unpriced, preparing, unavailable, CAS conflict and accounting failure", () => {
    for (const outcome of [
      "reached",
      "unpriced",
      "preparing",
      "unavailable",
      "cas_conflict",
      "accounting_failure",
      "source_conflict",
      "forbidden",
      "disabled",
    ] as const) {
      expect(SESSION_USAGE_LIMIT_METRIC_OUTCOMES).toContain(outcome);
    }
    expect(new Set(SESSION_USAGE_LIMIT_METRIC_OUTCOMES).size).toBe(
      SESSION_USAGE_LIMIT_METRIC_OUTCOMES.length,
    );
  });

  test("labels are exactly boundary and outcome from closed sets", () => {
    const seen: Array<{ name: string; labels?: Record<string, string>; amount?: number }> = [];
    const sink = { incrementCounter: (metric: (typeof seen)[number]) => void seen.push(metric) };
    for (const boundary of SESSION_USAGE_LIMIT_METRIC_BOUNDARIES) {
      recordSessionUsageLimitEvent(sink, boundary, "reached");
    }
    expect(seen).toHaveLength(SESSION_USAGE_LIMIT_METRIC_BOUNDARIES.length);
    for (const metric of seen) {
      expect(metric.name).toBe(SESSION_USAGE_LIMIT_EVENTS_METRIC.name);
      expect(Object.keys(metric.labels ?? {}).sort()).toEqual(["boundary", "outcome"]);
      for (const value of Object.values(metric.labels ?? {})) {
        // No ids, amounts or free text: short snake_case enum values only.
        expect(value).toMatch(/^[a-z_]{1,32}$/);
      }
    }
  });

  test("never throws and ignores empty amounts", () => {
    const throwing = {
      incrementCounter: () => {
        throw new Error("exporter down");
      },
    };
    expect(() => recordSessionUsageLimitEvent(throwing, "claim", "reached")).not.toThrow();
    expect(() => recordSessionUsageLimitEvent(null, "claim", "reached")).not.toThrow();
    const seen: unknown[] = [];
    recordSessionUsageLimitEvent(
      { incrementCounter: (m) => void seen.push(m) },
      "import",
      "imported",
      0,
    );
    expect(seen).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CAPACITY_TIMER_WAKE_JITTER_MAX_MS,
  CAPACITY_WAKE_JITTER_MAX_MS,
  CAPACITY_WAKE_JITTER_PATCH,
  capacityWakeJitterMs,
} from "../src/workflows/session";

describe("capacity-wait wake jitter", () => {
  test("a scheduled reset timer spreads resumptions over at most one minute", () => {
    expect(CAPACITY_TIMER_WAKE_JITTER_MAX_MS).toBe(60_000);
    expect(capacityWakeJitterMs("timer", 0)).toBe(0);
    expect(capacityWakeJitterMs("timer", 0.5)).toBe(30_000);
    expect(capacityWakeJitterMs("timer", 1)).toBeLessThan(CAPACITY_TIMER_WAKE_JITTER_MAX_MS);
  });

  test("a capacity or queue wake spreads reconciliations over at most 30 seconds", () => {
    expect(CAPACITY_WAKE_JITTER_MAX_MS).toBe(30_000);
    expect(capacityWakeJitterMs("wake", 0)).toBe(0);
    expect(capacityWakeJitterMs("wake", 0.5)).toBe(15_000);
    expect(capacityWakeJitterMs("wake", 1)).toBeLessThan(CAPACITY_WAKE_JITTER_MAX_MS);
  });

  test("hostile samples stay inside the bound and never go negative", () => {
    for (const kind of ["timer", "wake"] as const) {
      const max =
        kind === "timer" ? CAPACITY_TIMER_WAKE_JITTER_MAX_MS : CAPACITY_WAKE_JITTER_MAX_MS;
      for (const sample of [Number.NaN, -5, 7, Number.POSITIVE_INFINITY]) {
        const jitter = capacityWakeJitterMs(kind, sample);
        expect(Number.isInteger(jitter)).toBe(true);
        expect(jitter).toBeGreaterThanOrEqual(0);
        expect(jitter).toBeLessThan(max);
      }
    }
  });

  test("the test-only workflow override can only narrow the production bound", () => {
    expect(capacityWakeJitterMs("wake", 0.99, 0)).toBe(0);
    expect(capacityWakeJitterMs("timer", 0.99, 0)).toBe(0);
    expect(capacityWakeJitterMs("wake", 0.5, 1_000)).toBe(500);
    expect(capacityWakeJitterMs("wake", 0.5, 10 * 60_000)).toBe(15_000);
    expect(capacityWakeJitterMs("wake", 0.5, -1)).toBe(0);
    expect(capacityWakeJitterMs("wake", 0.5, Number.NaN)).toBe(15_000);
  });

  test("a burst of waiters is spread across the window rather than collapsed", () => {
    // Stand-in for 190 workflows' independent seeded samples.
    let seed = 42;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const buckets = new Array(6).fill(0) as number[];
    for (let index = 0; index < 190; index += 1) {
      const jitter = capacityWakeJitterMs("timer", next());
      buckets[Math.floor(jitter / 10_000)]! += 1;
    }
    // No 10-second slice of the minute receives more than half the burst.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(95);
    }
  });

  test("every jitter draw is gated by the replay patch", () => {
    // Temporal seeds workflow Math.random deterministically, but a new draw or
    // timer on a history recorded before this change would break replay. Keep
    // every draw behind the patch marker.
    const source = readFileSync(new URL("../src/workflows/session.ts", import.meta.url), "utf8");
    expect(CAPACITY_WAKE_JITTER_PATCH).toBe("session-capacity-wake-jitter-v1");
    const draws = [...source.matchAll(/Math\.random\(\)/g)];
    expect(draws.length).toBe(2);
    for (const draw of draws) {
      const preceding = source.slice(Math.max(0, draw.index! - 600), draw.index!);
      expect(preceding).toContain("patched(CAPACITY_WAKE_JITTER_PATCH)");
    }
  });
});

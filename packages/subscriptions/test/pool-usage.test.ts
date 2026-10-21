import { describe, expect, test } from "bun:test";
import {
  buildSubscriptionUsagePool,
  type SubscriptionUsagePoolInput as Input,
  type SubscriptionUsagePoolWindowId as WindowId,
} from "../src/pool-usage";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const NOW = Date.UTC(2026, 9, 20, 12); // Tuesday; all calendar comparisons explicitly UTC.

function input(): Input {
  return { provider: "test", now: NOW, accounts: [], readings: [], calls: [], historyStart: null };
}
function account(
  data: Input,
  id: string,
  window: WindowId = "five_hour",
  used = 25,
  resetHours = 3,
  planWeight?: number,
): Input["accounts"][number] {
  const row: Input["accounts"][number] = {
    id,
    label: `Account ${id}`,
    plan: null,
    ...(planWeight === undefined ? {} : { planWeight }),
    windows: [
      { id: window, usedPercent: used, observedAt: NOW, resetsAt: NOW + resetHours * HOUR },
    ],
  };
  data.accounts.push(row);
  return row;
}
function reading(
  data: Input,
  id: string,
  window: WindowId,
  at: number,
  usedPercent: number,
  resetsAt = data.accounts.find((row) => row.id === id)!.windows.find((row) => row.id === window)!
    .resetsAt,
) {
  data.readings.push({ connectionId: id, window, observedAt: at, usedPercent, resetsAt });
}
function pace(
  data: Input,
  id: string,
  used: number[],
  window: WindowId = "five_hour",
  stepHours = 1,
) {
  used.forEach((value, index) =>
    reading(data, id, window, NOW - (used.length - 1 - index) * stepHours * HOUR, value),
  );
}
function result(data: Input, window: WindowId = "five_hour") {
  return buildSubscriptionUsagePool(data).windows.find((row) => row.id === window)!;
}
function calibration(
  data: Input,
  id: string,
  capacity: number,
  window: WindowId = "weekly",
  fractions = [5, 5, 5, 5],
  unitScales = [1, 1, 1, 1],
) {
  let used = 0;
  reading(data, id, window, NOW - fractions.length * HOUR, used);
  fractions.forEach((fraction, index) => {
    const start = NOW - (fractions.length - index) * HOUR;
    const units = (((capacity * fraction) / 100) * (unitScales[index] ?? 1)) / 2;
    data.calls.push(
      { connectionId: id, at: start + HOUR / 3, units },
      { connectionId: id, at: start + (2 * HOUR) / 3, units },
    );
    used += fraction;
    reading(data, id, window, start + HOUR, used);
  });
  data.accounts
    .find((row) => row.id === id)!
    .windows.find((row) => row.id === window)!.usedPercent = used;
}

describe("subscription usage pool weights", () => {
  // Adapter integration contract: Codex Plus=1, Pro≈10; Claude Pro=1,
  // Max 5x=5, Max 20x=20; unknown=1. Provider names/tier parsing deliberately
  // stay outside the provider-neutral pure package (check:subscription-core-neutral).
  test("relative tier estimates are dimensionless, provider-owned, and unknown tiers are 1", () => {
    const data = input();
    account(data, "plus", "weekly", 80, 24, 1);
    account(data, "pro", "weekly", 20, 24, 10);
    account(data, "unknown", "weekly", 50, 24);
    const pool = result(data, "weekly");
    expect(pool.accounts.map((row) => row.weight)).toEqual([1, 10, 1]);
    expect(pool.remainingPercent).toBeCloseTo((20 + 800 + 50) / 12);
    expect(pool.accounts.every((row) => row.weightBasis === "plan_estimate")).toBe(true);
  });

  test("supplied 1/5/20 tier estimates preserve their relative capacities", () => {
    const data = input();
    for (const weight of [1, 5, 20]) account(data, String(weight), "weekly", 0, 24, weight);
    expect(result(data, "weekly").accounts.map((row) => row.weight)).toEqual([1, 5, 20]);
  });

  test("calibrates observed capacities and normalizes an unobserved tier to the known anchor", () => {
    const data = input();
    account(data, "base", "weekly", 20, 24, 1);
    account(data, "large", "weekly", 20, 24, 10);
    account(data, "estimate", "weekly", 0, 24, 5);
    calibration(data, "base", 7_000);
    calibration(data, "large", 70_000);
    const pool = result(data, "weekly");
    expect(pool.accounts.map((row) => row.weight)).toEqual([1, 10, 5]);
    expect(pool.accounts.map((row) => row.weightBasis)).toEqual([
      "observed",
      "observed",
      "plan_estimate",
    ]);
    const scaled = structuredClone(data);
    scaled.calls.forEach((call) => {
      call.units *= 1_000_000;
    });
    expect(result(scaled, "weekly")).toEqual(pool);
  });

  test("unknown-tier measured capacities normalize together rather than mixing raw units and 1", () => {
    const data = input();
    account(data, "a", "weekly", 20, 24);
    account(data, "b", "weekly", 20, 24);
    account(data, "c", "weekly", 0, 24);
    calibration(data, "a", 1_000);
    calibration(data, "b", 3_000);
    expect(result(data, "weekly").accounts.map((row) => row.weight)).toEqual([0.5, 1.5, 1]);
  });

  test("calibrated fractional weights keep aggregate percentages within exact bounds", () => {
    for (const window of ["five_hour", "weekly"] as const) {
      const data = input();
      for (const capacity of [9_000, 31_000, 69_000]) {
        const id = String(capacity);
        account(data, id, window, 20, window === "five_hour" ? 1 : 24, 1);
        calibration(data, id, capacity, window);
      }
      // Calibrate against the preceding window, then observe fresh current limits.
      // This avoids conflicting same-timestamp history and snapshot readings.
      const duration = window === "five_hour" ? 5 * HOUR : WEEK;
      for (const row of data.readings) {
        row.observedAt -= duration;
        row.resetsAt! -= duration;
      }
      for (const call of data.calls) call.at -= duration;

      for (const usedPercent of [0, 62.5, 100]) {
        for (const row of data.accounts) row.windows[0]!.usedPercent = usedPercent;
        const pool = result(data, window);
        expect(pool.accounts.map((row) => row.weightBasis)).toEqual([
          "observed",
          "observed",
          "observed",
        ]);
        expect(pool.accounts.map((row) => row.weight)).toEqual([9 / 31, 1, 69 / 31]);
        if (usedPercent === 0) {
          const raw =
            pool.accounts.reduce((total, row) => total + row.weight * row.remainingPercent!, 0) /
            pool.accounts.reduce((total, row) => total + row.weight, 0);
          expect(raw).toBeGreaterThan(100); // Reproduces the rejected API percentage.
          expect(pool.remainingPercent).toBe(100);
        } else if (usedPercent === 100) {
          expect(pool.remainingPercent).toBe(0);
        } else {
          expect(pool.remainingPercent).toBeCloseTo(37.5);
        }
        expect(pool.remainingPercent!).toBeGreaterThanOrEqual(0);
        expect(pool.remainingPercent!).toBeLessThanOrEqual(100);
      }
      data.accounts[0]!.windows[0]!.usedPercent = null;
      // An unknown account is left out; the others still total exactly.
      expect(result(data, window).accounts[0]!.remainingPercent).toBeNull();
      expect(result(data, window).remainingPercent).toBe(0);
    }
  });

  test("median calibration resists a single extreme internal-call sample", () => {
    const data = input();
    account(data, "a", "weekly", 20, 24, 1);
    account(data, "b", "weekly", 20, 24, 1);
    calibration(data, "a", 1_000);
    calibration(data, "b", 2_000, "weekly", [5, 5, 5, 5], [1, 1, 1, 100_000]);
    const weights = result(data, "weekly").accounts;
    expect(weights.every((row) => row.weightBasis === "observed")).toBe(true);
    expect(weights[1]!.weight / weights[0]!.weight).toBeCloseTo(2);
  });

  test("sample count, movement coverage and dispersion thresholds reject unreliable calibration", () => {
    for (const mode of ["few_calls", "low_coverage", "dispersion", "tiny_movement"]) {
      const data = input();
      account(data, "a", "weekly", 20, 24, 10);
      calibration(
        data,
        "a",
        1_000,
        "weekly",
        mode === "tiny_movement" ? [1, 1, 1, 1] : [5, 5, 5, 5],
        mode === "dispersion" ? [1, 10, 100, 1_000] : undefined,
      );
      if (mode === "few_calls") data.calls = data.calls.slice(0, 2);
      if (mode === "low_coverage") {
        data.calls = data.calls.slice(2);
        data.readings[1]!.usedPercent = 16;
      }
      expect(result(data, "weekly").accounts[0]!.weightBasis).toBe("plan_estimate");
      expect(result(data, "weekly").accounts[0]!.weight).toBe(10);
    }
  });

  test("the same accounts can have different relative capacities for each window", () => {
    const data = input();
    for (const id of ["a", "b"]) {
      const row = account(data, id, "five_hour", 40, 1, 1);
      row.windows.push({ id: "weekly", usedPercent: 20, observedAt: NOW, resetsAt: NOW + DAY });
      calibration(data, id, 1_000, "weekly");
      pace(data, id, id === "a" ? [0, 5, 10, 15, 20] : [0, 10, 20, 30, 40]);
      row.windows[0]!.usedPercent = id === "a" ? 20 : 40;
    }
    const short = result(data).accounts;
    const long = result(data, "weekly").accounts;
    expect(short[1]!.weight / short[0]!.weight).toBeCloseTo(0.5);
    expect(long[1]!.weight / long[0]!.weight).toBeCloseTo(1);
  });

  test("small percentage movements from frequent polls accumulate for calibration", () => {
    const data = input();
    account(data, "a", "five_hour", 20, 3, 1);
    pace(
      data,
      "a",
      Array.from({ length: 121 }, (_, index) => index / 6),
      "five_hour",
      1 / 60,
    );
    for (let minute = 1; minute <= 120; minute++) {
      data.calls.push({ connectionId: "a", at: NOW - (120 - minute) * 60_000, units: 10 });
    }
    expect(result(data).accounts[0]!.weightBasis).toBe("observed");
  });
});

describe("subscription usage pool forecast", () => {
  test("actual percentage movement predicts external usage even with no internal calls", () => {
    const data = input();
    account(data, "a", "five_hour", 90);
    pace(data, "a", [80, 85, 90]);
    const forecast = result(data).forecast;
    expect(forecast.kind).toBe("runs_out");
    expect(forecast.runsOutAt).toBeCloseTo(NOW + 2 * HOUR, 0);
    expect(forecast.nextResetAt).toBe(NOW + 3 * HOUR);
    expect(forecast.lowestPercent).toBeCloseTo(0);
    expect(forecast.unusedPercent).toBeNull();
  });

  test("unused capacity and lowest pool point account for the exact fractional reset", () => {
    const data = input();
    account(data, "a", "five_hour", 20, 2.5);
    pace(data, "a", [0, 10, 20]);
    const forecast = result(data).forecast;
    expect(forecast.kind).toBe("unused");
    expect(forecast.nextResetAt).toBe(NOW + 2.5 * HOUR);
    expect(forecast.unusedPercent).toBeCloseTo(55);
    expect(forecast.lowestPercent).toBeCloseTo(55);
  });

  test("redistributes from depleted accounts instead of projecting negative individual limits", () => {
    const data = input();
    account(data, "a", "five_hour", 100, 2);
    account(data, "b", "five_hour", 0, 3);
    pace(data, "a", [80, 90, 100]);
    pace(data, "b", [0, 0, 0]);
    const forecast = result(data).forecast;
    expect(forecast.kind).toBe("unused");
    // B serves 20% before A resets, then both serve 5%; B expires with 75%.
    expect(forecast.unusedPercent).toBeCloseTo(37.5);
    expect(forecast.lowestPercent).toBeCloseTo(40);
  });

  test("an early account refill can prevent exhaustion before the later account reset", () => {
    const data = input();
    account(data, "a", "five_hour", 95, 0.5);
    account(data, "b", "five_hour", 95, 3);
    pace(data, "a", [85, 90, 95]);
    pace(data, "b", [85, 90, 95]);
    expect(result(data).forecast.kind).toBe("unused");
    expect(result(data).forecast.lowestPercent).toBeCloseTo(2.5);
  });

  test("reports the first exhaustion and next reset even if a later refill recovers the pool", () => {
    const data = input();
    account(data, "a", "five_hour", 99, 0.5);
    account(data, "b", "five_hour", 99, 3);
    pace(data, "a", [89, 94, 99]);
    pace(data, "b", [89, 94, 99]);
    const forecast = result(data).forecast;
    expect(forecast.kind).toBe("runs_out");
    expect(forecast.runsOutAt).toBeCloseTo(NOW + 0.2 * HOUR, 0);
    expect(forecast.nextResetAt).toBe(NOW + 0.5 * HOUR);
    expect(forecast.lowestPercent).toBe(0);
  });

  test("current exhaustion is observable without historical demand", () => {
    const data = input();
    account(data, "a", "five_hour", 100, 0.25);
    expect(result(data).forecast).toMatchObject({
      kind: "runs_out",
      runsOutAt: NOW,
      lowestPercent: 0,
    });
  });

  test("explicit zero movement is evidence, whereas an empty call log is not", () => {
    const data = input();
    account(data, "a", "five_hour", 0);
    expect(result(data).forecast.kind).toBe("insufficient_history");
    pace(data, "a", [0, 0, 0]);
    expect(result(data).forecast).toMatchObject({
      kind: "unused",
      unusedPercent: 100,
      lowestPercent: 100,
    });
  });

  test("a flat exhausted account cannot assert zero demand in a partly usable pool", () => {
    const data = input();
    account(data, "a", "five_hour", 100, 3);
    account(data, "b", "five_hour", 0, 3);
    pace(data, "a", [100, 100, 100]);
    pace(data, "b", [0, 0, 0]);
    expect(result(data).forecast.kind).toBe("runs_out");
    expect(result(data).forecast.basis).toContain("Last-reset average fallback");
  });

  test("an exhausted observed pool reports runout even without a known reset", () => {
    const data = input();
    account(data, "a", "five_hour", 100).windows[0]!.resetsAt = null;
    expect(result(data).forecast).toMatchObject({
      kind: "runs_out",
      runsOutAt: NOW,
      nextResetAt: null,
    });
  });

  test("sparse history uses last-reset pace only when positive usage and elapsed time are known", () => {
    const data = input();
    account(data, "a", "five_hour", 20, 3);
    expect(result(data).forecast.kind).toBe("unused");
    expect(result(data).forecast.unusedPercent).toBeCloseTo(50);
    expect(result(data).forecast.basis).toContain("Last-reset average fallback");
    data.accounts[0]!.windows[0]!.resetsAt = null;
    expect(result(data).remainingPercent).toBe(80);
    expect(result(data).forecast.kind).toBe("insufficient_history");
  });

  test("frequent polls accumulate into useful stable samples", () => {
    const data = input();
    account(data, "a", "five_hour", 20, 3);
    pace(
      data,
      "a",
      Array.from({ length: 121 }, (_, index) => index / 6),
      "five_hour",
      1 / 60,
    );
    expect(result(data).forecast.basis).toStartWith("Observed percentage movements");
    expect(result(data).forecast.unusedPercent).toBeCloseTo(50);
  });

  test("historical reset changes and downward corrections are never negative demand", () => {
    const data = input();
    account(data, "a", "five_hour", 20, 3);
    reading(data, "a", "five_hour", NOW - 4 * HOUR, 80, NOW - 2 * HOUR);
    reading(data, "a", "five_hour", NOW - 3 * HOUR, 90, NOW - 2 * HOUR);
    pace(data, "a", [40, 10, 20]);
    const pool = result(data);
    expect(pool.accounts[0]!.weightBasis).toBe("plan_estimate");
    expect(pool.forecast.lowestPercent).toBeGreaterThanOrEqual(0);
    expect(pool.forecast.unusedPercent ?? 0).toBeLessThanOrEqual(100);
  });

  test("calls shape intervals without replacing observed movement with internal usage magnitude", () => {
    const data = input();
    account(data, "a", "five_hour", 40, 1);
    pace(data, "a", [0, 20, 40], "five_hour", 2);
    for (const start of [NOW - 4 * HOUR, NOW - 2 * HOUR]) {
      for (const minutes of [10, 20, 30])
        data.calls.push({ connectionId: "a", at: start + minutes * 60_000, units: 10 });
    }
    const shaped = result(data);
    expect(shaped.forecast.basis).toContain("Observed percentage movements");
    expect(shaped.forecast.basis).toContain("last-hour adjustment 0.50x");
    const scaled = structuredClone(data);
    scaled.calls.forEach((call) => {
      call.units *= 1e9;
    });
    expect(result(scaled)).toEqual(shaped);
  });

  test("one call-size outlier does not dominate hourly shape", () => {
    const data = input();
    account(data, "a", "five_hour", 20, 1);
    pace(data, "a", [0, 10, 20], "five_hour", 2);
    for (let hours = 3.5; hours > 0; hours -= 0.5)
      data.calls.push({ connectionId: "a", at: NOW - hours * HOUR, units: 1 });
    data.calls[0]!.units = 1e12;
    expect(result(data).forecast.unusedPercent).toBeGreaterThan(65);
    expect(result(data).forecast.unusedPercent).toBeLessThan(80);
  });

  test("a weekly pool walks through all staggered resets, not just the earliest", () => {
    const data = input();
    account(data, "a", "weekly", 20, 1.25);
    account(data, "b", "weekly", 20, 30.5);
    pace(data, "a", [18, 19, 20], "weekly");
    pace(data, "b", [18, 19, 20], "weekly");
    const forecast = result(data, "weekly").forecast;
    expect(forecast.kind).toBe("unused");
    expect(forecast.nextResetAt).toBe(NOW + 1.25 * HOUR);
    expect(forecast.unusedPercent).toBeCloseTo((78.75 + 49.5) / 2);
    expect(forecast.lowestPercent).toBeCloseTo((70.75 + 49.5) / 2);
  });
});

describe("weekly included utilization", () => {
  test("sums leftover at each account's own staggered reset rather than at the pool horizon", () => {
    const data = input();
    account(data, "a", "weekly", 20, 1.25);
    account(data, "b", "weekly", 20, 30.5);
    pace(data, "a", [18, 19, 20], "weekly");
    pace(data, "b", [18, 19, 20], "weekly");
    const forecast = result(data, "weekly").forecast;
    expect(forecast.utilizationPercent).toBeCloseTo(100 - (78.75 + 49.5) / 2);
    expect(forecast.kind).toBe("unused");
  });

  test("uses plan size for the weighted reset remainder, including usage already consumed", () => {
    const data = input();
    account(data, "large", "weekly", 20, 1, 10);
    account(data, "small", "weekly", 20, 3, 1);
    pace(data, "large", [18, 19, 20], "weekly");
    pace(data, "small", [18, 19, 20], "weekly");
    expect(result(data, "weekly").forecast.utilizationPercent).toBeCloseTo(
      100 - (10 * 79 + 77) / 11,
    );
  });

  test("all-unused pools have zero utilization only with observed zero movement", () => {
    const data = input();
    for (const [id, reset, weight] of [
      ["a", 3, 10],
      ["b", 48, 1],
    ] as const) {
      account(data, id, "weekly", 0, reset, weight);
      pace(data, id, [0, 0, 0], "weekly");
    }
    expect(result(data, "weekly").forecast).toMatchObject({
      kind: "unused",
      utilizationPercent: 0,
      unusedPercent: 100,
    });
    data.readings = [];
    expect(result(data, "weekly").forecast.utilizationPercent).toBeNull();
  });

  test("runout precedes relief and still computes each first-reset remainder", () => {
    const data = input();
    account(data, "a", "weekly", 99, 0.5);
    account(data, "b", "weekly", 99, 1);
    pace(data, "a", [89, 94, 99], "weekly");
    pace(data, "b", [89, 94, 99], "weekly");
    const forecast = result(data, "weekly").forecast;
    expect(forecast.kind).toBe("runs_out");
    expect(forecast.runsOutAt).toBeCloseTo(NOW + 0.2 * HOUR, 0);
    expect(forecast.nextResetAt).toBe(NOW + 0.5 * HOUR);
    expect(forecast.utilizationPercent).toBe(100);
  });

  test("exhaustion exactly at a replenishing reset is not a runout before relief", () => {
    const data = input();
    account(data, "a", "weekly", 98, 2);
    pace(data, "a", [96, 97, 98], "weekly");
    expect(result(data, "weekly").forecast).toMatchObject({
      kind: "unused",
      runsOutAt: null,
      utilizationPercent: 100,
    });
  });
});

describe("calendar profiles and bounded trend", () => {
  function calendar(currentRate: number, previousRate: number, hours = 12): Input {
    const data = input();
    const monday = NOW - 36 * HOUR;
    account(data, "a", "weekly", hours * currentRate, 24);
    for (let week = 0; week <= 1; week++) {
      for (let hour = 0; hour <= hours; hour++) {
        reading(
          data,
          "a",
          "weekly",
          monday - week * WEEK + hour * HOUR,
          hour * (week ? previousRate : currentRate),
          NOW + DAY - week * WEEK,
        );
      }
    }
    data.historyStart = NOW - 14 * DAY;
    return data;
  }

  test("compares this UTC calendar week's completed hours against exactly the same prior hours", () => {
    const pool = result(calendar(0.2, 0.1), "weekly");
    expect(pool.forecast.basis).toContain("same-hours weekly trend 1.41x");
    expect(pool.forecast.basis).not.toContain("last-hour adjustment");
  });

  test("weekly trend changes projected consumption, not just its explanation", () => {
    const data = calendar(0.2, 0.1);
    const trended = result(data, "weekly");
    data.readings = data.readings.filter((row) => row.observedAt >= NOW - WEEK);
    const untrended = result(data, "weekly");
    expect(trended.forecast.kind).toBe("unused");
    expect(untrended.forecast.kind).toBe("unused");
    const trendDemand = trended.remainingPercent! - trended.forecast.unusedPercent!;
    const plainDemand = untrended.remainingPercent! - untrended.forecast.unusedPercent!;
    expect(trendDemand / plainDemand).toBeCloseTo(Math.sqrt(2));
  });

  test("last-seven-day hour-of-week shape changes the exact projected exhaustion time", () => {
    function shaped(values: number[]) {
      const data = input();
      account(data, "a", "weekly", 99, 24);
      values.forEach((used, index) =>
        reading(data, "a", "weekly", NOW - WEEK + index * HOUR, used, NOW - WEEK + DAY),
      );
      pace(data, "a", [99, 99, 99], "weekly");
      return result(data, "weekly").forecast;
    }
    const early = shaped([0, 5, 5, 5]);
    const late = shaped([0, 0, 0, 5]);
    expect(early.runsOutAt).toBeCloseTo(NOW + 0.2 * HOUR, 0);
    expect(late.runsOutAt).toBeCloseTo(NOW + 2.2 * HOUR, 0);
  });

  test("trend is bounded and incomplete paired coverage does not establish a trend", () => {
    expect(result(calendar(4, 0.1), "weekly").forecast.basis).toContain(
      "same-hours weekly trend 2.00x",
    );
    expect(result(calendar(0.1, 4), "weekly").forecast.basis).toContain(
      "same-hours weekly trend 0.50x",
    );
    expect(result(calendar(0.2, 0.1, 2), "weekly").forecast.basis).toContain(
      "same-hours weekly trend 1.00x",
    );
  });

  test("future observations and unrelated accounts cannot affect profile or trend", () => {
    const data = calendar(0.2, 0.1);
    const expected = result(data, "weekly");
    reading(data, "a", "weekly", NOW + HOUR, 100);
    data.readings.push({
      connectionId: "not_in_pool",
      window: "weekly",
      usedPercent: 100,
      observedAt: NOW,
      resetsAt: NOW + HOUR,
    });
    data.calls.push({ connectionId: "not_in_pool", at: NOW, units: 1e20 });
    expect(result(data, "weekly")).toEqual(expected);
  });

  test("history is bounded to 14 days and honors the actual retention start", () => {
    const data = calendar(0.2, 0.1);
    reading(data, "a", "weekly", NOW - 30 * DAY, 0, NOW - 24 * DAY);
    expect(result(data, "weekly").forecast.historyDays).toBe(8.5);
    data.historyStart = NOW - 2 * DAY;
    expect(result(data, "weekly").forecast.historyDays).toBe(1.5);
    expect(result(data, "weekly").forecast.basis).toContain("same-hours weekly trend 1.00x");
  });

  test("a percentage spike is damped rather than extrapolated as persistent demand", () => {
    const data = input();
    account(data, "a", "weekly", 60, 24);
    pace(data, "a", [0, 1, 2, 3, 4, 5, 60], "weekly");
    const forecast = result(data, "weekly").forecast;
    expect(forecast.kind).toBe("unused");
    expect(forecast.unusedPercent).toBeGreaterThan(0);
  });
});

describe("unknown and stale coverage", () => {
  test("both limits remain visible when every window is absent", () => {
    const data = input();
    data.accounts.push({ id: "a", label: "Absent", plan: null, windows: [] });
    const pool = buildSubscriptionUsagePool(data);
    expect(pool.observedAt).toBeNull();
    expect(pool.windows.map((window) => window.id)).toEqual(["five_hour", "weekly"]);
    for (const window of pool.windows) {
      expect(window.remainingPercent).toBeNull();
      expect(window.accounts).toHaveLength(1);
      expect(window.accounts[0]!.remainingPercent).toBeNull();
      expect(window.forecast.kind).toBe("insufficient_history");
    }
  });

  test("one missing account is left out of the total and forecast, and stays listed as unknown", () => {
    const data = input();
    account(data, "known", "five_hour", 0, 3, 10);
    data.accounts.push({ id: "missing", label: "Missing", plan: null, windows: [] });
    const pool = result(data);
    expect(pool.remainingPercent).toBe(100);
    expect(pool.accounts[0]!.remainingPercent).toBe(100);
    expect(pool.accounts[1]!.remainingPercent).toBeNull();
  });

  test("a past or exact-now reset never fabricates a full account", () => {
    for (const offset of [-HOUR, 0]) {
      const data = input();
      account(data, "a", "five_hour", 100);
      data.accounts[0]!.windows[0]!.resetsAt = NOW + offset;
      expect(result(data).remainingPercent).toBeNull();
      expect(result(data).forecast.kind).toBe("insufficient_history");
    }
  });

  test("a reading stays current until its reset; without a reset, freshness is bounded by window policy", () => {
    for (const [window, ttl] of [
      ["five_hour", HOUR],
      ["weekly", DAY],
    ] as const) {
      const data = input();
      account(data, "a", window, 20, 1);
      data.accounts[0]!.windows[0]!.observedAt = NOW - ttl - 1;
      // Usage only grows within a window: the older reading is still what the list shows.
      expect(result(data, window).remainingPercent).toBe(80);
      data.accounts[0]!.windows[0]!.resetsAt = null;
      expect(result(data, window).remainingPercent).toBeNull();
      expect(result(data, window).accounts[0]!.observedAt).toBe(NOW - ttl - 1);
    }
  });

  test("a usage-limit block counts as nothing left until it ends, whatever the last percentage said", () => {
    const data = input();
    account(data, "open", "weekly", 40, 48, 1);
    const blocked = account(data, "blocked", "weekly", 10, 48, 1);
    blocked.blocked = { weekly: NOW + 30 * HOUR };
    const pool = result(data, "weekly");
    expect(pool.accounts[1]!.remainingPercent).toBe(0);
    expect(pool.accounts[1]!.resetsAt).toBe(NOW + 30 * HOUR);
    expect(pool.remainingPercent).toBe(30);
    blocked.blocked = { weekly: NOW - 1 };
    expect(result(data, "weekly").remainingPercent).toBe(75);
  });

  test("a newer explicit unknown does not resurrect historical remaining", () => {
    const data = input();
    const row = account(data, "a");
    row.windows[0]!.usedPercent = null;
    reading(data, "a", "five_hour", NOW - 10_000, 0);
    expect(result(data).remainingPercent).toBeNull();
  });

  test("invalid numeric observations are unknown and cannot leak NaN into output", () => {
    for (const used of [NaN, Infinity, -1, 101]) {
      const data = input();
      account(data, "a", "five_hour", used);
      const pool = result(data);
      expect(pool.remainingPercent).toBeNull();
      expect(pool.accounts[0]!.remainingPercent).toBeNull();
    }
  });

  test("a future timestamp or reset beyond the window duration is not fresh coverage", () => {
    const data = input();
    const row = account(data, "a");
    row.windows[0]!.observedAt = NOW + 1;
    expect(result(data).remainingPercent).toBeNull();
    row.windows[0]!.observedAt = NOW;
    row.windows[0]!.resetsAt = NOW + 6 * HOUR;
    expect(result(data).remainingPercent).toBeNull();
  });

  test("identical duplicate reads are harmless and conflicting duplicates do not calibrate", () => {
    const data = input();
    account(data, "a", "weekly", 20, 24, 1);
    calibration(data, "a", 1_000);
    const expected = result(data, "weekly");
    data.readings.push(...structuredClone(data.readings));
    expect(result(data, "weekly")).toEqual(expected);
    data.readings.push({ ...data.readings[2]!, usedPercent: 99 });
    expect(result(data, "weekly").accounts[0]!.weightBasis).toBe("plan_estimate");
  });

  test("empty pools are unknown, inputs are not mutated, and output contains no call units", () => {
    expect(result(input()).remainingPercent).toBeNull();
    const data = input();
    account(data, "a", "weekly", 20, 24, 1);
    calibration(data, "a", 1_000);
    const before = structuredClone(data);
    const pool = buildSubscriptionUsagePool(data);
    expect(data).toEqual(before);
    expect(JSON.stringify(pool)).not.toContain('"units"');
    expect(JSON.stringify(pool)).not.toContain('"calls"');
  });

  test("duplicate account ids and invalid clocks fail explicitly", () => {
    const data = input();
    account(data, "a");
    account(data, "a");
    expect(() => buildSubscriptionUsagePool(data)).toThrow("account ids must be unique");
    expect(() => buildSubscriptionUsagePool({ ...input(), now: NaN })).toThrow("timestamp");
  });

  test("constant demand conserves pool capacity across differing weights and depleted accounts", () => {
    for (let seed = 0; seed < 60; seed++) {
      const data = input();
      const horizonHours = 1 + (seed % 9) / 4;
      let capacity = 0;
      let remaining = 0;
      let rate = 0;
      for (let index = 0; index < 3; index++) {
        const weight = [1, 5, 10][index]!;
        const used = 30 + ((seed * 7 + index * 17) % 66);
        const hourly = 1 + ((seed + index * 3) % 10);
        const id = String(index);
        account(data, id, "five_hour", used, horizonHours, weight);
        pace(data, id, [used - 2 * hourly, used - hourly, used]);
        capacity += weight;
        remaining += (weight * (100 - used)) / 100;
        rate += (weight * hourly) / 100;
      }
      const forecast = result(data).forecast;
      const exhaustHours = remaining / rate;
      if (exhaustHours <= horizonHours) {
        expect(forecast.kind).toBe("runs_out");
        expect(forecast.runsOutAt).toBeCloseTo(NOW + exhaustHours * HOUR, 0);
        expect(forecast.lowestPercent).toBeCloseTo(0);
      } else {
        const unused = ((remaining - rate * horizonHours) / capacity) * 100;
        expect(forecast.kind).toBe("unused");
        expect(forecast.unusedPercent).toBeCloseTo(unused);
        expect(forecast.lowestPercent).toBeCloseTo(unused);
      }
    }
  });
});

import { expect, test } from "bun:test";
import type { Outcome } from "./load.ts";
import { judgeStep, MIN_EXPECTED_SAMPLES, roundRate, searchSustainedRate, type StepResult, stepWindow } from "./search.ts";

function outcomes(count: number, windowMs: number, latencyMs: number, extra: Partial<Outcome> = {}): Outcome[] {
  return Array.from({ length: count }, (_, i) => ({ at: (i * windowMs) / count, ok: true, latencyMs, lagMs: 0, ...extra }));
}

test("a step holds with no errors, p99 under a second and the offered rate completed", () => {
  const step = judgeStep(10, outcomes(600, 60_000, 200), 10_000, 50_000);
  expect(step.measured).toBe(500);
  expect(step.completedRate).toBe(10);
  expect(step.holds).toBe(true);
});

test("the warm-up does not count", () => {
  // Slow while warming up, fast after.
  const all = [...outcomes(100, 10_000, 5000), ...outcomes(500, 50_000, 100).map((o) => ({ ...o, at: o.at + 10_000 }))];
  expect(judgeStep(10, all, 10_000, 50_000).holds).toBe(true);
});

test("a p99 at the limit fails", () => {
  const all = outcomes(500, 50_000, 100).map((o) => ({ ...o, at: o.at + 10_000 }));
  for (let i = 0; i < 6; i++) all[i * 50].latencyMs = 1000;
  const step = judgeStep(10, all, 10_000, 50_000);
  expect(step.holds).toBe(false);
  expect(step.reason).toContain("p99");
});

test("one error fails a step", () => {
  const all = outcomes(500, 50_000, 100).map((o) => ({ ...o, at: o.at + 10_000 }));
  all[3] = { ...all[3], ok: false, error: "host full" };
  const step = judgeStep(10, all, 10_000, 50_000);
  expect(step).toMatchObject({ holds: false, errors: 1, sampleErrors: ["host full"] });
});

test("fewer arrivals than the nominal rate is chance, not a failure", () => {
  // 0.3/s over 133 s expects 40; 34 is about one standard deviation short.
  const all = outcomes(34, 133_000, 3000).map((o) => ({ ...o, at: o.at + 10_000 }));
  const step = judgeStep(0.3, all, 10_000, 133_000, { p99LimitMs: 8000, minSamples: 20 });
  expect(step.completedRate).toBeCloseTo(0.256, 3);
  expect(step.holds).toBe(true);
});

test("starvation is the client's limit", () => {
  const all = outcomes(500, 50_000, 100, { at: 20_000 });
  all[0] = { ...all[0], ok: false, starved: true };
  expect(judgeStep(10, all, 10_000, 50_000).reason).toContain("client-limited");
});

function step(rate: number, holds: boolean, errors = 0, starved = 0): StepResult {
  return { rate, measured: 100, errors, starved, completedRate: rate, holds };
}

test("the search climbs the ladder, then bisects between the last good and first bad rate", async () => {
  const capacity = 37;
  const tried: number[] = [];
  const result = await searchSustainedRate([5, 10, 20, 50, 100], async (rate) => {
    tried.push(rate);
    return step(rate, rate <= capacity, rate > 45 ? 1 : 0);
  });
  // 50 fails; then 35 holds, 43 fails, 39 fails.
  expect(tried).toEqual([5, 10, 20, 50, 35, 43, 39]);
  expect(result.sustained).toBe(35);
  expect(result.errorOnset).toBe(50);
  expect(result.clientLimited).toBe(false);
});

test("a system that holds everything reports the top of the ladder", async () => {
  const result = await searchSustainedRate([1, 2, 5], async (rate) => step(rate, true));
  expect(result.sustained).toBe(5);
  expect(result.errorOnset).toBeUndefined();
  expect(result.steps.length).toBe(3);
});

test("a first step that fails reports zero and bisects below it", async () => {
  const result = await searchSustainedRate([4, 8], async (rate) => step(rate, rate < 1.5), 3);
  expect(result.steps.map((s) => s.rate)).toEqual([4, 2, 1, 1.5]);
  expect(result.sustained).toBe(1);
});

test("a client-limited step stops the search without a verdict", async () => {
  const result = await searchSustainedRate([5, 10, 20], async (rate) => step(rate, rate < 10, 0, rate === 10 ? 3 : 0));
  expect(result).toMatchObject({ sustained: 5, clientLimited: true });
  expect(result.steps.length).toBe(2);
});

test("the ladder must ascend", async () => {
  await expect(searchSustainedRate([5, 5], async (rate) => step(rate, true))).rejects.toThrow();
});

test("rates round sensibly", () => {
  expect(roundRate(7.25)).toBe(7.3);
  expect(roundRate(37.5)).toBe(38);
});

test("low rates get a longer step so the window expects enough arrivals", () => {
  expect(stepWindow(10, 50_000, 10_000)).toEqual({ stepMs: 60_000, measuredMs: 50_000 });
  const slow = stepWindow(0.5, 50_000, 10_000);
  expect(slow.measuredMs).toBe(80_000);
  expect(slow.stepMs).toBe(90_000);
  expect((slow.measuredMs / 1000) * 0.5).toBe(MIN_EXPECTED_SAMPLES);
});

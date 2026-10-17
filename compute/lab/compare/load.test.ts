import { expect, test } from "bun:test";
import { type Clock, poissonArrivals, RestingSet, runOpenLoop, seededRandom, StarvedError } from "./load.ts";

test("the generator is reproducible and uniform enough", () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const values = Array.from({ length: 10_000 }, () => a());
  expect(values.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => b()));
  expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...values)).toBeLessThan(1);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  expect(Math.abs(mean - 0.5)).toBeLessThan(0.01);
});

test("Poisson arrivals have the offered rate and exponential gaps", () => {
  const rate = 50;
  const durationMs = 2_000_000;
  const arrivals = poissonArrivals(rate, durationMs, seededRandom(7));
  // Expected 100 000 arrivals; the standard deviation is about 316.
  expect(Math.abs(arrivals.length - (rate * durationMs) / 1000)).toBeLessThan(1500);
  const gaps = arrivals.slice(1).map((at, i) => at - arrivals[i]);
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  expect(Math.abs(mean - 20)).toBeLessThan(0.3);
  // For an exponential distribution the standard deviation equals the mean,
  // and e^-1 of the gaps are longer than the mean.
  const sd = Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length);
  expect(Math.abs(sd / mean - 1)).toBeLessThan(0.02);
  const longer = gaps.filter((gap) => gap > mean).length / gaps.length;
  expect(Math.abs(longer - Math.exp(-1))).toBeLessThan(0.01);
  // Sorted, inside the window.
  expect(arrivals.every((at, i) => at < durationMs && (i === 0 || at >= arrivals[i - 1]))).toBe(true);
});

test("a rate must be positive", () => {
  expect(() => poissonArrivals(0, 1000, seededRandom(1))).toThrow();
});

/** A clock that only moves when the runner sleeps. */
function fakeClock(): Clock & { at: number } {
  return {
    at: 1000,
    now() {
      return this.at;
    },
    async sleepUntil(at) {
      this.at = Math.max(this.at, at);
    },
  };
}

test("the open loop sends on schedule however slow the system is, and times from the schedule", async () => {
  const clock = fakeClock();
  const sentAt: number[] = [];
  const outcomes = await runOpenLoop(
    [0, 10, 20],
    async (scheduledAt) => {
      sentAt.push(clock.now());
      // Every operation takes 500 ms; an open loop does not wait for it.
      return scheduledAt + 500;
    },
    clock,
  );
  expect(sentAt).toEqual([1000, 1010, 1020]);
  expect(outcomes.map((outcome) => outcome.latencyMs)).toEqual([500, 500, 500]);
  expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
});

test("a late send counts its lateness in the latency", async () => {
  const clock = fakeClock();
  const outcomes = await runOpenLoop(
    [0, 5],
    async (scheduledAt) => {
      // The client stalls for 100 ms while sending the first one.
      if (scheduledAt === 1000) clock.at += 100;
      return clock.now() + 10;
    },
    clock,
  );
  expect(outcomes[0].latencyMs).toBe(110);
  expect(outcomes[1].lagMs).toBe(95);
  expect(outcomes[1].latencyMs).toBe(105);
});

test("failures and starvation are told apart", async () => {
  const clock = fakeClock();
  const outcomes = await runOpenLoop(
    [0, 1],
    async (scheduledAt) => {
      if (scheduledAt === 1000) throw new Error("boom");
      throw new StarvedError();
    },
    clock,
  );
  expect(outcomes[0]).toMatchObject({ ok: false, error: "boom", starved: false });
  expect(outcomes[1]).toMatchObject({ ok: false, starved: true });
});

test("a resting set never hands out a sandbox twice", () => {
  const set = new RestingSet(["a", "b", "c"], seededRandom(3));
  const taken = [set.take(), set.take(), set.take()];
  expect(new Set(taken).size).toBe(3);
  expect(() => set.take()).toThrow(StarvedError);
  set.give("b");
  expect(set.take()).toBe("b");
});

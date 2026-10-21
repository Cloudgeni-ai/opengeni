import { describe, expect, test } from "bun:test";
import { calibration, replay, type Arrival, type ReplayInput } from "./queue-replay";
const arrivals = (n: number): Arrival[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(3, "0"), at: 0, kind: "good" }));
const base: ReplayInput = {
  mode: "native",
  capacity: 2,
  arrivals: arrivals(6),
  samples: [{ duration: 10, conclusion: "success", runnerMinutes: 30 }],
  trace: true,
};
describe("deterministic failure-aware queue replay", () => {
  test("capacity bounds and native C/T rather than merge batch multiplier", () => {
    for (const c of [1, 6, 8, 12, 16]) {
      const r = replay({ ...base, capacity: c, arrivals: arrivals(2 * c) });
      expect(r.maxActive).toBe(c);
      expect(r.makespan).toBe(20);
      expect(r.builds).toBe(2 * c);
      expect(r.runnerMinutes).toBe(60 * c);
    }
  });
  test("invalidates and restarts every successor, including already green successors", () => {
    const r = replay({
      ...base,
      capacity: 3,
      arrivals: [
        { id: "a", at: 0, kind: "flaky" },
        { id: "b", at: 0, kind: "good" },
        { id: "c", at: 0, kind: "good" },
      ],
      samples: [
        { duration: 5, conclusion: "success" },
        { duration: 10, conclusion: "failure" },
      ],
    });
    expect(r.invalidations).toBe(2);
    expect(r.builds).toBe(6);
    expect(r.retries).toBe(1);
    expect(r.removed).toBe(0);
    expect(r.makespan).toBe(15);
    expect(r.events!.filter((e) => e.event === "start" && e.ids[0] === "c")).toHaveLength(2);
  });
  test("permanent entry gets one retry then removal; running successors' partial work counts", () => {
    const r = replay({
      ...base,
      arrivals: [
        { id: "a", at: 0, kind: "permanent" },
        { id: "b", at: 0, kind: "good" },
      ],
      samples: [
        { duration: 10, conclusion: "success" },
        { duration: 2, conclusion: "failure" },
      ],
    });
    expect(r.retries).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.merged).toBe(1);
    expect(r.invalidations).toBe(2);
    expect(r.ciMinutes).toBe(18);
    expect(r.makespan).toBe(14);
  });
  test("true batch tests one tip for all ready PRs, arrivals during CI join next candidate", () => {
    const r = replay({
      ...base,
      mode: "batch",
      arrivals: [...arrivals(5), { id: "later", at: 1, kind: "good" }],
    });
    expect(r.builds).toBe(2);
    expect(r.merged).toBe(6);
    expect(r.makespan).toBe(20);
    expect(r.outcomes.at(-1)!.wait).toBe(9);
  });
  test("batch bisects permanent failure without removing good members", () => {
    const r = replay({
      ...base,
      mode: "batch",
      arrivals: [
        { id: "a", at: 0, kind: "permanent" },
        { id: "b", at: 0, kind: "good" },
      ],
    });
    expect(r.builds).toBe(5);
    expect(r.removed).toBe(1);
    expect(r.merged).toBe(1);
    expect(r.events!.some((e) => e.event === "bisect")).toBe(true);
  });
  test("one flaky batch retry avoids unnecessary bisection", () => {
    const r = replay({
      ...base,
      mode: "batch",
      arrivals: [{ id: "a", at: 0, kind: "flaky" }, ...arrivals(4)],
    });
    expect(r.builds).toBe(2);
    expect(r.retries).toBe(1);
    expect(r.merged).toBe(5);
    expect(r.events!.some((e) => e.event === "bisect")).toBe(false);
  });
  test("cancelled/skipped/incomplete are excluded, never red or duration evidence", () => {
    const samples = [
      ...base.samples,
      { duration: 999, conclusion: "cancelled" },
      { duration: 2, conclusion: "skipped" },
      { duration: 0, conclusion: "failure" },
      { duration: 3, conclusion: "timed_out" },
    ];
    expect(calibration(samples).failureFraction).toBe(0.5);
    expect(calibration(samples).excluded).toBe(3);
    expect(replay({ ...base, samples }).ciMinutes).toBe(60);
  });
  test("seed reproducibility and conservation", () => {
    const input = {
      ...base,
      arrivals: arrivals(40).map(({ kind: _, ...a }) => a),
      permanentProbability: 0.1,
      flakyProbability: 0.2,
    };
    const a = replay(input),
      b = replay(input);
    expect(a).toEqual(b);
    expect(a.merged + a.removed).toBe(40);
    expect(a.maxActive).toBeLessThanOrEqual(2);
  });
  test("empty arrivals and invalid inputs", () => {
    expect(replay({ ...base, arrivals: [] }).builds).toBe(0);
    expect(() => replay({ ...base, capacity: 0 })).toThrow();
    expect(() => replay({ ...base, flakyProbability: 2 })).toThrow();
    expect(() =>
      replay({ ...base, samples: [{ duration: 1, conclusion: "cancelled" }] }),
    ).toThrow();
  });
});

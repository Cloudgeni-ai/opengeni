/** Deterministic, provider-free queue replay. Run: bun scripts/ci/queue-replay.ts input.json
 * Times are minutes relative to a common origin. Arrivals must be explicitly labelled
 * by the caller (creation/ready-for-review are NOT verified merge readiness).
 * Native models a C-entry speculative window, in-order landing, immediate successor
 * invalidation on any red result, and one retry per entry before removal. Passed but
 * blocked entries occupy the window. Detection is attributed to the failing entry;
 * correlated failures, Git conflicts, runner scheduling and coordination are not inferred.
 * Batch serially drains all ready arrivals, tests the combined tip, retries a red
 * candidate once, then bisects sequentially on the updated base. New arrivals wait
 * until bisection finishes. This is a model, not a vendor implementation guarantee.
 * Failure types are seeded per entry, not inferred from cancellations or paired to
 * historical PRs. Durations/work are sampled together, conditional on red/green.
 * runnerMinutes defaults to duration (one runner); callers must supply job sums for
 * fanout. Wait is arrival -> FIRST build; completion includes restarts and head-of-line
 * blocking. Wait/completion quantiles are for merged entries, resolution for all.
 * Cancelled speculative work is charged in proportion to elapsed build time; this
 * approximation is not a replay of individual job-level runner allocation.
 */
export type Arrival = { id: string; at: number; kind?: "good" | "flaky" | "permanent" };
export type Sample = { duration: number; conclusion: string; runnerMinutes?: number };
export type ReplayInput = {
  arrivals: Arrival[];
  samples: Sample[];
  mode: "native" | "batch";
  capacity?: number;
  seed?: number;
  permanentProbability?: number;
  flakyProbability?: number;
  durationScale?: number;
  trace?: boolean;
};
export function calibration(samples: Sample[]) {
  const success = samples.filter(
    (s) => s.conclusion === "success" && s.duration > 0 && Number.isFinite(s.duration),
  );
  const failure = samples.filter(
    (s) =>
      ["failure", "timed_out"].includes(s.conclusion) &&
      s.duration > 0 &&
      Number.isFinite(s.duration),
  );
  return {
    success,
    failure,
    excluded: samples.length - success.length - failure.length,
    failureFraction: failure.length / (success.length + failure.length || 1),
  };
}
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function quantile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}
export function replay(input: ReplayInput) {
  const cap = input.mode === "batch" ? 1 : (input.capacity ?? 6);
  const permanent = input.permanentProbability ?? 0,
    flaky = input.flakyProbability ?? 0;
  const scale = input.durationScale ?? 1;
  if (
    !Number.isInteger(cap) ||
    cap < 1 ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Number.isFinite(permanent + flaky) ||
    permanent < 0 ||
    flaky < 0 ||
    permanent + flaky > 1
  )
    throw new Error("Invalid capacity, duration scale or probabilities");
  if (!["native", "batch"].includes(input.mode)) throw new Error("Unknown mode");
  if (
    input.arrivals.some((a) => !Number.isFinite(a.at)) ||
    new Set(input.arrivals.map((a) => a.id)).size !== input.arrivals.length
  )
    throw new Error("Arrivals need finite times and unique IDs");
  const dist = calibration(input.samples);
  if (!dist.success.length)
    throw new Error("At least one successful duration is needed; cancellations are not failures");
  const rng = random(input.seed ?? 834);
  type Entry = Arrival & {
    kind: "good" | "flaky" | "permanent";
    reds: number;
    firstStart?: number;
    start?: number;
    end?: number;
    sample?: Sample;
    red?: boolean;
    passed?: boolean;
  };
  const queue: Entry[] = [...input.arrivals]
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((a) => {
      const draw = rng();
      return {
        ...a,
        kind:
          a.kind ?? (draw < permanent ? "permanent" : draw < permanent + flaky ? "flaky" : "good"),
        reds: 0,
      };
    });
  const outcomes: {
    id: string;
    result: "merged" | "removed";
    at: number;
    wait: number;
    completion: number;
  }[] = [];
  const events: { at: number; event: string; ids: string[] }[] = [];
  let now = queue[0]?.at ?? 0,
    next = 0,
    builds = 0,
    redBuilds = 0,
    retries = 0,
    invalidations = 0;
  let ciMinutes = 0,
    runnerMinutes = 0,
    maxActive = 0;
  const log = (event: string, entries: Entry[]) => {
    if (input.trace) events.push({ at: now, event, ids: entries.map((e) => e.id) });
  };
  const drawSample = (red: boolean) => {
    const pool = red && dist.failure.length ? dist.failure : dist.success;
    const sample = pool[Math.floor(rng() * pool.length)]!;
    return {
      ...sample,
      duration: sample.duration * scale,
      runnerMinutes: (sample.runnerMinutes ?? sample.duration) * scale,
    };
  };
  const bad = (e: Entry) => e.kind === "permanent" || (e.kind === "flaky" && e.reds === 0);
  const finish = (e: Entry, result: "merged" | "removed") => {
    outcomes.push({
      id: e.id,
      result,
      at: now,
      wait: (e.firstStart ?? now) - e.at,
      completion: now - e.at,
    });
    log(result, [e]);
  };
  const charge = (sample: Sample, elapsed = sample.duration) => {
    ciMinutes += elapsed;
    runnerMinutes += ((sample.runnerMinutes ?? sample.duration) * elapsed) / sample.duration;
  };
  if (input.mode === "batch") {
    const ready: Entry[] = [];
    const admit = () => {
      while (next < queue.length && queue[next]!.at <= now) ready.push(queue[next++]!);
    };
    const testBatch = (batch: Entry[]): boolean => {
      const failures = batch.filter(bad);
      const sample = drawSample(failures.length > 0);
      for (const e of batch) e.firstStart ??= now;
      builds++;
      maxActive = 1;
      log("start", batch);
      now += sample.duration;
      charge(sample);
      if (failures.length) {
        redBuilds++;
        for (const e of failures) e.reds++;
        log("red", batch);
        return false;
      }
      log("green", batch);
      return true;
    };
    const process = (batch: Entry[]) => {
      let passed = testBatch(batch);
      if (!passed) {
        retries++;
        log("retry", batch);
        passed = testBatch(batch);
      }
      if (passed) {
        for (const e of batch) finish(e, "merged");
        return;
      }
      if (batch.length === 1) {
        finish(batch[0]!, "removed");
        return;
      }
      log("bisect", batch);
      const split = Math.ceil(batch.length / 2);
      process(batch.slice(0, split));
      process(batch.slice(split));
    };
    while (next < queue.length || ready.length) {
      if (!ready.length && next < queue.length) now = Math.max(now, queue[next]!.at);
      admit();
      process(ready.splice(0));
      admit();
    }
  } else {
    const stack: Entry[] = [];
    const launch = (e: Entry) => {
      e.firstStart ??= now;
      e.start = now;
      e.red = bad(e);
      e.sample = drawSample(e.red);
      e.end = now + e.sample.duration;
      e.passed = false;
      builds++;
      log("start", [e]);
    };
    while (next < queue.length || stack.length) {
      while (stack[0]?.passed) finish(stack.shift()!, "merged");
      while (stack.length < cap && next < queue.length && queue[next]!.at <= now) {
        const e = queue[next++]!;
        stack.push(e);
        launch(e);
      }
      maxActive = Math.max(maxActive, stack.filter((e) => e.end !== undefined).length);
      const end = Math.min(...stack.map((e) => e.end ?? Infinity));
      const arrival = stack.length < cap && next < queue.length ? queue[next]!.at : Infinity;
      if (!Number.isFinite(Math.min(end, arrival))) break;
      now = Math.min(end, arrival);
      // Process ties from the front: an ancestor's failure cancels even same-time descendants.
      const index = stack.findIndex((e) => e.end === now);
      if (index < 0) continue;
      const e = stack[index]!;
      charge(e.sample!);
      e.end = undefined;
      if (!e.red) {
        e.passed = true;
        log("green", [e]);
        continue;
      }
      redBuilds++;
      e.reds++;
      log("red", [e]);
      const successors = stack.slice(index + 1);
      invalidations += successors.length;
      log("invalidate", successors);
      for (const s of successors) {
        if (s.end !== undefined) charge(s.sample!, now - s.start!);
        s.end = undefined;
        s.passed = false;
      }
      if (e.reds <= 1) {
        retries++;
        log("retry", [e]);
        launch(e);
      } else {
        stack.splice(index, 1);
        finish(e, "removed");
      }
      for (const s of successors) launch(s);
    }
  }
  const merged = outcomes.filter((o) => o.result === "merged"),
    removed = outcomes.length - merged.length;
  const waits = merged.map((o) => o.wait),
    completions = merged.map((o) => o.completion);
  return {
    mode: input.mode,
    capacity: cap,
    arrivals: queue.length,
    merged: merged.length,
    removed,
    builds,
    redBuilds,
    retries,
    invalidations,
    ciMinutes,
    runnerMinutes,
    maxActive,
    excludedSamples: dist.excluded,
    medianWait: quantile(waits, 0.5),
    p95Wait: quantile(waits, 0.95),
    medianCompletion: quantile(completions, 0.5),
    p95Completion: quantile(completions, 0.95),
    medianResolution: quantile(
      outcomes.map((o) => o.completion),
      0.5,
    ),
    p95Resolution: quantile(
      outcomes.map((o) => o.completion),
      0.95,
    ),
    makespan: now - (queue[0]?.at ?? 0),
    outcomes,
    ...(input.trace ? { events } : {}),
  };
}
if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: bun scripts/ci/queue-replay.ts input.json");
  console.log(JSON.stringify(replay(await Bun.file(path).json()), null, 2));
}

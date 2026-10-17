/**
 * Open-loop load: Poisson arrivals fixed before a step starts, each sent at
 * its time whatever earlier ones are doing, and timed from that scheduled
 * time so a client that falls behind cannot hide queueing.
 */

/** A small seeded generator (mulberry32), so schedules are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Arrival offsets in milliseconds for a Poisson process of `ratePerSecond`
 * over `durationMs`: exponential gaps with mean 1000 / rate.
 */
export function poissonArrivals(ratePerSecond: number, durationMs: number, random: () => number): number[] {
  if (!(ratePerSecond > 0)) throw new Error(`rate must be positive: ${ratePerSecond}`);
  const meanGapMs = 1000 / ratePerSecond;
  const arrivals: number[] = [];
  let at = 0;
  for (;;) {
    // 1 - random() is in (0, 1], so the logarithm is finite.
    at += -Math.log(1 - random()) * meanGapMs;
    if (at >= durationMs) return arrivals;
    arrivals.push(at);
  }
}

/** What one arrival did. Times are from its scheduled time. */
export interface Outcome {
  /** Scheduled offset from the step's start. */
  at: number;
  ok: boolean;
  /** Until the first byte of output, or until the failure. */
  latencyMs: number;
  /** How late the client sent it; included in `latencyMs`. */
  lagMs: number;
  error?: string;
  /** No resting sandbox was free: the client's limit, not the system's. */
  starved?: boolean;
}

export interface Clock {
  now(): number;
  sleepUntil(at: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleepUntil: async (at) => {
    const wait = at - performance.now();
    if (wait > 1) await Bun.sleep(wait);
  },
};

/** No resting sandbox was free for an arrival. */
export class StarvedError extends Error {
  constructor() {
    super("no resting sandbox was free");
  }
}

/**
 * Sends `operation` at each arrival and gathers the outcomes. `operation`
 * gets the scheduled time (on `clock`) and returns the time its first byte
 * of output arrived, or throws. Returns once every operation settled.
 */
export async function runOpenLoop(
  arrivals: readonly number[],
  operation: (scheduledAt: number) => Promise<number>,
  clock: Clock = realClock,
): Promise<Outcome[]> {
  const start = clock.now();
  const pending: Promise<Outcome>[] = [];
  for (const offset of arrivals) {
    const scheduledAt = start + offset;
    await clock.sleepUntil(scheduledAt);
    const lagMs = Math.max(0, clock.now() - scheduledAt);
    // Started now, synchronously up to its first await; a synchronous throw
    // becomes a rejection.
    const started = (async () => operation(scheduledAt))();
    pending.push(
      started.then(
        (firstByteAt): Outcome => ({ at: offset, ok: true, latencyMs: firstByteAt - scheduledAt, lagMs }),
        (error: unknown): Outcome => ({
          at: offset,
          ok: false,
          latencyMs: clock.now() - scheduledAt,
          lagMs,
          error: error instanceof Error ? error.message : String(error),
          starved: error instanceof StarvedError,
        }),
      ),
    );
  }
  return Promise.all(pending);
}

/**
 * Hands out resting sandboxes at random, and takes them back once they rest
 * again, so no sandbox is used twice at once.
 */
export class RestingSet<T> {
  private readonly resting: T[];

  constructor(
    items: readonly T[],
    private readonly random: () => number,
  ) {
    this.resting = [...items];
  }

  get size(): number {
    return this.resting.length;
  }

  take(): T {
    if (this.resting.length === 0) throw new StarvedError();
    const index = Math.floor(this.random() * this.resting.length);
    const [item] = this.resting.splice(index, 1);
    return item;
  }

  give(item: T): void {
    this.resting.push(item);
  }
}

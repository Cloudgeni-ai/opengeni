/**
 * Small in-memory sliding-window and concurrency limits for the public demo.
 * They assume the single replica the demo runs as; a multi-replica product
 * would use shared storage (or its gateway) instead.
 */

const MAX_TRACKED_KEYS = 10_000;

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
  /** Shown to the browser when this limit refuses, followed by when to retry. */
  message: string;
  now?: () => number;
};

export class RateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly message: string;
  readonly #now: () => number;
  readonly #hits = new Map<string, number[]>();

  constructor(options: RateLimitOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.message = options.message;
    this.#now = options.now ?? Date.now;
  }

  /** Seconds until `key` may act again, or 0 when it may act now. */
  retryAfterSeconds(key: string): number {
    const hits = this.#recent(key);
    if (hits.length < this.limit) return 0;
    return Math.max(1, Math.ceil((hits[0]! + this.windowMs - this.#now()) / 1_000));
  }

  record(key: string): void {
    const hits = this.#recent(key);
    hits.push(this.#now());
    // Re-insert so the Map's order runs from least to most recently active.
    this.#hits.delete(key);
    this.#hits.set(key, hits);
    // Anonymous visitors are unbounded, so forget the least recently active.
    while (this.#hits.size > MAX_TRACKED_KEYS) {
      this.#hits.delete(this.#hits.keys().next().value!);
    }
  }

  #recent(key: string): number[] {
    const cutoff = this.#now() - this.windowMs;
    return (this.#hits.get(key) ?? []).filter((at) => at > cutoff);
  }
}

export type RateLimitRefusal = { limiter: RateLimiter; retryAfterSeconds: number };

/** Count one action against every limit, or against none when any of them refuses. */
export function consumeRateLimits(
  checks: ReadonlyArray<readonly [RateLimiter, string]>,
): RateLimitRefusal | null {
  for (const [limiter, key] of checks) {
    const retryAfterSeconds = limiter.retryAfterSeconds(key);
    if (retryAfterSeconds > 0) return { limiter, retryAfterSeconds };
  }
  for (const [limiter, key] of checks) limiter.record(key);
  return null;
}

export type RateBounds = { limit: number; windowMs: number };

/**
 * One action's limits: per visitor (browser cookie), per client network
 * address, and across the whole demo. A visitor can replace its cookie at
 * will, so the client and demo tiers are the real caps.
 */
export type TieredRateBounds = { visitor: RateBounds; client: RateBounds; demo: RateBounds };

export class TieredRateLimit {
  readonly #visitor: RateLimiter;
  readonly #client: RateLimiter;
  readonly #demo: RateLimiter;

  /** `action` names what is limited in refusals, for example "agent runs". */
  constructor(bounds: TieredRateBounds, action: string, now?: () => number) {
    const clock = now ? { now } : {};
    this.#visitor = new RateLimiter({
      ...bounds.visitor,
      message: `Too many ${action} from this browser`,
      ...clock,
    });
    this.#client = new RateLimiter({
      ...bounds.client,
      message: `Too many ${action} from this network`,
      ...clock,
    });
    this.#demo = new RateLimiter({
      ...bounds.demo,
      message: `The demo has had too many ${action} recently`,
      ...clock,
    });
  }

  /** Count one action, or refuse it without counting. A null client address skips that tier. */
  consume(visitorId: string, clientAddress: string | null): RateLimitRefusal | null {
    const checks: Array<readonly [RateLimiter, string]> = [[this.#visitor, visitorId]];
    if (clientAddress !== null) checks.push([this.#client, clientAddress]);
    checks.push([this.#demo, "demo"]);
    return consumeRateLimits(checks);
  }
}

/** How many long-lived requests (event streams) may be open per visitor, client address, and demo. */
export type TieredConcurrencyBounds = { visitor: number; client: number; demo: number };

export type ConcurrencySlot = { release: () => void } | { refused: string };

export class TieredConcurrencyLimit {
  readonly #bounds: TieredConcurrencyBounds;
  readonly #action: string;
  // Only open requests are tracked, so these stay as small as the open set.
  readonly #open = {
    visitor: new Map<string, number>(),
    client: new Map<string, number>(),
    demo: new Map<string, number>(),
  };

  constructor(bounds: TieredConcurrencyBounds, action: string) {
    this.#bounds = bounds;
    this.#action = action;
  }

  /** Take one slot in every tier, or none when any tier is full. Release exactly once when done. */
  acquire(visitorId: string, clientAddress: string | null): ConcurrencySlot {
    const keys: Array<[keyof TieredConcurrencyBounds, string]> = [["visitor", visitorId]];
    if (clientAddress !== null) keys.push(["client", clientAddress]);
    keys.push(["demo", "demo"]);
    for (const [tier, key] of keys) {
      if ((this.#open[tier].get(key) ?? 0) >= this.#bounds[tier]) {
        const scope =
          tier === "visitor"
            ? "from this browser"
            : tier === "client"
              ? "from this network"
              : "across the demo";
        return { refused: `Too many open ${this.#action} ${scope}` };
      }
    }
    for (const [tier, key] of keys) {
      this.#open[tier].set(key, (this.#open[tier].get(key) ?? 0) + 1);
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        for (const [tier, key] of keys) {
          const remaining = (this.#open[tier].get(key) ?? 1) - 1;
          if (remaining > 0) this.#open[tier].set(key, remaining);
          else this.#open[tier].delete(key);
        }
      },
    };
  }
}

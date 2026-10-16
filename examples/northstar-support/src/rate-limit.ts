/**
 * Small in-memory sliding-window limits for the public demo. They assume the
 * single replica the demo runs as; a multi-replica product would use shared
 * storage (or its gateway) instead.
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

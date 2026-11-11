import { describe, expect, test } from "bun:test";
import { TokenBucket } from "../src/routes/enrollments";

describe("enrollment rate-limit token bucket", () => {
  test("tracks a bounded number of sources however many distinct ones arrive", () => {
    const limiter = new TokenBucket({ capacity: 10, refillPerSecond: 0.5 });
    for (let index = 0; index < 25_000; index++) {
      expect(limiter.take(`198.51.100.${index}`, 1_000_000)).toBe(true);
    }
    expect(limiter.size).toBeLessThanOrEqual(10_000);
  });

  test("a new source drops refilled buckets before a limited one", () => {
    const limiter = new TokenBucket({ capacity: 2, refillPerSecond: 1, maxKeys: 3 });
    expect(limiter.take("limited", 0)).toBe(true);
    expect(limiter.take("limited", 0)).toBe(true);
    expect(limiter.take("limited", 0)).toBe(false);
    expect(limiter.take("idle-a", 0)).toBe(true);
    expect(limiter.take("idle-b", 0)).toBe(true);
    // "limited" refills to 1.5 tokens by t=1.5s; drain it to 0.5 again.
    expect(limiter.take("limited", 1_500)).toBe(true);
    expect(limiter.take("limited", 1_500)).toBe(false);
    // At t=2s the idle buckets are full again, "limited" holds only 1 token.
    expect(limiter.take("new", 2_000)).toBe(true);
    expect(limiter.size).toBe(2);
    // Had it been forgotten it would start over with 2 tokens.
    expect(limiter.take("limited", 2_000)).toBe(true);
    expect(limiter.take("limited", 2_000)).toBe(false);
  });

  test("a source keeps its limit while the map is under its bound", () => {
    const limiter = new TokenBucket({ capacity: 1, refillPerSecond: 0.001 });
    expect(limiter.take("source", 0)).toBe(true);
    for (let index = 0; index < 100; index++) limiter.take(`other-${index}`, 10);
    expect(limiter.take("source", 20)).toBe(false);
  });
});

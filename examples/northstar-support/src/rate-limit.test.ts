import { describe, expect, test } from "bun:test";

import {
  RateLimiter,
  TieredConcurrencyLimit,
  TieredRateLimit,
  consumeRateLimits,
} from "./rate-limit";

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("RateLimiter", () => {
  test("allows the limit within a sliding window and reports when to retry", () => {
    const time = clock();
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, message: "Slow down", ...time });
    expect(consumeRateLimits([[limiter, "a"]])).toBeNull();
    time.advance(20_000);
    expect(consumeRateLimits([[limiter, "a"]])).toBeNull();
    expect(consumeRateLimits([[limiter, "a"]])).toEqual({ limiter, retryAfterSeconds: 40 });
    // Keys are independent.
    expect(consumeRateLimits([[limiter, "b"]])).toBeNull();
    // The first hit leaves the window; the second still counts.
    time.advance(40_000);
    expect(consumeRateLimits([[limiter, "a"]])).toBeNull();
    expect(consumeRateLimits([[limiter, "a"]])?.retryAfterSeconds).toBe(20);
  });

  test("counts an action against every limit or against none", () => {
    const time = clock();
    const perVisitor = new RateLimiter({ limit: 5, windowMs: 60_000, message: "visitor", ...time });
    const global = new RateLimiter({ limit: 1, windowMs: 60_000, message: "global", ...time });
    expect(
      consumeRateLimits([
        [perVisitor, "a"],
        [global, "all"],
      ]),
    ).toBeNull();
    const refusal = consumeRateLimits([
      [perVisitor, "a"],
      [global, "all"],
    ]);
    expect(refusal?.limiter).toBe(global);
    // The refused action did not use up the visitor's own allowance.
    expect(perVisitor.retryAfterSeconds("a")).toBe(0);
    for (let index = 0; index < 4; index += 1) perVisitor.record("a");
    expect(perVisitor.retryAfterSeconds("a")).toBe(60);
  });
});

describe("TieredRateLimit", () => {
  const bounds = {
    visitor: { limit: 2, windowMs: 60_000 },
    client: { limit: 3, windowMs: 60_000 },
    demo: { limit: 5, windowMs: 60_000 },
  };

  test("refuses at the first full tier and names it", () => {
    const time = clock();
    const runs = new TieredRateLimit(bounds, "runs", time.now);
    expect(runs.consume("a", "10.0.0.1")).toBeNull();
    expect(runs.consume("a", "10.0.0.1")).toBeNull();
    expect(runs.consume("a", "10.0.0.1")?.limiter.message).toBe("Too many runs from this browser");
    // A fresh cookie on the same address meets the client tier.
    expect(runs.consume("b", "10.0.0.1")).toBeNull();
    expect(runs.consume("c", "10.0.0.1")?.limiter.message).toBe("Too many runs from this network");
    // Another address meets the demo tier.
    expect(runs.consume("d", "10.0.0.2")).toBeNull();
    expect(runs.consume("e", "10.0.0.3")).toBeNull();
    expect(runs.consume("f", "10.0.0.4")?.limiter.message).toBe(
      "The demo has had too many runs recently",
    );
    time.advance(60_000);
    expect(runs.consume("f", "10.0.0.4")).toBeNull();
  });

  test("skips the client tier when the address is unknown", () => {
    const runs = new TieredRateLimit(bounds, "runs", clock().now);
    for (const visitor of ["a", "b", "c", "d", "e"]) {
      expect(runs.consume(visitor, null)).toBeNull();
    }
    expect(runs.consume("f", null)?.limiter.message).toBe(
      "The demo has had too many runs recently",
    );
  });
});

describe("TieredConcurrencyLimit", () => {
  test("holds a slot in every tier until it is released once", () => {
    const streams = new TieredConcurrencyLimit({ visitor: 2, client: 3, demo: 4 }, "streams");
    const take = (visitor: string, client: string | null) => {
      const slot = streams.acquire(visitor, client);
      if ("refused" in slot) throw new Error(slot.refused);
      return slot.release;
    };
    const first = take("a", "10.0.0.1");
    take("a", "10.0.0.1");
    expect(streams.acquire("a", "10.0.0.1")).toEqual({
      refused: "Too many open streams from this browser",
    });
    take("b", "10.0.0.1");
    expect(streams.acquire("c", "10.0.0.1")).toEqual({
      refused: "Too many open streams from this network",
    });
    take("d", null);
    expect(streams.acquire("e", null)).toEqual({
      refused: "Too many open streams across the demo",
    });
    // Releasing twice frees one slot, not two.
    first();
    first();
    take("e", null);
    expect(streams.acquire("f", null)).toEqual({
      refused: "Too many open streams across the demo",
    });
  });
});

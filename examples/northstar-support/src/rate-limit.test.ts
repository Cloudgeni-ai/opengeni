import { describe, expect, test } from "bun:test";

import { RateLimiter, consumeRateLimits } from "./rate-limit";

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

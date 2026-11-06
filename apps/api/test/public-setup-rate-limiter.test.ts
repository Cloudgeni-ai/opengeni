import { describe, expect, test } from "bun:test";

import { PublicSetupRateLimiter } from "../src/routes/managed-onboarding";

describe("PublicSetupRateLimiter", () => {
  test("a source its own bucket refuses does not drain the shared bucket", () => {
    let now = 0;
    // The share-link reader's limits: 600 shared tokens refilling 100/s, and
    // 60 per source refilling 1/s.
    const limiter = new PublicSetupRateLimiter({
      globalCapacity: 600,
      globalRefillPerSecond: 100,
      clientCapacity: 60,
      clientRefillPerSecond: 1,
      now: () => now,
    });
    let flooderAdmitted = 0;
    let victimAdmitted = 0;
    // One source sends 200 requests per second for 20 seconds while another
    // sends one per second, well within its own allowance.
    for (let step = 0; step < 4_000; step += 1) {
      now = step * 5;
      if (limiter.take("flooder")) flooderAdmitted += 1;
      if (step % 200 === 0 && limiter.take("victim")) victimAdmitted += 1;
    }
    expect(victimAdmitted).toBe(20);
    // The flooder gets its burst and its refill, nothing more.
    expect(flooderAdmitted).toBeLessThanOrEqual(60 + 20);
  });

  test("admits only when both buckets have a token and spends one from each", () => {
    let now = 0;
    const limiter = new PublicSetupRateLimiter({
      globalCapacity: 3,
      globalRefillPerSecond: 0,
      clientCapacity: 2,
      clientRefillPerSecond: 0,
      now: () => now,
    });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    // Refused by its own bucket: the shared token stays for others.
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
    // The shared bucket is empty now; b keeps its remaining client token.
    expect(limiter.take("b")).toBe(false);
    expect(limiter.take("c")).toBe(false);
  });

  test("refills both buckets over time and keeps the key map bounded", () => {
    let now = 0;
    const limiter = new PublicSetupRateLimiter({
      globalCapacity: 10,
      globalRefillPerSecond: 10,
      clientCapacity: 1,
      clientRefillPerSecond: 1,
      maxClientKeys: 2,
      now: () => now,
    });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("b")).toBe(true);
    // Both known clients are still spent, so a third key cannot be tracked.
    expect(limiter.take("c")).toBe(false);
    now = 1_000;
    // Idle buckets are pruned once refilled, making room for a new key.
    expect(limiter.take("c")).toBe(true);
    expect(limiter.take("c")).toBe(false);
    expect(limiter.take("a")).toBe(true);
  });
});

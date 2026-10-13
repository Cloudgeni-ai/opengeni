import { describe, expect, test } from "bun:test";

import {
  createAttemptProviderBudget,
  ONEPASSWORD_PLAN_LIMITS,
  OnePasswordQuota,
  PROVIDER_READS_PER_ATTEMPT,
} from "../src/budget";
import { VaultProviderError } from "../src/contract";

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof VaultProviderError ? error.code : "other";
  }
}

describe("attempt budget", () => {
  test("the 51st read in one attempt is provider_rate_limited", () => {
    const budget = createAttemptProviderBudget();
    for (let i = 0; i < PROVIDER_READS_PER_ATTEMPT; i += 1) budget.take(i % 2 ? "read" : "list");
    expect(budget.used).toBe(50);
    expect(codeOf(() => budget.take("read"))).toBe("provider_rate_limited");
    // Explicit writes are not part of the read budget.
    expect(codeOf(() => budget.take("write"))).toBeNull();
  });
});

describe("connection quota by plan tier", () => {
  test("FAMILY bursts a quarter of its 1,000/day account quota, then refills", () => {
    let now = 0;
    const quota = new OnePasswordQuota("family", () => now);
    for (let i = 0; i < 250; i += 1) quota.take("read");
    let error: VaultProviderError | null = null;
    try {
      quota.take("read");
    } catch (caught) {
      error = caught as VaultProviderError;
    }
    expect(error?.code).toBe("provider_rate_limited");
    expect(error?.retryAfterMs).toBeGreaterThan(0);
    now += error!.retryAfterMs!;
    expect(codeOf(() => quota.take("read"))).toBeNull();
  });

  test("writes also respect the hourly write limit", () => {
    const quota = new OnePasswordQuota("teams", () => 0);
    for (let i = 0; i < ONEPASSWORD_PLAN_LIMITS.teams.hourlyWrites; i += 1) quota.take("write");
    expect(codeOf(() => quota.take("write"))).toBe("provider_rate_limited");
    expect(codeOf(() => quota.take("read"))).toBeNull();
  });

  test("a real 429 closes the connection until retry-after, with zero further calls", () => {
    let now = 1_000;
    const quota = new OnePasswordQuota("business", () => now);
    quota.block(60_000);
    expect(quota.blockedUntil?.getTime()).toBe(61_000);
    expect(codeOf(() => quota.take("read"))).toBe("provider_rate_limited");
    now = 61_001;
    expect(codeOf(() => quota.take("read"))).toBeNull();
    expect(quota.blockedUntil).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import {
  buildCodexUsageWindowFromCache,
  CODEX_FIVE_HOUR_WINDOW_SECONDS,
  CODEX_WEEKLY_WINDOW_SECONDS,
  normalizeCodexUsage,
} from "../src/usage-normalize";

// The live /wham/usage shape (Investigation 1a): used_percent + reset timing per
// window, NO raw counts; reset_at is epoch SECONDS; windows identified by
// limit_window_seconds (18000 ⇒ 5h, 604800 ⇒ weekly); a 200 may carry limit_reached.
function liveBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 40, reset_after_seconds: 3600, reset_at: 1_700_000_000, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 12, reset_after_seconds: 200_000, reset_at: 1_700_600_000, limit_window_seconds: 604800 },
    },
    ...over,
  };
}

describe("normalizeCodexUsage", () => {
  test("a 200 with both windows synthesizes used/limit/remaining/percent off used_percent", () => {
    const out = normalizeCodexUsage(200, liveBody());
    expect(out.status).toBe("ok");
    expect(out.planType).toBe("pro");
    expect(out.limitReached).toBe(false);
    expect(out.fiveHour).toEqual({
      used: 40,
      limit: 100,
      remaining: 60,
      percent: 40,
      resetAt: new Date(1_700_000_000 * 1000).toISOString(),
      resetAfterSeconds: 3600,
      limitWindowSeconds: 18000,
    });
    expect(out.weekly?.remaining).toBe(88);
    expect(out.weekly?.limitWindowSeconds).toBe(604800);
  });

  test("windows are mapped by limit_window_seconds, NOT by position", () => {
    // primary carries the WEEKLY seconds and secondary the 5h seconds — swapped.
    const body = liveBody({
      rate_limit: {
        primary_window: { used_percent: 5, reset_at: 1_700_600_000, limit_window_seconds: 604800 },
        secondary_window: { used_percent: 70, reset_at: 1_700_000_000, limit_window_seconds: 18000 },
      },
    });
    const out = normalizeCodexUsage(200, body);
    expect(out.fiveHour?.percent).toBe(70); // the 18000 window, regardless of position
    expect(out.weekly?.percent).toBe(5); // the 604800 window
  });

  test("positional fallback places windows whose limit_window_seconds is absent (primary=>5h, secondary=>weekly)", () => {
    // No limit_window_seconds on either window — must fall back to position.
    const body = liveBody({
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 33, reset_at: 1_700_000_000 },
        secondary_window: { used_percent: 9, reset_at: 1_700_600_000 },
      },
    });
    const out = normalizeCodexUsage(200, body);
    expect(out.fiveHour?.percent).toBe(33); // primary => 5h
    expect(out.weekly?.percent).toBe(9); // secondary => weekly
  });

  test("a 200 carrying limit_reached:true is a limit_reached state (not assumed 404-only)", () => {
    const out = normalizeCodexUsage(200, liveBody({ rate_limit: { ...((liveBody().rate_limit) as object), limit_reached: true } }));
    expect(out.status).toBe("limit_reached");
    expect(out.limitReached).toBe(true);
  });

  test("a 404 with a body normalizes to limit_reached", () => {
    const out = normalizeCodexUsage(404, liveBody({ rate_limit: { ...(liveBody().rate_limit as object), allowed: false } }));
    expect(out.status).toBe("limit_reached");
    expect(out.limitReached).toBe(true);
  });

  test("a non-404 HTTP error (401/500) is an error state", () => {
    expect(normalizeCodexUsage(401, null).status).toBe("error");
    expect(normalizeCodexUsage(500, null).status).toBe("error");
  });

  test("a successful call with no windows is no-data", () => {
    const out = normalizeCodexUsage(200, { plan_type: "plus", rate_limit: {} });
    expect(out.status).toBe("no-data");
    expect(out.fiveHour).toBeNull();
    expect(out.weekly).toBeNull();
  });

  test("percent >= 100 forces limit_reached even when the flags are absent", () => {
    const out = normalizeCodexUsage(200, {
      rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } },
    });
    expect(out.status).toBe("limit_reached");
    expect(out.fiveHour?.remaining).toBe(0);
  });

  test("forward-compat: additionalLimits + credits are carried but unused", () => {
    const out = normalizeCodexUsage(200, liveBody({
      additional_limits: [{ limit_name: "spark", metered_feature: "codex_bengalfox", primary_window: { used_percent: 3, limit_window_seconds: 18000 }, secondary_window: null }],
      credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: 12.5 },
    }));
    expect(out.additionalLimits?.[0]?.limitName).toBe("spark");
    expect(out.additionalLimits?.[0]?.fiveHour?.percent).toBe(3);
    expect(out.credits).toEqual({ hasCredits: true, unlimited: false, overageLimitReached: false, balance: "12.5" });
  });
});

describe("buildCodexUsageWindowFromCache", () => {
  test("synthesizes a window from the persisted used_percent + reset timestamp", () => {
    const resetAt = new Date(Date.now() + 2 * 3600 * 1000);
    const w = buildCodexUsageWindowFromCache(25, resetAt, CODEX_FIVE_HOUR_WINDOW_SECONDS);
    expect(w).not.toBeNull();
    expect(w!.percent).toBe(25);
    expect(w!.remaining).toBe(75);
    expect(w!.limitWindowSeconds).toBe(CODEX_FIVE_HOUR_WINDOW_SECONDS);
    expect(w!.resetAt).toBe(resetAt.toISOString());
    // resetAfterSeconds derived from resetAt − now (skew-free), ~2h.
    expect(w!.resetAfterSeconds).toBeGreaterThan(7000);
    expect(w!.resetAfterSeconds).toBeLessThanOrEqual(7200);
  });

  test("null used_percent ⇒ null window (no cached usage yet)", () => {
    expect(buildCodexUsageWindowFromCache(null, null, CODEX_WEEKLY_WINDOW_SECONDS)).toBeNull();
  });
});

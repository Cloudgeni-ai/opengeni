// Claude's limit reset grants, limit list and service state, decoded from
// usage bodies and response headers captured live (fixtures/claude-usage-live.ts).
import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CLI_SURFACE_USER_AGENT,
  claudeLimitResetGrantKind,
  claudeServiceStateInGrace,
  parseClaudeLimitResetClaim,
  parseClaudeLimitResets,
  parseClaudeServiceState,
  parseClaudeUsageHeaders,
  parseClaudeUsageResponse,
  parseClaudeWallReset,
} from "../src/claude-subscription-usage";
import {
  CLAUDE_HEADERS_FIVE_HOUR_ALLOWED,
  CLAUDE_HEADERS_OUT_OF_CREDITS,
  CLAUDE_HEADERS_WEEKLY_REJECTED,
  CLAUDE_HEADERS_WEEKLY_WARNING,
  CLAUDE_RESET_STATUS_OTHER_SURFACE,
  CLAUDE_USAGE_AT_WALL_PROGRAM,
  CLAUDE_USAGE_AT_WEEKLY_LIMIT,
  CLAUDE_USAGE_FULL_GRANT,
  CLAUDE_USAGE_THREE_FABLE_GRANTS,
} from "./fixtures/claude-usage-live";

const now = new Date("2026-11-11T08:20:00.000Z");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test("usage reads present Claude Code's CLI surface", () => {
  expect(CLAUDE_CLI_SURFACE_USER_AGENT).toBe("claude-cli/2.1.322 (external, cli)");
});

describe("reset grants from the usage body", () => {
  test("an account at its weekly limit: the weekly grant is usable, the Fable grant is blocked", () => {
    const observation = parseClaudeUsageResponse(CLAUDE_USAGE_AT_WEEKLY_LIMIT, now);
    const resets = observation?.details?.limitResets;
    expect(resets).toMatchObject({
      eligible: true,
      ineligibleReason: null,
      atLimit: true,
      exhausted: ["seven_day"],
      nextGrantId: "full-reset-2611",
      weeklyResetsAt: "2026-11-13T01:00:00.000Z",
      cooldownUntil: null,
      observedAt: now.toISOString(),
    });
    expect(resets?.grants).toEqual([
      {
        id: "full-reset-2611",
        label: "One full limit reset (November 2026)",
        type: "weekly",
        kind: "weekly",
        resetsTotal: 1,
        resetsLeft: 1,
        startsAt: "2026-11-10T21:30:00.000Z",
        endsAt: "2026-12-10T22:00:00.000Z",
        clears: ["seven_day", "seven_day_overage_included"],
        paused: false,
        usableNow: true,
        useRequiresLimit: false,
        givesBackWeekly: false,
        percentUsed: { seven_day: 100, seven_day_overage_included: 0 },
        blocking: [],
        unavailableReason: null,
      },
      {
        id: "launch-2610-fable",
        label: "New model launch: one Fable reset for Max, Team Premium and Enterprise Premium",
        type: "full",
        kind: "fable",
        resetsTotal: 1,
        resetsLeft: 1,
        startsAt: "2026-11-09T18:00:00.000Z",
        endsAt: "2027-03-09T07:59:00.000Z",
        clears: ["seven_day_overage_included"],
        paused: false,
        usableNow: false,
        useRequiresLimit: false,
        givesBackWeekly: true,
        percentUsed: { seven_day_overage_included: 0 },
        blocking: ["seven_day"],
        unavailableReason: "blocked_seven_day",
      },
    ]);
  });

  test("a full grant clears the five-hour limit too; tenure Fable grants are all listed", () => {
    const full = parseClaudeUsageResponse(CLAUDE_USAGE_FULL_GRANT, now)?.details?.limitResets;
    expect(full?.grants[0]).toMatchObject({
      id: "full-reset-2611",
      kind: "full",
      clears: ["five_hour", "seven_day", "seven_day_overage_included"],
    });
    const three = parseClaudeUsageResponse(CLAUDE_USAGE_THREE_FABLE_GRANTS, now)?.details
      ?.limitResets;
    expect(three?.grants.map((grant) => [grant.id, grant.kind, grant.usableNow])).toEqual([
      ["full-reset-2611", "weekly", true],
      ["launch-2610-fable", "fable", true],
      ["launch-2610-fable-12mo", "fable", true],
      ["launch-2610-fable-6mo", "fable", true],
    ]);
  });

  test("another surface is ineligible and lists no grants", () => {
    expect(parseClaudeLimitResets(CLAUDE_RESET_STATUS_OTHER_SURFACE, now)).toEqual({
      eligible: false,
      ineligibleReason: "surface",
      atLimit: false,
      exhausted: [],
      grants: [],
      nextGrantId: null,
      weeklyResetsAt: null,
      cooldownUntil: null,
      observedAt: now.toISOString(),
    });
  });

  test("a malformed grant is dropped; a malformed block is no reading; an absent one is undefined", () => {
    const body = clone(CLAUDE_USAGE_AT_WEEKLY_LIMIT.cedar_ember) as Record<string, unknown>;
    (body.grants as Record<string, unknown>[])[1]!.id = "Not A Grant Id!";
    const resets = parseClaudeLimitResets(body, now);
    expect(resets?.grants.map((grant) => grant.id)).toEqual(["full-reset-2611"]);
    expect(parseClaudeLimitResets({ eligible: "yes" }, now)).toBeNull();
    expect(parseClaudeLimitResets(undefined, now)).toBeUndefined();
    // A next grant the list does not hold is not reported.
    expect(parseClaudeLimitResets({ ...body, next_grant_id: "gone" }, now)?.nextGrantId).toBeNull();
  });

  test("a grant without use_requires_limit is used at a limit (Claude Code's default)", () => {
    const body = clone(CLAUDE_USAGE_AT_WEEKLY_LIMIT.cedar_ember) as Record<string, unknown>;
    delete (body.grants as Record<string, unknown>[])[0]!.use_requires_limit;
    expect(parseClaudeLimitResets(body, now)?.grants[0]?.useRequiresLimit).toBe(true);
  });

  test("the kind follows Claude Code: gives back weekly, else the type, else what it clears", () => {
    expect(claudeLimitResetGrantKind({ type: "full", clears: [], givesBackWeekly: true })).toBe(
      "fable",
    );
    expect(claudeLimitResetGrantKind({ type: "session", clears: [], givesBackWeekly: false })).toBe(
      "session",
    );
    expect(
      claudeLimitResetGrantKind({ type: null, clears: ["five_hour"], givesBackWeekly: false }),
    ).toBe("session");
    expect(
      claudeLimitResetGrantKind({
        type: null,
        clears: ["five_hour", "seven_day"],
        givesBackWeekly: false,
      }),
    ).toBe("full");
    expect(
      claudeLimitResetGrantKind({ type: "other", clears: ["seven_day"], givesBackWeekly: false }),
    ).toBe("weekly");
  });

  test("the at-the-limit program", () => {
    expect(parseClaudeWallReset(CLAUDE_USAGE_AT_WALL_PROGRAM, now)).toEqual({
      eligible: false,
      ineligibleReason: "not_at_wall",
      inExperiment: false,
      available: false,
      nextAvailableAt: null,
      weeklyResetsAt: null,
      resetsPerWeek: 1,
      observedAt: now.toISOString(),
    });
    // The reset status read has none (`juniper_tide: null`).
    expect(
      parseClaudeUsageResponse(CLAUDE_USAGE_AT_WEEKLY_LIMIT, now)?.details?.wallReset,
    ).toBeUndefined();
  });
});

describe("the rest of the usage body", () => {
  test("the limit list with the Fable limit's share of the weekly limit", () => {
    const details = parseClaudeUsageResponse(CLAUDE_USAGE_THREE_FABLE_GRANTS, now)?.details;
    expect(details?.limits).toEqual([
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 56,
        severity: expect.any(String),
        resetsAt: expect.any(String),
        modelName: null,
        modelId: null,
        surface: null,
        isActive: true,
        allowancePercentOfWeekly: null,
        usedPercentOfWeekly: null,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 9,
        severity: expect.any(String),
        resetsAt: expect.any(String),
        modelName: "Fable",
        modelId: null,
        surface: null,
        isActive: false,
        allowancePercentOfWeekly: 50,
        usedPercentOfWeekly: expect.any(Number),
      },
    ]);
    // Reported as null by every account: no extra usage, no other surface's limit.
    expect(details?.extraUsage).toBeNull();
    expect(details?.surfaceWindows).toEqual([]);
    // The Fable limit stays readable as its plan window.
    expect(
      parseClaudeUsageResponse(CLAUDE_USAGE_THREE_FABLE_GRANTS, now)?.windows.find(
        (window) => window.id === "seven_day_fable",
      )?.usedPercent,
    ).toBe(9);
  });

  test("extra usage and other surfaces' windows when reported", () => {
    const body = {
      ...clone(CLAUDE_USAGE_AT_WEEKLY_LIMIT),
      extra_usage: {
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: 1250,
        utilization: 25,
        currency: "USD",
        disabled_reason: null,
      },
      seven_day_cowork: { utilization: 12, resets_at: "2026-11-13T01:00:00+00:00" },
    };
    const details = parseClaudeUsageResponse(body, now)?.details;
    expect(details?.extraUsage).toEqual({
      isEnabled: true,
      monthlyLimit: 5000,
      usedCredits: 1250,
      utilization: 25,
      currency: "USD",
      disabledReason: null,
    });
    expect(details?.surfaceWindows).toEqual([
      { id: "seven_day_cowork", usedPercent: 12, resetsAt: "2026-11-13T01:00:00.000Z" },
    ]);
    // Other surfaces' windows are never plan windows.
    expect(
      parseClaudeUsageResponse(body, now)?.windows.map((window) => window.id as string),
    ).not.toContain("seven_day_cowork");
  });
});

describe("service state from response headers", () => {
  test("a weekly refusal: fallback, overage disabled, threshold, upgrade path, retry-after", () => {
    const headers = new Headers(CLAUDE_HEADERS_WEEKLY_REJECTED);
    expect(parseClaudeServiceState(headers, now)).toEqual({
      observedAt: now.toISOString(),
      fallbackAvailable: null,
      fallbackPercentage: 0.5,
      overageDisabledReason: "org_level_disabled",
      overageInUse: null,
      overageDailyCapPaused: null,
      overageScope: null,
      upgradePaths: ["overage"],
      surpassedThresholds: [{ windowId: "seven_day", threshold: 1 }],
      retryAfterSeconds: 196970,
      slow: null,
      grace: null,
    });
    // The observation carries it.
    expect(parseClaudeUsageHeaders(headers, now)?.details?.serviceState?.retryAfterSeconds).toBe(
      196970,
    );
  });

  test("a warning threshold and credits that ran out", () => {
    expect(
      parseClaudeServiceState(new Headers(CLAUDE_HEADERS_WEEKLY_WARNING), now)?.surpassedThresholds,
    ).toEqual([{ windowId: "seven_day", threshold: 0.75 }]);
    expect(
      parseClaudeServiceState(new Headers(CLAUDE_HEADERS_OUT_OF_CREDITS), now)
        ?.overageDisabledReason,
    ).toBe("out_of_credits");
    expect(
      parseClaudeServiceState(new Headers(CLAUDE_HEADERS_FIVE_HOUR_ALLOWED), now)
        ?.surpassedThresholds,
    ).toEqual([]);
  });

  test("the slow tier and grace, as Claude Code reads them", () => {
    const state = parseClaudeServiceState(
      new Headers({
        "anthropic-ratelimit-unified-fallback": "available",
        "anthropic-ratelimit-unified-slow-status": "slot_busy",
        "anthropic-ratelimit-unified-slow-offer": "treatment",
        "anthropic-ratelimit-unified-slow-retry-after": "30",
        "anthropic-ratelimit-unified-slow-max-wait": "600",
        "anthropic-ratelimit-unified-slow-budget-utilization": "1.4",
        "anthropic-ratelimit-unified-slow-budget-reset": "1794531600",
        "anthropic-ratelimit-unified-grace-7d-utilization": "0.2",
        "anthropic-ratelimit-unified-overage-in-use": "true",
        "anthropic-ratelimit-unified-overage-daily-cap-paused": "true",
      }),
      now,
    );
    expect(state).toMatchObject({
      fallbackAvailable: true,
      overageInUse: true,
      overageDailyCapPaused: true,
      slow: {
        status: "slot_busy",
        offer: "treatment",
        retryAfterSeconds: 30,
        maxWaitSeconds: 600,
        // Capped at the whole budget.
        budgetUtilization: 1,
        budgetResetsAt: "2026-11-13T01:00:00.000Z",
      },
      grace: { fiveHourUtilization: null, sevenDayUtilization: 0.2 },
    });
    expect(claudeServiceStateInGrace(state)).toBe(true);
    expect(
      parseClaudeServiceState(
        new Headers({ "anthropic-ratelimit-unified-slow-status": "something-new" }),
        now,
      )?.slow?.status,
    ).toBe("unrecognized");
    expect(
      claudeServiceStateInGrace(
        parseClaudeServiceState(
          new Headers({ "anthropic-ratelimit-unified-grace-5h-utilization": "0" }),
          now,
        ),
      ),
    ).toBe(false);
    expect(parseClaudeServiceState(new Headers(), now)).toBeNull();
  });
});

describe("claim answers", () => {
  test("the provider's result is read as Claude Code reads it", () => {
    expect(
      parseClaudeLimitResetClaim(200, {
        result: "reset",
        reason: null,
        resets_left: 0,
        cleared: ["seven_day", "seven_day_overage_included"],
        weekly_resets_at: "2026-11-18T01:00:00+00:00",
      }),
    ).toEqual({
      result: "reset",
      reason: null,
      resetsLeft: 0,
      cleared: ["seven_day", "seven_day_overage_included"],
      weeklyResetsAt: "2026-11-18T01:00:00.000Z",
      cooldownUntil: null,
      retryable: false,
    });
    expect(
      parseClaudeLimitResetClaim(200, { result: "already_used", reason: "already_used" }),
    ).toMatchObject({ result: "already_used", reason: "already_used", retryable: false });
    expect(
      parseClaudeLimitResetClaim(200, {
        result: "cooldown",
        cooldown_until: "2026-11-11T09:00:00Z",
      }),
    ).toMatchObject({ result: "cooldown", cooldownUntil: "2026-11-11T09:00:00.000Z" });
  });

  test("unknown or unsettled answers are retried with the same request id", () => {
    expect(parseClaudeLimitResetClaim(200, { result: "something_new" })).toMatchObject({
      result: "unavailable",
      retryable: true,
    });
    expect(parseClaudeLimitResetClaim(200, { result: "unavailable" }).retryable).toBe(true);
    expect(parseClaudeLimitResetClaim(429, null)).toMatchObject({
      result: "rate_limited",
      retryable: true,
    });
    expect(parseClaudeLimitResetClaim(401, null).result).toBe("auth_error");
    expect(parseClaudeLimitResetClaim(403, null).result).toBe("auth_error");
    expect(parseClaudeLimitResetClaim(500, null)).toMatchObject({
      result: "error",
      retryable: true,
    });
    expect(parseClaudeLimitResetClaim(200, "not json")).toMatchObject({
      result: "error",
      retryable: true,
    });
  });
});

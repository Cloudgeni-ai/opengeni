// Paid usage credits ("extra usage") as live usage bodies report them
// (fixtures/claude-usage-live.ts): the setting in the reset programs'
// `event_props.extra_usage_state`, and the `extra_usage` object that the
// spend-skipping read answers with null whatever the setting.
import { describe, expect, test } from "bun:test";
import { claudeUsageCreditsState } from "@opengeni/contracts";
import { parseClaudeExtraUsage, parseClaudeUsageResponse } from "../src/claude-subscription-usage";
import {
  CLAUDE_RESET_STATUS_OTHER_SURFACE,
  CLAUDE_USAGE_AT_WALL_PROGRAM,
  CLAUDE_USAGE_AT_WEEKLY_LIMIT,
  CLAUDE_USAGE_FULL_GRANT,
  CLAUDE_USAGE_THREE_FABLE_GRANTS,
} from "./fixtures/claude-usage-live";

const now = new Date("2026-11-11T08:20:00.000Z");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const body = (value: unknown) => value as Record<string, unknown>;
const extraUsageOf = (value: unknown) => parseClaudeUsageResponse(value, now)?.details?.extraUsage;

describe("usage credits from live usage bodies", () => {
  test("an account with usage credits switched on reads as on, though extra_usage is null", () => {
    expect(CLAUDE_USAGE_THREE_FABLE_GRANTS.extra_usage).toBeNull();
    const extraUsage = extraUsageOf(CLAUDE_USAGE_THREE_FABLE_GRANTS);
    expect(extraUsage).toEqual({
      state: "enabled",
      isEnabled: null,
      monthlyLimit: null,
      usedCredits: null,
      utilization: null,
      currency: null,
      disabledReason: null,
    });
    expect(claudeUsageCreditsState(extraUsage)).toBe("on");
  });

  test("accounts that never configured usage credits read as off", () => {
    for (const fixture of [CLAUDE_USAGE_AT_WEEKLY_LIMIT, CLAUDE_USAGE_FULL_GRANT]) {
      const extraUsage = extraUsageOf(fixture);
      expect(extraUsage?.state).toBe("not_configured");
      expect(claudeUsageCreditsState(extraUsage)).toBe("off");
    }
  });

  test("a disabled setting reads as off", () => {
    const value = clone(CLAUDE_USAGE_FULL_GRANT) as Record<string, any>;
    value.cedar_ember.event_props.extra_usage_state = "disabled";
    expect(claudeUsageCreditsState(extraUsageOf(value))).toBe("off");
  });

  test("a body that does not say is unknown, never off", () => {
    // The other surface's reset status has no event_props; extra_usage is null.
    const otherSurface = {
      ...clone(CLAUDE_USAGE_FULL_GRANT),
      cedar_ember: clone(CLAUDE_RESET_STATUS_OTHER_SURFACE),
    };
    expect(parseClaudeExtraUsage(body(otherSurface))).toBeUndefined();
    expect(extraUsageOf(otherSurface)).toBeUndefined();
    expect(claudeUsageCreditsState(extraUsageOf(otherSurface))).toBe("unknown");
    // Claude's own "unknown", or a value this build does not know.
    for (const state of ["unknown", "paused_for_review", 1, null]) {
      const value = clone(CLAUDE_USAGE_FULL_GRANT) as Record<string, any>;
      value.cedar_ember.event_props.extra_usage_state = state;
      expect(extraUsageOf(value)).toBeUndefined();
    }
    // An older stored reading kept extra_usage: null as the whole answer.
    expect(claudeUsageCreditsState(null)).toBe("unknown");
    expect(claudeUsageCreditsState(undefined)).toBe("unknown");
  });

  test("the at-the-limit program's event_props report the setting too", () => {
    const value = {
      ...clone(CLAUDE_USAGE_FULL_GRANT),
      cedar_ember: clone(CLAUDE_RESET_STATUS_OTHER_SURFACE),
      juniper_tide: {
        ...clone(CLAUDE_USAGE_AT_WALL_PROGRAM),
        event_props: {
          ...clone(CLAUDE_USAGE_THREE_FABLE_GRANTS.cedar_ember.event_props),
        },
      },
    };
    expect(extraUsageOf(value)?.state).toBe("enabled");
  });

  test("the full extra_usage object: cents, and whether the credits can pay now", () => {
    // The shape Claude Code 2.1.322 documents for a read without skip_spend.
    const value = {
      ...clone(CLAUDE_USAGE_THREE_FABLE_GRANTS),
      extra_usage: {
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: 1250,
        utilization: 25,
        currency: "USD",
      },
    };
    expect(extraUsageOf(value)).toEqual({
      state: "enabled",
      isEnabled: true,
      monthlyLimit: 5000,
      usedCredits: 1250,
      utilization: 25,
      currency: "USD",
      disabledReason: null,
    });
    // Switched on with no balance left: cannot pay now, but the setting is on.
    const empty = clone(value) as Record<string, any>;
    empty.extra_usage.is_enabled = false;
    empty.extra_usage.used_credits = 5000;
    expect(claudeUsageCreditsState(extraUsageOf(empty))).toBe("on");
    // Without the setting, credits that cannot pay now are unknown, not off.
    empty.cedar_ember.event_props.extra_usage_state = "unknown";
    expect(claudeUsageCreditsState(extraUsageOf(empty))).toBe("unknown");
    // Credits that can pay now are on whatever else the body says.
    empty.extra_usage.is_enabled = true;
    expect(claudeUsageCreditsState(extraUsageOf(empty))).toBe("on");
  });

  test("a malformed usage-credits part never breaks the reading", () => {
    const value = clone(CLAUDE_USAGE_THREE_FABLE_GRANTS) as Record<string, any>;
    value.extra_usage = { is_enabled: "yes", monthly_limit: "lots", currency: 7 };
    const observation = parseClaudeUsageResponse(value, now);
    expect(observation?.windows.length).toBeGreaterThan(0);
    expect(observation?.details?.extraUsage).toMatchObject({ state: "enabled", isEnabled: null });
    value.cedar_ember.event_props = "not an object";
    value.extra_usage = null;
    expect(parseClaudeUsageResponse(value, now)?.details?.extraUsage).toBeUndefined();
  });
});

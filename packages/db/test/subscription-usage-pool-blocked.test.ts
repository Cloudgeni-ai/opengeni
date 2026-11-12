import { describe, expect, test } from "bun:test";
import {
  absentSubscriptionWindows,
  blockedSubscriptionWindows,
} from "../src/subscription-usage-pool";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 21, 6);
const at = (offset: number) => new Date(NOW + offset).toISOString();

function usage(
  windows: Array<{ id: string; resetsAt: string | null; status?: "ok" | "exhausted" }>,
  exhaustedUntil: string | null = null,
) {
  return {
    observedAt: at(-HOUR),
    source: "usage_endpoint" as const,
    windows: windows.map((window) => ({ usedPercent: 40, status: "ok" as const, ...window })),
    exhaustedUntil,
    exhaustedKind: exhaustedUntil ? ("quota" as const) : null,
  };
}

describe("windows the account list shows as Limit reached", () => {
  test("a Codex usage-limit deadline blocks the window that resets then", () => {
    const weekly = at(5 * 24 * HOUR);
    const reading = usage(
      [
        { id: "primary", resetsAt: at(2 * HOUR) },
        { id: "secondary", resetsAt: weekly },
      ],
      weekly,
    );
    expect(blockedSubscriptionWindows("codex", reading, NOW)).toEqual({
      weekly: NOW + 5 * 24 * HOUR,
    });
  });

  test("an unmatched deadline is placed by its distance, and a past one blocks nothing", () => {
    expect(blockedSubscriptionWindows("codex", usage([], at(2 * HOUR)), NOW)).toEqual({
      five_hour: NOW + 2 * HOUR,
    });
    expect(blockedSubscriptionWindows("codex", usage([], at(30 * HOUR)), NOW)).toEqual({
      weekly: NOW + 30 * HOUR,
    });
    expect(blockedSubscriptionWindows("codex", usage([], at(-HOUR)), NOW)).toEqual({});
  });

  test("an exhausted Claude window is blocked until its reset", () => {
    const reading = usage([
      { id: "seven_day", resetsAt: at(48 * HOUR), status: "exhausted" },
      { id: "five_hour", resetsAt: at(HOUR) },
    ]);
    expect(blockedSubscriptionWindows("claude", reading, NOW)).toEqual({
      weekly: NOW + 48 * HOUR,
    });
    expect(blockedSubscriptionWindows("claude", null, NOW)).toEqual({});
  });

  test("a refusal without a reset remains blocked, while an elapsed reset does not", () => {
    expect(
      blockedSubscriptionWindows(
        "claude",
        usage([
          { id: "five_hour", resetsAt: null, status: "exhausted" },
          { id: "seven_day", resetsAt: at(-HOUR), status: "exhausted" },
        ]),
        NOW,
      ),
    ).toEqual({ five_hour: null });
  });

  test("an unmatched deadline is placed in a window the account has", () => {
    // A weekly-only plan refused for two hours: the account has no five-hour window.
    expect(
      blockedSubscriptionWindows("codex", usage([], at(2 * HOUR)), NOW, ["five_hour"]),
    ).toEqual({ weekly: NOW + 2 * HOUR });
    expect(
      blockedSubscriptionWindows("codex", usage([], at(2 * HOUR)), NOW, ["five_hour", "weekly"]),
    ).toEqual({ five_hour: NOW + 2 * HOUR });
  });
});

describe("windows the account does not have", () => {
  test("a complete Codex usage reading with only the weekly window has no five-hour window", () => {
    const weeklyOnly = usage([{ id: "secondary", resetsAt: at(48 * HOUR) }]);
    expect(absentSubscriptionWindows("codex", weeklyOnly, true)).toEqual(["five_hour"]);
    const both = usage([
      { id: "primary", resetsAt: at(2 * HOUR) },
      { id: "secondary", resetsAt: at(48 * HOUR) },
    ]);
    expect(absentSubscriptionWindows("codex", both, true)).toEqual([]);
  });

  test("refusals, headers and incomplete providers never prove a window absent", () => {
    const weeklyOnly = usage([{ id: "secondary", resetsAt: at(48 * HOUR) }]);
    expect(absentSubscriptionWindows("codex", weeklyOnly, false)).toEqual([]);
    expect(absentSubscriptionWindows("codex", { ...weeklyOnly, source: "refusal" }, true)).toEqual(
      [],
    );
    expect(
      absentSubscriptionWindows("codex", { ...weeklyOnly, source: "response_headers" }, true),
    ).toEqual([]);
    expect(absentSubscriptionWindows("codex", null, true)).toEqual([]);
  });
});

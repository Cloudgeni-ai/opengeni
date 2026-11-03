import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  codexWindowInputs,
  subscriptionLimit,
  subscriptionPlanLabel,
  subscriptionWindowLabel,
  subscriptionWindows,
} from "../src/app/lib/subscription-accounts";
import {
  SubscriptionUsageWindows,
  subscriptionUsageReadings,
} from "../src/app/components/models/subscription-usage";

// One adapter per provider feeds the one shared display: plans by the names
// the providers sell them under today, and only the windows each reports.
const NOW = Date.parse("2026-11-03T12:00:00Z");
const HOUR = 3_600_000;

describe("plans as the providers name them", () => {
  test("Claude: Pro, Max and Ultra, and Max or Ultra while the tier is unknown", () => {
    expect(subscriptionPlanLabel("claude", "claude_pro")).toBe("Claude Pro");
    expect(subscriptionPlanLabel("claude", "claude_max_5x")).toBe("Claude Max");
    expect(subscriptionPlanLabel("claude", "claude_max_20x")).toBe("Claude Ultra");
    expect(subscriptionPlanLabel("claude", "claude_max")).toBe("Claude Max or Ultra");
    expect(subscriptionPlanLabel("claude", "claude_max", { brand: false })).toBe("Max or Ultra");
    // A plan this build doesn't know reads as words, never a raw id.
    expect(subscriptionPlanLabel("claude", "claude_galaxy")).toBe("Claude Galaxy");
  });

  test("ChatGPT, SuperGrok and any later provider", () => {
    expect(subscriptionPlanLabel("codex", "plus")).toBe("ChatGPT Plus");
    expect(subscriptionPlanLabel("codex", "Pro")).toBe("ChatGPT Pro");
    expect(subscriptionPlanLabel("codex", "free")).toBe("ChatGPT Free");
    expect(subscriptionPlanLabel("codex", "team")).toBe("ChatGPT Business");
    expect(subscriptionPlanLabel("xai", "SuperGrok Heavy")).toBe("SuperGrok Heavy");
    expect(subscriptionPlanLabel("supergrok", "heavy")).toBe("SuperGrok Heavy");
    expect(subscriptionPlanLabel("acme", "gold_tier")).toBe("Gold tier");
    for (const plan of [null, undefined, "", "  "])
      expect(subscriptionPlanLabel("claude", plan)).toBeNull();
  });
});

describe("windows", () => {
  test("short labels, in a stable order, including scoped weeks this build doesn't know", () => {
    expect(subscriptionWindowLabel("claude", "seven_day_fable")).toBe("Fable week");
    expect(subscriptionWindowLabel("claude", "seven_day_haiku")).toBe("Haiku week");
    expect(subscriptionWindowLabel("xai", "billing")).toBe("Credits");
    // Only Codex's core ids mean 5h and Week; elsewhere they claim no length.
    expect(subscriptionWindowLabel("codex", "primary")).toBe("5h");
    expect(subscriptionWindowLabel("acme", "primary")).toBe("Primary");
    const windows = subscriptionWindows(
      "claude",
      [
        { id: "overage", usedPercent: 10, resetsAt: null },
        { id: "seven_day_fable", usedPercent: 20, resetsAt: NOW + 48 * HOUR },
        { id: "seven_day", usedPercent: 66, resetsAt: NOW + 72 * HOUR },
      ],
      NOW,
    );
    expect(windows.map((window) => [window.label, window.leftPercent])).toEqual([
      ["Week", 34],
      ["Fable week", 80],
      ["Extra usage", 90],
    ]);
  });

  test("a verified Ultra account and a ChatGPT Pro account get no 5h window", () => {
    const ultra = subscriptionWindows(
      "claude",
      [{ id: "seven_day", usedPercent: 10, resetsAt: NOW + HOUR }],
      NOW,
    );
    expect(ultra.map((window) => window.label)).toEqual(["Week"]);
    const pro = codexWindowInputs({ fiveHour: null, weekly: { percent: 30, resetAt: null } });
    expect(subscriptionWindows("codex", pro, NOW).map((window) => window.label)).toEqual(["Week"]);
  });

  test("a reached limit holds until its last reset; extra usage never decides it", () => {
    const windows = subscriptionWindows(
      "claude",
      [
        { id: "five_hour", usedPercent: 100, resetsAt: NOW + HOUR },
        { id: "seven_day", usedPercent: 40, resetsAt: NOW + 50 * HOUR, status: "exhausted" },
        { id: "overage", usedPercent: 125, resetsAt: null },
      ],
      NOW,
    );
    expect(subscriptionLimit(windows, null, NOW)).toEqual({
      reached: true,
      until: NOW + 50 * HOUR,
      near: false,
    });
    const extraOnly = subscriptionWindows(
      "claude",
      [
        { id: "seven_day", usedPercent: 40, resetsAt: NOW + HOUR },
        { id: "overage", usedPercent: 125, resetsAt: null },
      ],
      NOW,
    );
    expect(subscriptionLimit(extraOnly, null, NOW).reached).toBe(false);
    // A refusal without a window still holds until it ends.
    expect(subscriptionLimit([], NOW + HOUR, NOW)).toEqual({
      reached: true,
      until: NOW + HOUR,
      near: false,
    });
  });
});

describe("model-scoped weeks", () => {
  test("a spent Fable week limits only Fable: the account stays available, near its limit", () => {
    const windows = subscriptionWindows(
      "claude",
      [
        { id: "seven_day", usedPercent: 30, resetsAt: NOW + 72 * HOUR },
        { id: "seven_day_fable", usedPercent: 100, resetsAt: NOW + 30 * HOUR },
        { id: "seven_day_haiku", usedPercent: 100, resetsAt: NOW + 30 * HOUR },
      ],
      NOW,
    );
    expect(windows.map((window) => [window.label, window.limitReached, window.scoped])).toEqual([
      ["Week", false, false],
      ["Fable week", true, true],
      ["Haiku week", true, true],
    ]);
    expect(subscriptionLimit(windows, null, NOW)).toEqual({
      reached: false,
      until: null,
      near: true,
    });
  });

  test("the account page meter reads a refused window as 0% left", () => {
    const [refused] = subscriptionWindows(
      "claude",
      [{ id: "seven_day", usedPercent: 60, resetsAt: NOW + HOUR, status: "exhausted" }],
      NOW,
    );
    expect(subscriptionUsageReadings([refused!], NOW)[0]).toMatchObject({
      label: "Week",
      percent: 0,
      limitReached: true,
    });
  });
});

describe("the shared usage display", () => {
  beforeAll(() => GlobalRegistrator.register());
  afterAll(() => GlobalRegistrator.unregister());

  test("every reported window has its label, share left and reset, and nothing truncates", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const windows = subscriptionWindows(
      "claude",
      [
        { id: "seven_day", usedPercent: 66, resetsAt: NOW + 72 * HOUR },
        { id: "seven_day_fable", usedPercent: 100, resetsAt: NOW + 30 * HOUR },
      ],
      NOW,
    );
    try {
      await act(async () => root.render(<SubscriptionUsageWindows windows={windows} now={NOW} />));
      const rendered = [
        ...container.querySelectorAll<HTMLElement>('[data-slot="subscription-usage-window"]'),
      ];
      expect(rendered.map((window) => window.getAttribute("aria-label"))).toEqual([
        expect.stringMatching(/^Week: 34% left, resets /),
        expect.stringMatching(/^Fable week: Limit reached, until /),
      ]);
      expect(rendered[0]!.getAttribute("aria-valuenow")).toBe("34");
      expect(rendered[1]!.textContent).toContain("until");
      expect(container.querySelector(".truncate")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

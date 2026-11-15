import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ClaudeLimitResetGrant, ClaudeSubscriptionUsage } from "@opengeni/sdk";
import {
  ClaudeLimitResetsSection,
  claudeGrantBlockedReason,
  claudeGrantClears,
  claudeListedGrants,
} from "./claude-limit-resets";
import { claudeWindowInputs } from "./claude-usage";

let root: Root, container: HTMLDivElement;
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

const NOW = Date.parse("2026-11-11T08:00:00Z");

// As Claude reports them for an account at its weekly limit (anonymous).
const weekly: ClaudeLimitResetGrant = {
  id: "full-reset-2611",
  label: "One full limit reset (November 2026)",
  type: "weekly",
  kind: "weekly",
  resetsTotal: 1,
  resetsLeft: 1,
  startsAt: "2026-11-10T21:30:00.000Z",
  endsAt: "2099-12-10T22:00:00.000Z",
  clears: ["seven_day", "seven_day_overage_included"],
  paused: false,
  usableNow: true,
  useRequiresLimit: false,
  givesBackWeekly: false,
  percentUsed: { seven_day: 100 },
  blocking: [],
  unavailableReason: null,
};
const fable: ClaudeLimitResetGrant = {
  ...weekly,
  id: "launch-2610-fable",
  label: "New model launch: one Fable reset",
  type: "full",
  kind: "fable",
  endsAt: "2099-03-09T07:59:00.000Z",
  clears: ["seven_day_overage_included"],
  usableNow: false,
  givesBackWeekly: true,
  percentUsed: { seven_day_overage_included: 0 },
  blocking: ["seven_day"],
  unavailableReason: "blocked_seven_day",
};
const status = {
  eligible: true,
  ineligibleReason: null,
  atLimit: true,
  exhausted: ["seven_day"],
  grants: [fable, weekly],
  nextGrantId: null,
  weeklyResetsAt: null,
  cooldownUntil: null,
  observedAt: "2026-11-11T07:59:00.000Z",
};
const usage = (limitResets: ClaudeSubscriptionUsage["limitResets"]): ClaudeSubscriptionUsage => ({
  connected: true,
  credentialVersion: 1,
  windows: [],
  observedAt: null,
  source: null,
  refreshStatus: "available",
  refreshCheckedAt: null,
  limitResets,
});

test("what each grant clears, in plain words", () => {
  expect(claudeGrantClears(weekly)).toBe("Clears the weekly limit.");
  expect(claudeGrantClears(fable)).toBe("Clears the Fable limit.");
  expect(claudeGrantClears({ ...weekly, clears: ["five_hour", "seven_day"] })).toBe(
    "Clears the 5-hour and weekly limits.",
  );
  expect(claudeGrantClears({ ...weekly, clears: ["five_hour"] })).toBe("Clears the 5-hour limit.");
});

test("usable grants come first, then the soonest to expire; each says why it can't be used", () => {
  expect(claudeListedGrants(status, NOW).map(({ grant, blocked }) => [grant.id, blocked])).toEqual([
    ["full-reset-2611", null],
    ["launch-2610-fable", "blocked_seven_day"],
  ]);
  // Derived the way Claude Code derives it when the provider gives no reason.
  const derived = { ...fable, unavailableReason: null };
  expect(claudeGrantBlockedReason(derived, status, NOW)).toBe("blocked_seven_day");
  expect(
    claudeGrantBlockedReason({ ...derived, blocking: [], useRequiresLimit: true }, status, NOW),
  ).toBe("needs_limit");
  expect(claudeGrantBlockedReason({ ...derived, blocking: [] }, status, NOW)).toBe("unavailable");
  expect(
    claudeGrantBlockedReason(
      { ...derived, blocking: [], clears: ["five_hour"], givesBackWeekly: false },
      status,
      NOW,
    ),
  ).toBe("cannot_clear");
  // Expired, used and not yet started outrank what the provider said.
  expect(claudeGrantBlockedReason({ ...weekly, endsAt: "2026-11-01T00:00:00Z" }, status, NOW)).toBe(
    "expired",
  );
  expect(claudeGrantBlockedReason({ ...weekly, resetsLeft: 0 }, status, NOW)).toBe("none_left");
  expect(
    claudeGrantBlockedReason({ ...weekly, startsAt: "2099-01-01T00:00:00Z" }, status, NOW),
  ).toBe("not_started");
});

test("the section lists each grant with what it clears, how many are left, its expiry and state", async () => {
  await act(async () => root.render(<ClaudeLimitResetsSection usage={usage(status)} />));
  const rows = [...container.querySelectorAll('[role="listitem"]')];
  expect(rows.map((row) => row.getAttribute("data-grant"))).toEqual([
    "full-reset-2611",
    "launch-2610-fable",
  ]);
  expect(rows[0]!.textContent).toContain("One full limit reset (November 2026)");
  expect(rows[0]!.textContent).toContain("Clears the weekly limit.");
  expect(rows[0]!.textContent).toContain("1 left");
  expect(rows[0]!.textContent).toContain("Expires");
  expect(rows[0]!.querySelector('[data-slot="grant-state"]')!.textContent).toBe("Usable now.");
  expect(rows[1]!.querySelector('[data-slot="grant-state"]')!.textContent).toBe(
    "No Fable usage this week to give back.",
  );
  expect(container.textContent).toContain("Limit resets");
});

test("no section without grants", async () => {
  for (const value of [
    usage(undefined),
    usage(null),
    usage({ ...status, eligible: false, ineligibleReason: "tier", grants: [] }),
  ]) {
    await act(async () => root.render(<ClaudeLimitResetsSection usage={value} />));
    expect(container.textContent).toBe("");
  }
  await act(async () => root.render(<ClaudeLimitResetsSection usage={null} />));
  expect(container.textContent).toBe("");
});

test("the weekly Fable limit shows once under either name, the newer reading winning", () => {
  const window = (
    id: "seven_day_fable" | "seven_day_overage_included",
    used: number,
    at: string,
  ) => ({
    id,
    usedPercent: used,
    resetsAt: "2099-11-13T01:00:00Z",
    status: null,
    observedAt: at,
  });
  expect(
    claudeWindowInputs([
      window("seven_day_fable", 10, "2026-11-11T07:00:00Z"),
      window("seven_day_overage_included", 40, "2026-11-11T07:30:00Z"),
    ]).map((input) => [input.id, input.usedPercent]),
  ).toEqual([["seven_day_fable", 40]]);
  expect(
    claudeWindowInputs([window("seven_day_overage_included", 40, "2026-11-11T07:30:00Z")]).map(
      (input) => input.id,
    ),
  ).toEqual(["seven_day_fable"]);
});

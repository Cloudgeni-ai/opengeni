import { describe, expect, test } from "bun:test";

import { isMachineComputeSelectable } from "./machine-selectability";

// The session "Run on" pickers (sessions-index machine picker + the in-session
// sandbox-switcher) gate selectability through this helper. The backend attach
// gate is liveness-only, so any REACHABLE machine — online, headless
// (display_unavailable), or one whose screen control isn't consented
// (consent_required) — must be selectable for compute-only sessions, while
// offline / reconnecting / enrolling genuinely can't attach.
describe("isMachineComputeSelectable", () => {
  test("a headless online machine (display_unavailable) is selectable", () => {
    expect(isMachineComputeSelectable("display_unavailable")).toBe(true);
  });

  test("an online machine is selectable", () => {
    expect(isMachineComputeSelectable("online")).toBe(true);
  });

  test("a displayed machine without screen-control consent (consent_required) is still selectable for compute + view", () => {
    expect(isMachineComputeSelectable("consent_required")).toBe(true);
  });

  test("an offline machine is not selectable", () => {
    expect(isMachineComputeSelectable("offline")).toBe(false);
  });

  test("reconnecting / enrolling stay gated", () => {
    expect(isMachineComputeSelectable("reconnecting")).toBe(false);
    expect(isMachineComputeSelectable("enrolling")).toBe(false);
  });
});

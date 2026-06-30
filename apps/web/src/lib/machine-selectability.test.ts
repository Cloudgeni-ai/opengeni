import { describe, expect, test } from "bun:test";

import { isMachineComputeSelectable } from "./machine-selectability";

// The session "Run on" pickers (sessions-index machine <select> + the in-session
// sandbox-switcher) gate selectability through this helper. The backend attach
// gate is liveness-only, so an online-but-headless machine (display_unavailable)
// must be selectable for compute-only sessions, while consent/offline/reconnecting
// must stay gated.
describe("isMachineComputeSelectable", () => {
  test("a headless online machine (display_unavailable) is selectable", () => {
    expect(isMachineComputeSelectable("display_unavailable")).toBe(true);
  });

  test("an online machine is selectable", () => {
    expect(isMachineComputeSelectable("online")).toBe(true);
  });

  test("an offline machine is not selectable", () => {
    expect(isMachineComputeSelectable("offline")).toBe(false);
  });

  test("consent_required / reconnecting / enrolling stay gated", () => {
    expect(isMachineComputeSelectable("consent_required")).toBe(false);
    expect(isMachineComputeSelectable("reconnecting")).toBe(false);
    expect(isMachineComputeSelectable("enrolling")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  digestIdentities,
  maintenanceNote,
  scheduleIsOwnedByRun,
} from "./release-temporal-maintenance";

describe("release Temporal maintenance ownership", () => {
  test("binds schedule ownership to the exact maintenance run", () => {
    const note = maintenanceNote("release-123");
    expect(scheduleIsOwnedByRun({ state: { paused: true, note } } as never, note)).toBe(true);
    expect(
      scheduleIsOwnedByRun(
        { state: { paused: true, note: maintenanceNote("release-elsewhere") } } as never,
        note,
      ),
    ).toBe(false);
    expect(scheduleIsOwnedByRun({ state: { paused: false, note } } as never, note)).toBe(false);
  });

  test("rejects unsafe run ids and hashes framed identities", () => {
    expect(() => maintenanceNote("../../bad")).toThrow("unsafe maintenance run id");
    expect(digestIdentities(["ab", "c"])).not.toBe(digestIdentities(["a", "bc"]));
  });
});

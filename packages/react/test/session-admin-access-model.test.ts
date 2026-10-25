import { describe, expect, test } from "bun:test";
import {
  ADMIN_ACCESS_DURATIONS,
  adminAccessDurationHours,
  adminAccessGrantedByText,
  endsText,
} from "../src/session-admin-access-model";

describe("session full access model", () => {
  test("offers the web's time limits and sends hours or no limit", () => {
    expect(ADMIN_ACCESS_DURATIONS.map((each) => each.label)).toEqual([
      "1 hour",
      "8 hours",
      "1 day",
      "No limit",
    ]);
    expect(ADMIN_ACCESS_DURATIONS.map((each) => adminAccessDurationHours(each.value))).toEqual([
      1,
      8,
      24,
      null,
    ]);
  });

  test("says when it ends", () => {
    const now = new Date(2026, 9, 25, 10, 0);
    expect(endsText(null, now)).toBe("No time limit");
    expect(endsText("not a date", now)).toBe("No time limit");
    expect(endsText(new Date(2026, 9, 25, 11, 0).toISOString(), now)).toStartWith("Ends at ");
    expect(endsText(new Date(2026, 9, 26, 9, 0).toISOString(), now)).toStartWith(
      "Ends tomorrow at ",
    );
    expect(endsText(new Date(2026, 9, 30, 9, 0).toISOString(), now)).not.toContain("tomorrow");
  });

  test("names who the agent acts as", () => {
    const base = { active: true, expiresAt: null, canGrant: true, canRevoke: true };
    expect(adminAccessGrantedByText({ ...base, grantedBy: { name: "Ada" } } as never)).toContain(
      "what Ada can",
    );
    expect(adminAccessGrantedByText({ ...base, grantedBy: null } as never)).toContain(
      "the person who gave it access",
    );
  });
});

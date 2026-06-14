import { describe, expect, test } from "bun:test";
import type { SessionStatus } from "@opengeni/contracts";
import { assertReusableSessionRevivable } from "../src/activities/common";

describe("reusable session revival guard (cancelled-resurrection)", () => {
  test("refuses to revive a cancelled (terminal) reusable session", () => {
    // The one terminal state: an explicit user cancel. A scheduled fire must not
    // silently resurrect and re-bill it.
    expect(() => assertReusableSessionRevivable("cancelled")).toThrow(/cancelled/i);
  });

  test("allows revivable states so a recurring task keeps working", () => {
    // Failed/idle stay revivable (talking to a session is how it resumes), and
    // an actively-running/queued session is signalled, not blocked.
    const revivable: SessionStatus[] = ["queued", "running", "idle", "requires_action", "failed"];
    for (const status of revivable) {
      expect(() => assertReusableSessionRevivable(status)).not.toThrow();
    }
  });

  test("mirrors the API guard's terminal set exactly (only cancelled is rejected)", () => {
    // Keep parity with apps/api/src/domain/sessions.ts: cancelled is the SOLE
    // rejected state. If a future status is added, this test forces a conscious
    // decision rather than silently widening or narrowing the guard.
    const all: SessionStatus[] = ["queued", "running", "idle", "requires_action", "failed", "cancelled"];
    const rejected = all.filter((status) => {
      try {
        assertReusableSessionRevivable(status);
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toEqual(["cancelled"]);
  });
});

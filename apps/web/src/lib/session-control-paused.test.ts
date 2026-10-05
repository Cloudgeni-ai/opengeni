import { describe, expect, test } from "bun:test";
import { sessionControlPaused } from "./session-rail";

describe("sessionControlPaused", () => {
  test("a paused live session reads as paused", () => {
    expect(sessionControlPaused({ status: "idle", effectiveControl: { state: "paused" } })).toBe(
      true,
    );
  });

  test("a cancelled session never reads as paused, even though cancel leaves a pause fence", () => {
    expect(
      sessionControlPaused({ status: "cancelled", effectiveControl: { state: "paused" } }),
    ).toBe(false);
  });

  test("an active session is not paused", () => {
    expect(sessionControlPaused({ status: "running", effectiveControl: { state: "active" } })).toBe(
      false,
    );
  });
});

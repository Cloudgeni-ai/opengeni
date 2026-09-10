import { describe, expect, test } from "bun:test";

import { sessionHasVariableSetBlockingWork } from "./session-variable-set-editability";

describe("sessionHasVariableSetBlockingWork", () => {
  test("live nonterminal status blocks edits before the detail pointer catches up", () => {
    for (const status of [
      "queued",
      "running",
      "requires_action",
      "recovering",
      "waiting_capacity",
    ] as const) {
      expect(sessionHasVariableSetBlockingWork({ status, activeTurnId: null })).toBe(true);
    }
  });

  test("settled status cannot override a still-active turn", () => {
    for (const status of ["idle", "failed", "cancelled"] as const) {
      expect(sessionHasVariableSetBlockingWork({ status, activeTurnId: "active-turn" })).toBe(true);
      expect(sessionHasVariableSetBlockingWork({ status, activeTurnId: null })).toBe(false);
    }
  });
});

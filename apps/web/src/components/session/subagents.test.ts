import { describe, expect, test } from "bun:test";

import { subagentAttentionHint } from "./subagents";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe("subagentAttentionHint", () => {
  test("tells the manager how long a child has waited for input", () => {
    const hint = subagentAttentionHint(
      { status: "requires_action", requiresActionSince: hoursAgo(10) },
      false,
      NOW,
    );
    expect(hint?.word).toBe("Needs you · 10h");
    expect(hint?.waitingFor).toBe("10h");
    expect(hint?.title).toContain("Waiting for your input since");
  });

  test("keeps the plain word when the server did not report a waiting timestamp", () => {
    expect(subagentAttentionHint({ status: "requires_action" }, false, NOW)).toEqual({
      word: "Needs you",
      waitingFor: "",
    });
    expect(
      subagentAttentionHint({ status: "requires_action", requiresActionSince: null }, false, NOW),
    ).toEqual({ word: "Needs you", waitingFor: "" });
  });

  test("failed and paused rows stay loud without a duration; calm rows stay quiet", () => {
    expect(subagentAttentionHint({ status: "failed" }, false, NOW)).toEqual({
      word: "Failed",
      waitingFor: "",
    });
    expect(subagentAttentionHint({ status: "running" }, true, NOW)).toEqual({
      word: "Paused",
      waitingFor: "",
    });
    expect(subagentAttentionHint({ status: "running" }, false, NOW)).toBeNull();
    expect(subagentAttentionHint({ status: "idle" }, false, NOW)).toBeNull();
  });
});

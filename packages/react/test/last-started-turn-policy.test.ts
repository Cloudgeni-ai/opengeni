import { describe, expect, test } from "bun:test";
import { isLastStartedTurnPolicyEvent } from "../src/hooks/use-last-started-turn-policy";

describe("isLastStartedTurnPolicyEvent", () => {
  test("only turn.started admits a new last-used policy", () => {
    expect(isLastStartedTurnPolicyEvent({ type: "turn.started" })).toBe(true);
    expect(isLastStartedTurnPolicyEvent({ type: "turn.queued" })).toBe(false);
    expect(isLastStartedTurnPolicyEvent({ type: "turn.completed" })).toBe(false);
    expect(isLastStartedTurnPolicyEvent({ type: "user.message" })).toBe(false);
    expect(isLastStartedTurnPolicyEvent({ type: "session.queue.updated" })).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { turnAttemptProducerId } from "../src/activities/agent-turn/claim";

describe("turn attempt durable producer identity", () => {
  test("does not collide when Temporal reuses an activity id across workflow runs", () => {
    const first = turnAttemptProducerId(
      { workflowId: "session-1", attemptId: "attempt-before-pause" },
      "turn-1",
    );
    const resumed = turnAttemptProducerId(
      { workflowId: "session-1", attemptId: "attempt-after-resume" },
      "turn-1",
    );

    expect(first).not.toBe(resumed);
  });

  test("is stable for a retry of the same scheduled attempt", () => {
    const input = { workflowId: "session-1", attemptId: "attempt-1" };
    expect(turnAttemptProducerId(input, "turn-1")).toBe(turnAttemptProducerId(input, "turn-1"));
  });
});

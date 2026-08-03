import { describe, expect, test } from "bun:test";
import { goalContinuationPrompt } from "../src/activities/goals";

describe("goalContinuationPrompt", () => {
  test("continues from durable context instead of restarting turn housekeeping", () => {
    const prompt = goalContinuationPrompt(
      {
        text: "Ship the fix",
        successCriteria: "Tests pass",
      } as Parameters<typeof goalContinuationPrompt>[0],
      3,
      null,
    );

    expect(prompt).toContain("[GOAL CONTINUATION 3]");
    expect(prompt).toContain(
      "Do not repeat completed session setup, persistent metadata settings, or context checks",
    );
  });
});

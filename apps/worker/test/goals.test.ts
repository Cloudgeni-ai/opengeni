import { describe, expect, test } from "bun:test";
import { goalContinuationPrompt } from "../src/activities/goals";

describe("goalContinuationPrompt", () => {
  test("continues from frozen goal context without duplicating mutable goal fields", () => {
    const prompt = goalContinuationPrompt(
      {
        text: "Ship the fix",
        successCriteria: "Tests pass",
      } as Parameters<typeof goalContinuationPrompt>[0],
      3,
      null,
    );

    expect(prompt).toContain("Continue working toward the active session goal");
    expect(prompt).toContain("Completion audit:");
    expect(prompt).toContain("Blocked audit:");
    expect(prompt).toContain("opengeni__goal_complete");
    expect(prompt).toContain("opengeni__goal_pause");
    // Orchestrators waiting on child sessions / external events hold the goal
    // instead of sleeping or polling, and never substitute a hold for a pause
    // when a human decision is the blocker.
    expect(prompt).toContain("opengeni__goal_wait");
    expect(prompt).toContain("do not sleep, loop, or poll");
    expect(prompt).toContain("blocked on a human decision, use opengeni__goal_pause");
    expect(prompt).not.toContain("Ship the fix");
    expect(prompt).not.toContain("Tests pass");
    expect(prompt).not.toContain("GOAL CONTINUATION 3");
    expect(prompt).not.toContain("goal_progress");
  });
});

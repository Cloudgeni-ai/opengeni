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
    expect(prompt).not.toContain("Ship the fix");
    expect(prompt).not.toContain("Tests pass");
    expect(prompt).not.toContain("GOAL CONTINUATION 3");
    expect(prompt).not.toContain("goal_progress");
    // Without the tool in the session's effective first-party selection the
    // prompt must not instruct a tool the agent cannot call.
    expect(prompt).not.toContain("goal_wait");
  });

  test("teaches goal_wait only when the tool is in the session's selection", () => {
    const goal = { text: "Ship the fix" } as Parameters<typeof goalContinuationPrompt>[0];
    const withWait = goalContinuationPrompt(goal, 1, null, { goalWaitAvailable: true });
    // Orchestrators waiting on child sessions / external events hold the goal
    // instead of sleeping or polling, and never substitute a hold for a pause
    // when a human decision is the blocker.
    expect(withWait).toContain("opengeni__goal_wait");
    expect(withWait).toContain("do not sleep, loop, or poll");
    expect(withWait).toContain("blocked on a human decision, use opengeni__goal_pause");
    expect(withWait).toContain("Blocked audit:");
    const withoutWait = goalContinuationPrompt(goal, 1, null, { goalWaitAvailable: false });
    expect(withoutWait).not.toContain("goal_wait");
    expect(withoutWait).toContain("Blocked audit:");
    expect(withWait).not.toContain("Ship the fix");
  });

  test("explains child lifecycle notices and offers the human-input answer tool only when selected", () => {
    const goal = { text: "Ship the fix" } as Parameters<typeof goalContinuationPrompt>[0];
    const withTool = goalContinuationPrompt(goal, 1, null, { humanInputRespondAvailable: true });
    expect(withTool).toContain(
      "`child_requires_action` update means a worker you spawned is blocked",
    );
    expect(withTool).toContain("opengeni__session_human_input_respond");
    expect(withTool).toContain("Tool approvals can only be decided by a human");
    expect(withTool).toContain("report the exact blocker");
    expect(withTool).toContain("`child_requires_action_resolved`, `child_paused`");
    const withoutTool = goalContinuationPrompt(goal, 1, null, {
      humanInputRespondAvailable: false,
    });
    expect(withoutTool).not.toContain("session_human_input_respond");
    expect(withoutTool).toContain(
      "`child_requires_action` update means a worker you spawned is blocked",
    );
    expect(withoutTool).toContain("Tool approvals can only be decided by a human");
  });
});

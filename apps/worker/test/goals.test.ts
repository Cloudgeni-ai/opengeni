import { describe, expect, test } from "bun:test";
import {
  goalContinuationFundedWithoutCredits,
  goalContinuationModelDecision,
  goalContinuationPrompt,
} from "../src/activities/goals";
import { testSettings } from "@opengeni/testing";

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

    expect(prompt).toContain(
      "Reconcile the active session goal against authoritative current state",
    );
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

  test("re-enters the full objective through authoritative reconciliation", () => {
    const prompt = goalContinuationPrompt(
      { text: "Ship the fix" } as Parameters<typeof goalContinuationPrompt>[0],
      1,
      null,
    );

    expect(prompt).toStartWith(
      "Reconcile the active session goal against authoritative current state, then carry the work through to the full requested end state and verify it.",
    );
    expect(prompt).toContain(
      "re-entry into the full objective, not as a request to perform one step and stop",
    );
    expect(prompt).toContain("Do not rely on previous assistant claims of progress or completion");
    expect(prompt).toContain(
      "Keep working until the requested end state is true and verified. Do not end the turn merely because one useful action completed",
    );
    expect(prompt).toContain(
      "Before repeating a state-setting action, verify whether its desired state already holds",
    );
    expect(prompt).not.toContain("make concrete progress toward the real requested end state");
    expect(prompt).not.toContain("take the next useful action");
  });

  test("teaches goal_wait only when the tool is in the session's selection", () => {
    const goal = { text: "Ship the fix" } as Parameters<typeof goalContinuationPrompt>[0];
    const withWait = goalContinuationPrompt(goal, 1, null, { goalWaitAvailable: true });
    // Orchestrators waiting on child sessions / external events hold the goal
    // instead of sleeping or polling, and never substitute a hold for a pause
    // when a human decision is the blocker.
    expect(withWait).toContain("opengeni__goal_wait");
    expect(withWait).toContain("do not sleep, loop, or poll");
    expect(withWait).toContain("do not restate it or produce another equivalent final answer");
    expect(withWait).toContain("Report only material new state or a newly discovered blocker");
    expect(withWait).toContain("blocked on a human decision, use opengeni__goal_pause");
    expect(withWait).toContain("Blocked audit:");
    const withoutWait = goalContinuationPrompt(goal, 1, null, { goalWaitAvailable: false });
    expect(withoutWait).not.toContain("goal_wait");
    expect(withoutWait).not.toContain("another equivalent final answer");
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

describe("goalContinuationModelDecision", () => {
  test("falls back to the session model when the inherited model left the catalog", () => {
    expect(
      goalContinuationModelDecision({
        settings: testSettings(),
        workspaceModelPolicy: null,
        inheritedModel: "removed/provider-model",
        sessionModel: "scripted-model",
      }),
    ).toEqual({ model: "scripted-model", blocked: null });
  });

  test("pauses instead of materializing when neither inherited nor session model exists", () => {
    expect(
      goalContinuationModelDecision({
        settings: testSettings(),
        workspaceModelPolicy: null,
        inheritedModel: "removed/provider-model",
        sessionModel: "removed/session-model",
      }),
    ).toMatchObject({
      model: "removed/provider-model",
      blocked: expect.stringContaining("no longer in the deployment or workspace catalog"),
    });
  });

  test("recognizes synthetic Codex and SuperGrok catalog membership", () => {
    for (const [settings, model] of [
      [testSettings({ codexSubscriptionEnabled: true }), "codex/gpt-5.6-sol"],
      [testSettings({ supergrokSubscriptionEnabled: true }), "supergrok/grok-4.6"],
    ] as const) {
      expect(
        goalContinuationModelDecision({
          settings,
          workspaceModelPolicy: null,
          inheritedModel: model,
          sessionModel: "scripted-model",
        }),
      ).toEqual({ model, blocked: null });
    }
  });

  test("treats a SuperGrok continuation as subscription-funded", () => {
    expect(
      goalContinuationFundedWithoutCredits(
        testSettings({ supergrokSubscriptionEnabled: true }),
        "supergrok/grok-4.6",
        false,
      ),
    ).toBe(true);
  });

  test("does not fund an unconnected Codex continuation from its namespace alone", () => {
    expect(
      goalContinuationFundedWithoutCredits(
        testSettings({ codexSubscriptionEnabled: true }),
        "codex/gpt-5.6-sol",
        false,
      ),
    ).toBe(false);
  });
});

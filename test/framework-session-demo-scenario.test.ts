import { describe, expect, test } from "bun:test";
import {
  FRAMEWORK_DEMO_EVENT_SPECS,
  FRAMEWORK_DEMO_HUMAN_INPUT_ID,
  FRAMEWORK_DEMO_MODELS,
  FRAMEWORK_DEMO_SESSION_ID,
  FRAMEWORK_DEMO_WORKSPACE_ID,
  createFrameworkDemoHumanInputRequest,
} from "./fixtures/framework-session/demo-scenario";

describe("shared framework demo scenario", () => {
  test("keeps one deterministic SDK contract for both adapters", () => {
    const request = createFrameworkDemoHumanInputRequest();

    expect(FRAMEWORK_DEMO_EVENT_SPECS.map(({ type }) => type)).toEqual([
      "session.created",
      "user.message",
      "session.status.changed",
      "agent.message.completed",
      "agent.toolCall.created",
      "agent.toolCall.output",
      "goal.set",
      "turn.startup.phase.completed",
      "sandbox.operation.started",
      "sandbox.command.output.delta",
      "sandbox.operation.completed",
      "session.requiresAction",
    ]);
    expect(request).toMatchObject({
      id: FRAMEWORK_DEMO_HUMAN_INPUT_ID,
      workspaceId: FRAMEWORK_DEMO_WORKSPACE_ID,
      sessionId: FRAMEWORK_DEMO_SESSION_ID,
      allowSkip: false,
      questions: [{ required: true, allowOther: false }],
    });
    expect(FRAMEWORK_DEMO_MODELS[0]).toBe("gpt-5.6-sol");
  });
});

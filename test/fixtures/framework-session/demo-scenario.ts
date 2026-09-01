import type { SessionHumanInputRequest } from "@opengeni/sdk";

export const FRAMEWORK_DEMO_WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
export const FRAMEWORK_DEMO_SESSION_ID = "22222222-2222-4222-8222-222222222222";
export const FRAMEWORK_DEMO_HUMAN_INPUT_ID = "71000000-0000-4000-8000-000000000001";
export const FRAMEWORK_DEMO_TITLE = "Deterministic session";
export const FRAMEWORK_DEMO_DESCRIPTION =
  "Timeline, operator input, policy controls, attachments, and delivery";
export const FRAMEWORK_DEMO_MODELS = [
  "gpt-5.6-sol",
  "accounts/fireworks/models/glm-5p2",
] as const;

export type FrameworkDemoEventSpec = Readonly<{
  type: string;
  payload: unknown;
  turnId?: string | null;
}>;

export const FRAMEWORK_DEMO_EVENT_SPECS: readonly FrameworkDemoEventSpec[] = [
  { type: "session.created", payload: {} },
  {
    type: "user.message",
    payload: { text: "Review the infrastructure rollout and surface any unsafe assumption." },
    turnId: "turn-fixture",
  },
  { type: "session.status.changed", payload: { status: "running" } },
  {
    type: "agent.message.completed",
    payload: {
      text: "I verified the rollout receipts. One operator answer remains before completion.",
    },
    turnId: "turn-fixture",
  },
  {
    type: "agent.toolCall.created",
    payload: { id: "tool-1", name: "terraform_plan", arguments: { workspace: "production" } },
    turnId: "turn-fixture",
  },
  {
    type: "agent.toolCall.output",
    payload: {
      id: "tool-1",
      name: "terraform_plan",
      output: "Plan: 2 to add, 0 to change, 0 to destroy",
    },
    turnId: "turn-fixture",
  },
  {
    type: "goal.set",
    payload: { goal: { text: "Ship the verified framework-neutral session UI" } },
    turnId: "turn-fixture",
  },
  {
    type: "turn.startup.phase.completed",
    payload: { phase: "tools", durationMs: 350 },
    turnId: "turn-fixture",
  },
  {
    type: "sandbox.operation.started",
    payload: {
      name: "release-verification",
      command: "bun test packages/svelte/test",
      origin: "resumed",
    },
    turnId: "turn-fixture",
  },
  {
    type: "sandbox.command.output.delta",
    payload: { name: "release-verification", chunk: "14 tests passed\n" },
    turnId: "turn-fixture",
  },
  {
    type: "sandbox.operation.completed",
    payload: { name: "release-verification" },
    turnId: "turn-fixture",
  },
  {
    type: "session.requiresAction",
    payload: {
      approvals: [
        {
          id: "approval-1",
          name: "terraform_apply",
          arguments: { plan: "retained-plan-42" },
        },
      ],
    },
    turnId: "turn-fixture",
  },
] as const;

export function createFrameworkDemoHumanInputRequest(): SessionHumanInputRequest {
  const timestamp = "2026-08-29T12:00:00.000Z";
  return {
    id: FRAMEWORK_DEMO_HUMAN_INPUT_ID,
    workspaceId: FRAMEWORK_DEMO_WORKSPACE_ID,
    sessionId: FRAMEWORK_DEMO_SESSION_ID,
    turnId: "turn-fixture",
    turnGeneration: 1,
    creationAttemptId: "attempt-fixture",
    toolCallId: "tool-human-input",
    status: "pending",
    questions: [
      {
        id: "environment",
        kind: "single_select",
        label: "Choose the next environment",
        prompt: "Which deployment should OpenGeni inspect next?",
        helpText: "This structured request is identical in the React and Svelte demos.",
        options: [
          { id: "staging", label: "Staging", description: "Inspect the current candidate." },
          { id: "production", label: "Production", description: "Check live drift first." },
        ],
        required: true,
        allowOther: false,
      },
    ],
    allowSkip: false,
    response: null,
    respondedBy: null,
    respondedAt: null,
    expiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

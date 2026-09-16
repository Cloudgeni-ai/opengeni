import { expect, test } from "bun:test";
import {
  CreateScheduledTaskRequest,
  UpdateScheduledTaskRequest,
  CreateSessionRequest,
  SessionUserMessagePayload,
  SteerSessionMessageRequest,
  SubmitComposerDraftRequest,
} from "../src";

const task = {
  name: "Native connection schedule",
  schedule: { type: "manual" },
  agentConfig: { prompt: "Use the selected connection", tools: [] },
  connectionAccounts: [],
};

test("schedule contracts retain ordinary connection selection", () => {
  expect(CreateScheduledTaskRequest.parse(task).connectionAccounts).toEqual([]);
  expect(UpdateScheduledTaskRequest.parse({ connectionAccounts: [] }).connectionAccounts).toEqual(
    [],
  );
});

test.each([
  { selection: [] },
  { selection: [{ serverId: "example", delegationId: crypto.randomUUID(), generation: 1 }] },
])(
  "schedule contracts reject retired host selection without silently dropping it: %j",
  ({ selection: selectedHostMcpDelegations }) => {
    expect(
      CreateScheduledTaskRequest.safeParse({ ...task, selectedHostMcpDelegations }).success,
    ).toBe(false);
    expect(UpdateScheduledTaskRequest.safeParse({ selectedHostMcpDelegations }).success).toBe(
      false,
    );
  },
);

test.each([
  { name: "create", schema: CreateSessionRequest, payload: { initialMessage: "Read my account" } },
  { name: "send", schema: SessionUserMessagePayload, payload: { text: "Read my account" } },
  { name: "steer", schema: SteerSessionMessageRequest, payload: { text: "Read my account" } },
  {
    name: "composer",
    schema: SubmitComposerDraftRequest,
    payload: {
      text: "Read my account",
      annotations: [],
      resources: [],
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      expectedDraftRevision: 1,
      clientEventId: crypto.randomUUID(),
      delivery: "send",
    },
  },
])("session admission rejects retired host selection: $name", ({ schema, payload }) => {
  expect(schema.safeParse({ ...payload, connectionAccounts: [] }).success).toBe(true);
  expect(schema.safeParse({ ...payload, selectedHostMcpDelegations: [] }).success).toBe(false);
});

test("composer keeps accepting saved-draft metadata while rejecting obsolete selection", () => {
  const payload = {
    text: "Use the selected account",
    annotations: [],
    resources: [],
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    expectedDraftRevision: 1,
    clientEventId: crypto.randomUUID(),
    delivery: "send",
    revision: 1,
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: new Date().toISOString(),
  };
  expect(SubmitComposerDraftRequest.safeParse(payload).success).toBe(true);
  expect(
    SubmitComposerDraftRequest.safeParse({ ...payload, selectedHostMcpDelegations: [] }).success,
  ).toBe(false);
});

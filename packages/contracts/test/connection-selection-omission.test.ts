import { expect, test } from "bun:test";
import {
  CreateSessionRequest,
  CreateScheduledTaskRequest,
  SubmitComposerDraftRequest,
  SteerSessionMessageRequest,
} from "../src";

test("account choices default empty and obsolete conversation grants are rejected", () => {
  const cases = [
    [CreateSessionRequest, { initialMessage: "Use my connection" }],
    [SteerSessionMessageRequest, { text: "Continue" }],
    [
      SubmitComposerDraftRequest,
      {
        text: "Continue",
        annotations: [],
        resources: [],
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        expectedDraftRevision: 1,
        clientEventId: crypto.randomUUID(),
        delivery: "send",
      },
    ],
    [
      CreateScheduledTaskRequest,
      {
        name: "Connection task",
        schedule: { type: "manual" },
        agentConfig: { prompt: "Use my connection" },
      },
    ],
  ] as const;
  for (const [schema, input] of cases) {
    expect(schema.parse(input).connectionAccounts).toEqual([]);
    expect(schema.parse({ ...input, connectionAccounts: [] }).connectionAccounts).toEqual([]);
    expect(schema.safeParse({ ...input, connectionAuthorities: [] }).success).toBe(false);
  }
});

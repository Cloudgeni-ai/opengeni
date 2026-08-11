import { describe, expect, test } from "bun:test";
import type { SessionAuthorizationActor } from "@opengeni/contracts";
import { memorySlackPublicationActor } from "../src/mcp/server";

const sessionId = "11111111-1111-4111-8111-111111111111";
const rootSessionId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";

function attempt(
  input: Pick<
    Extract<SessionAuthorizationActor, { kind: "agent_attempt" }>,
    "initiator" | "initiatingHumanSubjectId"
  >,
): Extract<SessionAuthorizationActor, { kind: "agent_attempt" }> {
  return {
    kind: "agent_attempt",
    subjectId: "worker:memory-publication",
    callerSessionId: sessionId,
    callerRootSessionId: rootSessionId,
    turnId,
    attemptId,
    executionGeneration: 1,
    initiatorContext: {},
    ...input,
  };
}

describe("Memory Slack publication causal actor", () => {
  test("preserves direct human authority", () => {
    expect(
      memorySlackPublicationActor(
        attempt({
          initiator: { kind: "subject", subjectId: "user:owner", label: "Owner" },
          initiatingHumanSubjectId: "user:owner",
        }),
        sessionId,
        "Fallback owner",
      ),
    ).toEqual({
      actor: {
        kind: "human",
        subjectId: "user:owner",
        initiatingHumanSubjectId: "user:owner",
        sessionId,
        turnId,
        attemptId,
      },
      ownerLabel: "Owner",
    });
  });

  test("retains the causal human for delegated service and goal-continuation work", () => {
    expect(
      memorySlackPublicationActor(
        attempt({
          initiator: {
            kind: "service",
            subjectId: "goal-continuation",
            label: "OpenGeni goal continuation",
          },
          initiatingHumanSubjectId: "user:causal-owner",
        }),
        sessionId,
        null,
      ),
    ).toEqual({
      actor: {
        kind: "service",
        subjectId: "goal-continuation",
        initiatingHumanSubjectId: "user:causal-owner",
        sessionId,
        turnId,
        attemptId,
      },
      ownerLabel: "OpenGeni goal continuation",
    });
  });

  test("does not manufacture human authority for pure service work", () => {
    expect(
      memorySlackPublicationActor(
        attempt({
          initiator: { kind: "service", subjectId: "scheduler" },
          initiatingHumanSubjectId: null,
        }),
        sessionId,
        "Fallback service",
      ),
    ).toEqual({
      actor: {
        kind: "service",
        subjectId: "scheduler",
        initiatingHumanSubjectId: null,
        sessionId,
        turnId,
        attemptId,
      },
      ownerLabel: "Fallback service",
    });
  });
});

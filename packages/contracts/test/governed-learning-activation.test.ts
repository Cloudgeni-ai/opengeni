import { describe, expect, test } from "bun:test";
import {
  ActivateGovernedLearningDecisionRequest,
  GovernedLearningActivationCaller,
  UndoGovernedLearningActivationRequest,
} from "../src/governed-learning-activation";

describe("governed learning activation contracts", () => {
  test("accepts only exact bounded caller and operation identities", () => {
    expect(
      GovernedLearningActivationCaller.parse({
        workspaceId: crypto.randomUUID(),
        subjectId: "user:owner",
      }),
    ).toBeDefined();
    expect(() =>
      GovernedLearningActivationCaller.parse({
        workspaceId: crypto.randomUUID(),
        subjectId: "x".repeat(1_025),
      }),
    ).toThrow();
    expect(
      ActivateGovernedLearningDecisionRequest.parse({
        operationId: crypto.randomUUID(),
        decisionReceiptId: crypto.randomUUID(),
      }),
    ).toBeDefined();
    expect(
      UndoGovernedLearningActivationRequest.parse({
        operationId: crypto.randomUUID(),
        activationReceiptId: crypto.randomUUID(),
      }),
    ).toBeDefined();
  });
});

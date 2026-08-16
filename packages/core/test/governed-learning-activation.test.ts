import { describe, expect, test } from "bun:test";
import { createGovernedLearningActivationController } from "../src/domain/governed-learning-activation";

describe("governed learning activation controller", () => {
  test("validates the bounded transport-neutral request before delegation", async () => {
    let called = false;
    const controller = createGovernedLearningActivationController({
      db: {} as never,
      activate: (async (_db, input) => {
        called = true;
        expect(input.caller.subjectId).toBe("user:owner");
        return {} as never;
      }) as never,
    });
    await controller.activate({
      caller: { workspaceId: crypto.randomUUID(), subjectId: "user:owner" },
      request: { operationId: crypto.randomUUID(), decisionReceiptId: crypto.randomUUID() },
    });
    expect(called).toBe(true);
    await expect(
      controller.activate({
        caller: { workspaceId: "not-a-uuid", subjectId: "user:owner" },
        request: { operationId: crypto.randomUUID(), decisionReceiptId: crypto.randomUUID() },
      }),
    ).rejects.toThrow();
  });
});

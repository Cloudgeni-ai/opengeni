import { expect, test } from "bun:test";
import { createOperationReadAttemptToolDefinition } from "../src/activities/agent-turn/mcp-operation-read-tool";

const operationId = "11111111-1111-4111-8111-111111111111";
const sourceTurnId = "22222222-2222-4222-8222-222222222222";
const context = { operationId, caller: { kind: "model" as const, subjectId: "synthetic" } };

test("operation read forwards only the existing operation locator", async () => {
  const reads: unknown[] = [];
  const receipt = {
    operationId,
    invocationOutcome: "outcome_unknown",
    observation: { status: "unknown" },
  };
  const tool = createOperationReadAttemptToolDefinition({
    read: async (selector) => {
      reads.push(selector);
      return receipt;
    },
  });
  const result = await tool.execute({ operationId }, context);
  expect(reads).toEqual([{ operationId }]);
  expect(result.structuredContent).toEqual(receipt);
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(receipt) }]);
});

test("source lookup preserves exact arbitrary SDK call identity", async () => {
  const reads: unknown[] = [];
  const tool = createOperationReadAttemptToolDefinition({
    read: async (selector) => {
      reads.push(selector);
      return { observation: { status: "unknown" } };
    },
  });
  await tool.execute({ sourceTurnId, sourceCallId: "call-original" }, context);
  expect(reads).toEqual([{ sourceTurnId, sourceCallId: "call-original" }]);
});

for (const args of [
  {},
  { operationId: "not-a-uuid" },
  { operationId, destinationUrl: "https://untrusted.invalid" },
  { operationId, observerTool: "commit_value" },
  { operationId, arguments: { value: "replacement" } },
  { operationId, sourceTurnId, sourceCallId: "ambiguous-selector" },
  { sourceTurnId },
]) {
  test(`rejects caller-controlled recovery binding ${JSON.stringify(args)}`, async () => {
    let reads = 0;
    const tool = createOperationReadAttemptToolDefinition({
      read: async () => {
        reads++;
        return {};
      },
    });
    await expect(tool.execute(args, context)).rejects.toThrow();
    expect(reads).toBe(0);
  });
}

test("read failure does not retry the provider or synthesize a terminal result", async () => {
  let reads = 0;
  const denied = new Error("Operation is unavailable");
  const tool = createOperationReadAttemptToolDefinition({
    read: async () => {
      reads++;
      throw denied;
    },
  });
  await expect(tool.execute({ operationId }, context)).rejects.toBe(denied);
  expect(reads).toBe(1);
});

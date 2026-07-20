import { describe, expect, test } from "bun:test";
import { mcpMutationReceipt } from "../src/mcp/receipts";

describe("first-party MCP receipt builder", () => {
  test("defaults version, timestamp, and warnings without echoing mutation input", () => {
    const receipt = mcpMutationReceipt({
      operation: "goal_set",
      committed: true,
      outcome: "created",
      changed: true,
      resource: {
        type: "session_goal",
        id: "00000000-0000-4000-8000-000000000001",
        version: 1,
        state: "active",
      },
      idempotency: { status: "not_supported" },
      nextAction: {
        tool: "session_get",
        arguments: { sessionId: "00000000-0000-4000-8000-000000000002" },
      },
    });

    expect(receipt).toMatchObject({
      receiptVersion: "mcp-mutation-receipt.v1",
      operation: "goal_set",
      warnings: [],
    });
    expect(new Date(receipt.timestamp).toISOString()).toBe(receipt.timestamp);
    expect(JSON.stringify(receipt)).not.toContain("successCriteria");
  });

  test("fails closed when a handler attempts to add a full entity", () => {
    expect(() =>
      mcpMutationReceipt({
        operation: "memory_save",
        committed: true,
        outcome: "created",
        changed: true,
        resource: { type: "memory", id: "00000000-0000-4000-8000-000000000003" },
        idempotency: { status: "not_supported" },
        // The cast models an accidental handler extension across a dynamic seam.
        entity: { text: "must not enter the receipt" },
      } as Parameters<typeof mcpMutationReceipt>[0]),
    ).toThrow();
  });
});

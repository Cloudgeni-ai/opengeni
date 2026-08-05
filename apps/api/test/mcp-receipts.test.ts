import { describe, expect, test } from "bun:test";
import {
  mcpMutationReceipt,
  sessionCreateMutationReceipt,
  type SessionCreateReceiptResult,
} from "../src/mcp/receipts";

const sessionCreateResult = {
  session: {
    id: "00000000-0000-4000-8000-000000000004",
    queueVersion: 1,
    status: "queued",
    sandboxGroupId: "00000000-0000-4000-8000-000000000004",
    parentSessionId: null,
    rootSessionId: "00000000-0000-4000-8000-000000000004",
    nestedAgentDepth: 0,
    effectiveMaxNestedAgentDepth: 3,
  },
  outcome: "created",
  changed: true,
  usageRecording: "recorded",
} satisfies SessionCreateReceiptResult;

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

  test("maps an applied session repair separately from a replay", () => {
    expect(
      sessionCreateMutationReceipt(
        { ...sessionCreateResult, outcome: "repaired", changed: true },
        true,
      ),
    ).toMatchObject({
      outcome: "repaired",
      changed: true,
      idempotency: { status: "applied" },
      facts: { sessionCreateOutcome: "repaired" },
      id: sessionCreateResult.session.id,
      rootSessionId: sessionCreateResult.session.rootSessionId,
      nestedAgentDepth: 0,
      effectiveMaxNestedAgentDepth: 3,
    });
  });

  test("makes a committed keyless usage failure explicitly non-retryable", () => {
    expect(
      sessionCreateMutationReceipt({ ...sessionCreateResult, usageRecording: "failed" }, false),
    ).toMatchObject({
      committed: true,
      outcome: "partial_failure",
      changed: true,
      idempotency: { status: "not_requested" },
      partialFailure: { stage: "usage_recording", retryable: false },
      warnings: [expect.stringContaining("Do not retry this keyless request")],
    });
  });

  test("preserves pure replay truth when keyed usage recording also fails", () => {
    expect(
      sessionCreateMutationReceipt({ ...sessionCreateResult, usageRecording: "failed" }, true),
    ).toMatchObject({
      committed: true,
      outcome: "partial_failure",
      changed: true,
      idempotency: { status: "applied" },
      partialFailure: { stage: "usage_recording", retryable: true },
      warnings: [expect.stringContaining("same idempotency key")],
      facts: { sessionCreateOutcome: "created" },
    });

    expect(
      sessionCreateMutationReceipt(
        {
          ...sessionCreateResult,
          outcome: "repaired",
          changed: true,
          usageRecording: "failed",
        },
        true,
      ),
    ).toMatchObject({
      committed: true,
      outcome: "partial_failure",
      changed: true,
      idempotency: { status: "applied" },
      partialFailure: { stage: "usage_recording", retryable: true },
      facts: { sessionCreateOutcome: "repaired" },
    });

    expect(
      sessionCreateMutationReceipt(
        {
          ...sessionCreateResult,
          outcome: "replayed",
          changed: false,
          usageRecording: "failed",
        },
        true,
      ),
    ).toMatchObject({
      committed: true,
      outcome: "partial_failure",
      changed: false,
      idempotency: { status: "replayed" },
      partialFailure: { stage: "usage_recording", retryable: true },
      warnings: [expect.stringContaining("same idempotency key")],
      facts: { sessionCreateOutcome: "replayed" },
    });
  });
});

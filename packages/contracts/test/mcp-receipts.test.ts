import { describe, expect, test } from "bun:test";
import {
  MCP_MUTATION_RECEIPT_VERSION,
  McpMutationReceipt,
  type McpMutationReceiptType,
} from "../src";

const baseReceipt = {
  receiptVersion: MCP_MUTATION_RECEIPT_VERSION,
  operation: "scheduled_tasks_update",
  committed: true,
  outcome: "updated",
  changed: true,
  resource: {
    type: "scheduled_task",
    id: "00000000-0000-4000-8000-000000000001",
    version: 4,
    state: "active",
  },
  timestamp: "2026-07-20T00:00:00.000Z",
  idempotency: { status: "not_supported" },
  warnings: [],
  nextAction: {
    tool: "scheduled_tasks_get",
    arguments: { id: "00000000-0000-4000-8000-000000000001" },
  },
} satisfies McpMutationReceiptType;

describe("MCP mutation receipt contract", () => {
  test("accepts a compact versioned mutation receipt", () => {
    expect(McpMutationReceipt.parse(baseReceipt)).toEqual(baseReceipt);
  });

  test("represents idempotent replay without claiming a new change", () => {
    const replay = McpMutationReceipt.parse({
      ...baseReceipt,
      operation: "session_create",
      outcome: "replayed",
      changed: false,
      resource: { type: "session", id: "00000000-0000-4000-8000-000000000002" },
      idempotency: { status: "replayed" },
      nextAction: {
        tool: "session_get",
        arguments: { sessionId: "00000000-0000-4000-8000-000000000002" },
      },
    });
    expect(replay.outcome).toBe("replayed");
  });

  test("requires truthful partial-commit failure facts", () => {
    expect(
      McpMutationReceipt.parse({
        ...baseReceipt,
        outcome: "partial_failure",
        partialFailure: { stage: "schedule_sync", retryable: true },
        warnings: ["The database mutation committed; schedule synchronization failed."],
      }),
    ).toMatchObject({ committed: true, outcome: "partial_failure" });

    expect(() =>
      McpMutationReceipt.parse({ ...baseReceipt, outcome: "partial_failure" }),
    ).toThrow();
    expect(() =>
      McpMutationReceipt.parse({
        ...baseReceipt,
        committed: false,
        outcome: "partial_failure",
        partialFailure: { stage: "schedule_sync", retryable: true },
      }),
    ).toThrow();
  });

  test("rejects success-shaped receipts for noncommitted operations", () => {
    expect(() =>
      McpMutationReceipt.parse({
        ...baseReceipt,
        committed: false,
      }),
    ).toThrow();
  });

  test("rejects request-shaped or unbounded fields", () => {
    expect(() =>
      McpMutationReceipt.parse({
        ...baseReceipt,
        prompt: "already known request text",
      }),
    ).toThrow();
    expect(() =>
      McpMutationReceipt.parse({
        ...baseReceipt,
        nextAction: {
          tool: "scheduled_tasks_get",
          arguments: { agentConfig: { prompt: "nested request echo" } },
        },
      }),
    ).toThrow();
    expect(() =>
      McpMutationReceipt.parse({
        ...baseReceipt,
        warnings: ["x".repeat(513)],
      }),
    ).toThrow();
  });

  test("rejects contradictory unchanged and replay outcomes", () => {
    expect(() =>
      McpMutationReceipt.parse({ ...baseReceipt, outcome: "unchanged", changed: true }),
    ).toThrow();
    expect(() =>
      McpMutationReceipt.parse({
        ...baseReceipt,
        outcome: "replayed",
        changed: false,
        idempotency: { status: "applied" },
      }),
    ).toThrow();
  });
});

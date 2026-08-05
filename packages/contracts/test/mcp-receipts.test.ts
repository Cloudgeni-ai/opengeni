import { describe, expect, test } from "bun:test";
import {
  MCP_MUTATION_RECEIPT_MAX_BYTES,
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

const sessionCreateCompatibility = {
  id: "00000000-0000-4000-8000-000000000002",
  rootSessionId: "00000000-0000-4000-8000-000000000002",
  nestedAgentDepth: 0,
  effectiveMaxNestedAgentDepth: 3,
} as const;

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
      ...sessionCreateCompatibility,
      nextAction: {
        tool: "session_get",
        arguments: { sessionId: "00000000-0000-4000-8000-000000000002" },
      },
    });
    expect(replay.outcome).toBe("replayed");
  });

  test("distinguishes an applied repair from a pure replay", () => {
    expect(
      McpMutationReceipt.parse({
        ...baseReceipt,
        operation: "session_create",
        outcome: "repaired",
        changed: true,
        resource: { type: "session", id: "00000000-0000-4000-8000-000000000002" },
        idempotency: { status: "applied" },
        ...sessionCreateCompatibility,
      }),
    ).toMatchObject({ outcome: "repaired", changed: true });

    expect(() =>
      McpMutationReceipt.parse({
        ...baseReceipt,
        outcome: "repaired",
        changed: false,
        idempotency: { status: "applied" },
      }),
    ).toThrow();
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

    expect(
      McpMutationReceipt.parse({
        ...baseReceipt,
        operation: "session_create",
        outcome: "partial_failure",
        changed: false,
        resource: { type: "session", id: sessionCreateCompatibility.id },
        idempotency: { status: "replayed" },
        ...sessionCreateCompatibility,
        partialFailure: { stage: "usage_recording", retryable: true },
        warnings: ["Retry only with the same idempotency key."],
      }),
    ).toMatchObject({
      outcome: "partial_failure",
      changed: false,
      idempotency: { status: "replayed" },
    });
  });

  test("requires exact bounded session compatibility aliases", () => {
    expect(() =>
      McpMutationReceipt.parse({
        ...baseReceipt,
        operation: "session_create",
        resource: { type: "session", id: sessionCreateCompatibility.id },
      }),
    ).toThrow();

    expect(() =>
      McpMutationReceipt.parse({
        ...baseReceipt,
        operation: "session_create",
        resource: { type: "session", id: sessionCreateCompatibility.id },
        ...sessionCreateCompatibility,
        id: "00000000-0000-4000-8000-000000000099",
      }),
    ).toThrow();

    expect(
      McpMutationReceipt.parse({
        ...baseReceipt,
        operation: "session_steer",
        resource: { type: "session_system_update", id: sessionCreateCompatibility.id },
        updateId: sessionCreateCompatibility.id,
      }),
    ).toMatchObject({ updateId: sessionCreateCompatibility.id });

    expect(() =>
      McpMutationReceipt.parse({
        ...baseReceipt,
        operation: "session_steer",
        resource: { type: "session_system_update", id: sessionCreateCompatibility.id },
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

  test("bounds strings and the full envelope by serialized UTF-8 bytes", () => {
    expect(() =>
      McpMutationReceipt.parse({
        ...baseReceipt,
        warnings: ["界".repeat(512)],
      }),
    ).toThrow();

    const escapedMaximum = {
      ...baseReceipt,
      operation: "\0".repeat(128),
      outcome: "partial_failure",
      resource: {
        type: "\0".repeat(128),
        id: "\0".repeat(256),
        version: "\0".repeat(128),
        etag: "\0".repeat(512),
        state: "\0".repeat(128),
      },
      relatedResources: Array.from({ length: 8 }, () => ({
        type: "\0".repeat(128),
        id: "\0".repeat(256),
        version: "\0".repeat(128),
        etag: "\0".repeat(512),
        state: "\0".repeat(128),
      })),
      partialFailure: { stage: "\0".repeat(128), retryable: false },
      warnings: Array.from({ length: 20 }, () => "\0".repeat(512)),
      facts: Object.fromEntries(
        Array.from({ length: 16 }, (_, index) => [`fact${index}`, "\0".repeat(512)]),
      ),
      nextAction: {
        tool: "\0".repeat(128),
        arguments: Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [`arg${index}`, "\0".repeat(512)]),
        ),
      },
    };
    expect(Buffer.byteLength(JSON.stringify(escapedMaximum, null, 2), "utf8")).toBeGreaterThan(
      MCP_MUTATION_RECEIPT_MAX_BYTES,
    );
    expect(() => McpMutationReceipt.parse(escapedMaximum)).toThrow();
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

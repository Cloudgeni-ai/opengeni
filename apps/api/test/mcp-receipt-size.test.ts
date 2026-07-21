import { describe, expect, test } from "bun:test";
import { MCP_MUTATION_RECEIPT_MAX_BYTES } from "@opengeni/contracts";
import { mcpMutationReceipt } from "../src/mcp/receipts";

const ID = "11111111-1111-4111-8111-111111111111";
const RELATED_ID = "22222222-2222-4222-8222-222222222222";
const TIMESTAMP = "2026-07-20T00:00:00.000Z";

const utf8Bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");

const exactUtf8String = (bytes: number): string => {
  const glyph = "界";
  const glyphBytes = Buffer.byteLength(glyph, "utf8");
  const glyphCount = Math.floor(bytes / glyphBytes);
  return `${glyph.repeat(glyphCount)}${"x".repeat(bytes - glyphCount * glyphBytes)}`;
};

type SizeCase = {
  name: string;
  request: unknown;
  legacyResponse: unknown;
  receipt: unknown;
  duplicatedInputBytes: number;
};

function sizeCases(): SizeCase[] {
  const large32KiB = exactUtf8String(32 * 1024);
  const memoryText = exactUtf8String(4_000);
  const rigCommand = exactUtf8String(8_192);
  const rigNote = exactUtf8String(2_000);

  const sessionRequest = {
    initialMessage: large32KiB,
    instructions: large32KiB,
    model: "gpt-5-codex",
  };
  const sessionLegacy = {
    id: ID,
    workspaceId: RELATED_ID,
    initialMessage: sessionRequest.initialMessage,
    instructions: sessionRequest.instructions,
    resources: [],
    tools: [],
    metadata: { model: sessionRequest.model },
    model: sessionRequest.model,
    status: "queued",
    queueVersion: 1,
    temporalWorkflowId: `session-${ID}`,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  const sessionReceipt = mcpMutationReceipt({
    operation: "session_create",
    committed: true,
    outcome: "created",
    changed: true,
    resource: { type: "session", id: ID, version: 1, state: "queued" },
    timestamp: TIMESTAMP,
    idempotency: { status: "not_requested" },
    facts: { sandboxGroupId: ID, parentSessionId: null },
    nextAction: { tool: "session_get", arguments: { sessionId: ID } },
  });

  const scheduledRequest = {
    name: "pathological scheduled task",
    schedule: { type: "interval", everySeconds: 3600 },
    agentConfig: {
      prompt: large32KiB,
      resources: Array.from({ length: 100 }, (_, index) => ({
        kind: "repository",
        id: `${ID}:${index}`,
        name: exactUtf8String(200),
      })),
      tools: Array.from({ length: 100 }, (_, index) => ({
        kind: "mcp",
        name: `tool-${index}-${exactUtf8String(200)}`,
      })),
    },
    metadata: Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`key-${index}`, exactUtf8String(200)]),
    ),
  };
  const scheduledLegacy = {
    id: ID,
    workspaceId: RELATED_ID,
    ...scheduledRequest,
    status: "active",
    runMode: "fresh_session",
    overlapPolicy: "skip",
    temporalScheduleId: `scheduled-task-${ID}`,
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  const scheduledReceipt = mcpMutationReceipt({
    operation: "scheduled_tasks_create",
    committed: true,
    outcome: "created",
    changed: true,
    resource: { type: "scheduled_task", id: ID, version: 1, state: "active" },
    timestamp: TIMESTAMP,
    idempotency: { status: "not_supported" },
    nextAction: { tool: "scheduled_tasks_get", arguments: { id: ID } },
  });

  const goalRequest = { text: large32KiB, evidence: large32KiB, rationale: large32KiB };
  const goalLegacy = {
    id: ID,
    sessionId: RELATED_ID,
    status: "completed",
    ...goalRequest,
    successCriteria: large32KiB,
    version: 4,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  const goalReceipt = mcpMutationReceipt({
    operation: "goal_complete",
    committed: true,
    outcome: "updated",
    changed: true,
    resource: { type: "session_goal", id: ID, version: 4, state: "completed" },
    timestamp: TIMESTAMP,
    idempotency: { status: "not_supported" },
    nextAction: { tool: "session_get", arguments: { sessionId: RELATED_ID } },
  });

  const memoryRequest = { text: memoryText, kind: "semantic", confidence: 0.9 };
  const memoryLegacy = {
    memory: {
      id: ID,
      workspaceId: RELATED_ID,
      status: "active",
      ...memoryRequest,
      scope: "workspace",
      sourceRefs: [],
      metadata: { origin: "agent" },
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    deduped: false,
  };
  const memoryReceipt = mcpMutationReceipt({
    operation: "memory_save",
    committed: true,
    outcome: "created",
    changed: true,
    resource: { type: "knowledge_memory", id: ID, state: "active" },
    timestamp: TIMESTAMP,
    idempotency: { status: "not_supported" },
    facts: { deduped: false },
    nextAction: { tool: "memory_search", arguments: { query: ID } },
  });

  const rigRequest = { rigId: RELATED_ID, command: rigCommand, note: rigNote };
  const rigLegacy = {
    change: {
      id: ID,
      rigId: RELATED_ID,
      kind: "setup_append",
      payload: { command: rigCommand, note: rigNote },
      status: "verifying",
      proposedBy: "session:test",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    verificationStarted: true,
  };
  const rigReceipt = mcpMutationReceipt({
    operation: "rig_propose_change",
    committed: true,
    outcome: "created",
    changed: true,
    resource: { type: "rig_change", id: ID, version: TIMESTAMP, state: "verifying" },
    relatedResources: [{ type: "rig", id: RELATED_ID }],
    timestamp: TIMESTAMP,
    idempotency: { status: "not_supported" },
    facts: { verificationStarted: true, verificationAttempt: 1 },
    nextAction: { tool: "rig_get", arguments: { rigId: RELATED_ID } },
  });

  return [
    {
      name: "session_create",
      request: sessionRequest,
      legacyResponse: sessionLegacy,
      receipt: sessionReceipt,
      duplicatedInputBytes:
        Buffer.byteLength(sessionRequest.initialMessage, "utf8") +
        Buffer.byteLength(sessionRequest.instructions, "utf8"),
    },
    {
      name: "scheduled_tasks_create",
      request: scheduledRequest,
      legacyResponse: scheduledLegacy,
      receipt: scheduledReceipt,
      duplicatedInputBytes:
        utf8Bytes(scheduledRequest.agentConfig) + utf8Bytes(scheduledRequest.metadata),
    },
    {
      name: "goal_complete",
      request: goalRequest,
      legacyResponse: goalLegacy,
      receipt: goalReceipt,
      duplicatedInputBytes:
        Buffer.byteLength(goalRequest.text, "utf8") +
        Buffer.byteLength(goalRequest.evidence, "utf8") +
        Buffer.byteLength(goalRequest.rationale, "utf8"),
    },
    {
      name: "memory_save",
      request: memoryRequest,
      legacyResponse: memoryLegacy,
      receipt: memoryReceipt,
      duplicatedInputBytes: Buffer.byteLength(memoryRequest.text, "utf8"),
    },
    {
      name: "rig_propose_change",
      request: rigRequest,
      legacyResponse: rigLegacy,
      receipt: rigReceipt,
      duplicatedInputBytes:
        Buffer.byteLength(rigRequest.command, "utf8") + Buffer.byteLength(rigRequest.note, "utf8"),
    },
  ];
}

describe("MCP receipt response size", () => {
  test("removes pathological request echoes from mutation results", () => {
    for (const fixture of sizeCases()) {
      const legacyBytes = utf8Bytes(fixture.legacyResponse);
      const receiptBytes = utf8Bytes(fixture.receipt);
      expect(receiptBytes).toBeLessThan(legacyBytes * 0.15);
      expect(JSON.stringify(fixture.receipt)).not.toContain(exactUtf8String(256));
      expect(fixture.duplicatedInputBytes).toBeGreaterThan(receiptBytes);
    }
  });

  test("shrinks the same session result in model history, events, and realtime transport", () => {
    const session = sizeCases()[0]!;
    const projections = (result: unknown) => ({
      modelHistory: { role: "tool", content: JSON.stringify(result) },
      event: { type: "agent.toolCall.output", payload: { output: result } },
      realtime: `event: session.event\ndata: ${JSON.stringify({ output: result })}\n\n`,
    });
    const legacy = projections(session.legacyResponse);
    const receipt = projections(session.receipt);
    for (const surface of ["modelHistory", "event", "realtime"] as const) {
      expect(utf8Bytes(receipt[surface])).toBeLessThan(utf8Bytes(legacy[surface]) * 0.02);
    }
  });

  test("the maximum ASCII contract-shaped receipt remains below the canonical envelope", () => {
    const maximum = mcpMutationReceipt({
      operation: "x".repeat(128),
      committed: true,
      outcome: "partial_failure",
      changed: true,
      resource: {
        type: "x".repeat(128),
        id: "x".repeat(256),
        version: "x".repeat(128),
        etag: "x".repeat(512),
        state: "x".repeat(128),
      },
      relatedResources: Array.from({ length: 8 }, (_, index) => ({
        type: "x".repeat(128),
        id: `${index}${"x".repeat(255)}`,
        version: "x".repeat(128),
        etag: "x".repeat(512),
        state: "x".repeat(128),
      })),
      timestamp: TIMESTAMP,
      idempotency: { status: "not_supported" },
      partialFailure: { stage: "x".repeat(128), retryable: true },
      warnings: Array.from({ length: 20 }, () => "x".repeat(512)),
      facts: Object.fromEntries(
        Array.from({ length: 16 }, (_, index) => [`fact${index}`, "x".repeat(512)]),
      ),
      nextAction: {
        tool: "x".repeat(128),
        arguments: Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [`arg${index}`, "x".repeat(512)]),
        ),
      },
    });
    expect(utf8Bytes(maximum)).toBeLessThanOrEqual(MCP_MUTATION_RECEIPT_MAX_BYTES);
  });

  test("a valid multibyte maximum is bounded by UTF-8 bytes", () => {
    const maximum = mcpMutationReceipt({
      operation: exactUtf8String(128),
      committed: true,
      outcome: "partial_failure",
      changed: true,
      resource: {
        type: exactUtf8String(128),
        id: exactUtf8String(256),
        version: exactUtf8String(128),
        etag: exactUtf8String(512),
        state: exactUtf8String(128),
      },
      relatedResources: Array.from({ length: 8 }, (_, index) => ({
        type: exactUtf8String(128),
        id: `${index}${exactUtf8String(255)}`,
        version: exactUtf8String(128),
        etag: exactUtf8String(512),
        state: exactUtf8String(128),
      })),
      timestamp: TIMESTAMP,
      idempotency: { status: "not_supported" },
      partialFailure: { stage: exactUtf8String(128), retryable: true },
      warnings: Array.from({ length: 20 }, () => exactUtf8String(512)),
      facts: Object.fromEntries(
        Array.from({ length: 16 }, (_, index) => [`fact${index}`, exactUtf8String(512)]),
      ),
      nextAction: {
        tool: exactUtf8String(128),
        arguments: Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [`arg${index}`, exactUtf8String(512)]),
        ),
      },
    });
    expect(utf8Bytes(maximum)).toBeLessThanOrEqual(MCP_MUTATION_RECEIPT_MAX_BYTES);
  });

  test("rejects a code-unit maximum that exceeds its UTF-8 byte limit", () => {
    expect(() =>
      mcpMutationReceipt({
        operation: "session_create",
        committed: true,
        outcome: "created",
        changed: true,
        resource: { type: "session", id: ID },
        timestamp: TIMESTAMP,
        idempotency: { status: "not_requested" },
        warnings: ["界".repeat(512)],
      }),
    ).toThrow();
  });

  test("keeps repaired and committed partial-failure session receipts compact", () => {
    const repaired = mcpMutationReceipt({
      operation: "session_create",
      committed: true,
      outcome: "repaired",
      changed: true,
      resource: { type: "session", id: ID, version: 1, state: "queued" },
      timestamp: TIMESTAMP,
      idempotency: { status: "applied" },
      facts: { sessionCreateOutcome: "repaired" },
      nextAction: { tool: "session_get", arguments: { sessionId: ID } },
    });
    const partialFailure = mcpMutationReceipt({
      operation: "session_create",
      committed: true,
      outcome: "partial_failure",
      changed: true,
      resource: { type: "session", id: ID, version: 1, state: "queued" },
      timestamp: TIMESTAMP,
      idempotency: { status: "not_requested" },
      partialFailure: { stage: "usage_recording", retryable: false },
      warnings: [
        "The session committed, but usage recording failed. Do not retry this keyless request; inspect the returned session.",
      ],
      facts: { sessionCreateOutcome: "created" },
      nextAction: { tool: "session_get", arguments: { sessionId: ID } },
    });
    expect(utf8Bytes(repaired)).toBeLessThanOrEqual(MCP_MUTATION_RECEIPT_MAX_BYTES);
    expect(utf8Bytes(partialFailure)).toBeLessThanOrEqual(MCP_MUTATION_RECEIPT_MAX_BYTES);
  });
});

export function measuredReceiptSizes(): Array<{
  name: string;
  requestBytes: number;
  duplicatedInputBytes: number;
  legacyBytes: number;
  receiptBytes: number;
  approximateLegacyTokens: number;
  approximateReceiptTokens: number;
  reductionPercent: number;
}> {
  return sizeCases().map((fixture) => {
    const legacyBytes = utf8Bytes(fixture.legacyResponse);
    const receiptBytes = utf8Bytes(fixture.receipt);
    return {
      name: fixture.name,
      requestBytes: utf8Bytes(fixture.request),
      duplicatedInputBytes: fixture.duplicatedInputBytes,
      legacyBytes,
      receiptBytes,
      approximateLegacyTokens: Math.ceil(legacyBytes / 4),
      approximateReceiptTokens: Math.ceil(receiptBytes / 4),
      reductionPercent: Number((((legacyBytes - receiptBytes) / legacyBytes) * 100).toFixed(2)),
    };
  });
}

export function measuredProjectionSizes(): Array<{
  surface: "modelHistory" | "event" | "realtime";
  legacyBytes: number;
  receiptBytes: number;
  reductionPercent: number;
}> {
  const session = sizeCases()[0]!;
  const projections = (result: unknown) => ({
    modelHistory: { role: "tool", content: JSON.stringify(result) },
    event: { type: "agent.toolCall.output", payload: { output: result } },
    realtime: `event: session.event\ndata: ${JSON.stringify({ output: result })}\n\n`,
  });
  const legacy = projections(session.legacyResponse);
  const receipt = projections(session.receipt);
  return (["modelHistory", "event", "realtime"] as const).map((surface) => {
    const legacyBytes = utf8Bytes(legacy[surface]);
    const receiptBytes = utf8Bytes(receipt[surface]);
    return {
      surface,
      legacyBytes,
      receiptBytes,
      reductionPercent: Number((((legacyBytes - receiptBytes) / legacyBytes) * 100).toFixed(2)),
    };
  });
}

if (process.env.OPENGENI_PRINT_MCP_RECEIPT_SIZES === "1") {
  console.table(measuredReceiptSizes());
  console.table(measuredProjectionSizes());
}

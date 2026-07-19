import { describe, expect, test } from "bun:test";
import type { TurnPersistenceObligation } from "../src/activities/types";
import {
  prepareTurnPersistenceHandoff,
  TURN_PERSISTENCE_HANDOFF_MAX_BYTES,
} from "../src/turn-persistence-handoff";
import { turnPersistenceHandoffFromHeartbeat } from "../src/workflows/session";

const ids = {
  turnId: "44444444-4444-4444-8444-444444444444",
  triggerEventId: "55555555-5555-4555-8555-555555555555",
  attemptId: "66666666-6666-4666-8666-666666666666",
};

const pendingToolObligation: TurnPersistenceObligation = {
  kind: "pending_tool_call",
  callId: "call-1",
  callType: "function_call",
  callItem: {
    type: "function_call",
    callId: "call-1",
    name: "mutate_external_state",
    arguments: '{"secret":"must-stay-in-postgres"}',
  },
};

const modelObligation: TurnPersistenceObligation = {
  kind: "model_call",
  history: {
    producerCodexCredentialId: null,
    modelToolOutputTruncationTokens: 4096,
    items: [
      {
        position: 4,
        item: { type: "message", role: "assistant", content: "completed response body" },
      },
    ],
  },
  metering: {
    model: "gpt-5.6-sol",
    isCodexTurn: false,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    sourceKey: "resp-1",
  },
  event: {
    type: "agent.model.usage",
    payload: {
      turnId: ids.turnId,
      model: "gpt-5.6-sol",
      sourceKey: "resp-1",
      inputTokens: 10,
      outputTokens: 2,
    },
    turnId: ids.turnId,
    producerId: `turn-attempt:${ids.attemptId}`,
    producerSeq: 17,
    occurredAt: "2026-07-18T22:22:36.000Z",
  },
};

const compactionObligation: TurnPersistenceObligation = {
  kind: "context_compaction",
  metering: modelObligation.kind === "model_call" ? modelObligation.metering : null,
  event: modelObligation.kind === "model_call" ? modelObligation.event : null,
  compaction: {
    action: "apply",
    persistenceKey: "compaction-1",
    replacementItems: [{ type: "message", role: "user", content: "raw retained history" }],
    summaryItem: { type: "message", role: "user", content: "raw durable summary" },
    replacementInputTokens: 20,
    clearRequestedCompaction: false,
    occurredAt: "2026-07-18T22:22:36.000Z",
    eventPayload: {
      persistenceKey: "compaction-1",
      trigger: "auto",
      replacementFingerprint: "fingerprint-1",
    },
    result: {
      signalTokens: 250_000,
      thresholdTokens: 244_800,
      estimatedTokensBefore: 240_000,
      estimatedTokensAfter: 20,
      replacementFingerprint: "fingerprint-1",
    },
  },
};

function prepare(obligation: TurnPersistenceObligation) {
  return prepareTurnPersistenceHandoff({
    ...ids,
    executionGeneration: 3,
    obligation,
  }).handoff;
}

describe("turn persistence heartbeat handoff", () => {
  test("accepts each exact bounded receipt reference", () => {
    for (const obligation of [pendingToolObligation, modelObligation, compactionObligation]) {
      const handoff = prepare(obligation);
      expect(turnPersistenceHandoffFromHeartbeat({ persistenceHandoff: handoff })).toEqual(handoff);
      expect(Buffer.byteLength(JSON.stringify(handoff), "utf8")).toBeLessThanOrEqual(
        TURN_PERSISTENCE_HANDOFF_MAX_BYTES,
      );
    }
  });

  test("keeps raw provider, tool, and compaction content out of Temporal payloads", () => {
    const serialized = [pendingToolObligation, modelObligation, compactionObligation]
      .map((obligation) => JSON.stringify(prepare(obligation)))
      .join("\n");

    expect(serialized).not.toContain("mutate_external_state");
    expect(serialized).not.toContain("must-stay-in-postgres");
    expect(serialized).not.toContain("completed response body");
    expect(serialized).not.toContain("raw retained history");
    expect(serialized).not.toContain("raw durable summary");
  });

  test("distinguishes absent evidence from malformed evidence", () => {
    expect(turnPersistenceHandoffFromHeartbeat(null)).toBeNull();
    expect(turnPersistenceHandoffFromHeartbeat({})).toBeNull();

    const handoff = prepare(pendingToolObligation);
    expect(
      turnPersistenceHandoffFromHeartbeat({
        persistenceHandoff: {
          version: 1,
          turnId: ids.turnId,
          triggerEventId: ids.triggerEventId,
          executionGeneration: 3,
          obligation: pendingToolObligation,
        },
      }),
    ).toBeNull();
    expect(
      turnPersistenceHandoffFromHeartbeat({
        persistenceHandoff: { ...handoff, version: 3 },
      }),
    ).toBeNull();
  });

  test("rejects malformed identity, digest, kind, and generation fields", () => {
    const handoff = prepare(modelObligation);
    const malformed = [
      { ...handoff, receiptId: "not-a-uuid" },
      { ...handoff, turnId: "not-a-uuid" },
      { ...handoff, triggerEventId: "not-a-uuid" },
      { ...handoff, attemptId: "not-a-uuid" },
      { ...handoff, executionGeneration: 0 },
      { ...handoff, obligationKind: "provider_call" },
      { ...handoff, obligationDigest: "f".repeat(63) },
      { ...handoff, obligationDigest: "F".repeat(64) },
    ];

    for (const persistenceHandoff of malformed) {
      expect(turnPersistenceHandoffFromHeartbeat({ persistenceHandoff })).toBeNull();
    }
  });

  test("rejects extra and oversized fields instead of carrying untyped history data", () => {
    const handoff = prepare(compactionObligation);
    expect(
      turnPersistenceHandoffFromHeartbeat({
        persistenceHandoff: { ...handoff, obligation: compactionObligation },
      }),
    ).toBeNull();
    expect(
      turnPersistenceHandoffFromHeartbeat({
        persistenceHandoff: { ...handoff, padding: "x".repeat(2_000) },
      }),
    ).toBeNull();
  });
});

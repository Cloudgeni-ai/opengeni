import { describe, expect, test } from "bun:test";
import { turnPersistenceHandoffFromHeartbeat } from "../src/workflows/session";

const handoff = {
  version: 1 as const,
  turnId: "turn-1",
  triggerEventId: "trigger-1",
  executionGeneration: 3,
  obligation: {
    kind: "pending_tool_call" as const,
    callId: "call-1",
    callType: "function_call",
    callItem: { type: "function_call", callId: "call-1", name: "write", arguments: "{}" },
  },
};

const modelHandoff = {
  version: 1 as const,
  turnId: "turn-1",
  triggerEventId: "trigger-1",
  executionGeneration: 3,
  obligation: {
    kind: "model_call" as const,
    history: {
      producerCodexCredentialId: null,
      modelToolOutputTruncationTokens: 4096,
      items: [{ position: 4, item: { type: "message", role: "assistant", content: "done" } }],
    },
    metering: {
      model: "gpt-5.6-sol",
      isCodexTurn: false,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      sourceKey: "resp-1",
    },
    event: {
      type: "agent.model.usage" as const,
      payload: {
        turnId: "turn-1",
        model: "gpt-5.6-sol",
        sourceKey: "resp-1",
        inputTokens: 10,
        outputTokens: 2,
      },
      turnId: "turn-1",
      producerId: "workflow:turn:activity",
      producerSeq: 17,
      occurredAt: "2026-07-18T22:22:36.000Z",
    },
  },
};

const compactionHandoff = {
  version: 1 as const,
  turnId: "turn-1",
  triggerEventId: "trigger-1",
  executionGeneration: 3,
  obligation: {
    kind: "context_compaction" as const,
    metering: modelHandoff.obligation.metering,
    event: modelHandoff.obligation.event,
    compaction: {
      action: "apply" as const,
      persistenceKey: "compaction-1",
      replacementItems: [{ type: "message", role: "user", content: "keep" }],
      summaryItem: { type: "message", role: "user", content: "summary" },
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
  },
};

describe("turn persistence heartbeat handoff", () => {
  test("accepts the exact versioned pending-call payload", () => {
    expect(turnPersistenceHandoffFromHeartbeat({ persistenceHandoff: handoff })).toEqual(handoff);
  });

  test("accepts a serializable completed-model persistence payload", () => {
    expect(turnPersistenceHandoffFromHeartbeat({ persistenceHandoff: modelHandoff })).toEqual(
      modelHandoff,
    );
  });

  test("accepts the exact prepared compaction payload", () => {
    expect(turnPersistenceHandoffFromHeartbeat({ persistenceHandoff: compactionHandoff })).toEqual(
      compactionHandoff,
    );
  });

  test("rejects malformed or future-version payloads", () => {
    expect(turnPersistenceHandoffFromHeartbeat(null)).toBeNull();
    expect(
      turnPersistenceHandoffFromHeartbeat({
        persistenceHandoff: { ...handoff, version: 2 },
      }),
    ).toBeNull();
    expect(
      turnPersistenceHandoffFromHeartbeat({
        persistenceHandoff: {
          ...modelHandoff,
          obligation: {
            ...modelHandoff.obligation,
            event: {
              ...modelHandoff.obligation.event,
              payload: { ...modelHandoff.obligation.event.payload, sourceKey: "different" },
            },
          },
        },
      }),
    ).toBeNull();
    expect(
      turnPersistenceHandoffFromHeartbeat({
        persistenceHandoff: {
          ...modelHandoff,
          obligation: {
            ...modelHandoff.obligation,
            event: { ...modelHandoff.obligation.event, type: "agent.message.completed" },
          },
        },
      }),
    ).toBeNull();
    expect(
      turnPersistenceHandoffFromHeartbeat({
        persistenceHandoff: {
          ...handoff,
          obligation: { ...handoff.obligation, callItem: "not-an-object" },
        },
      }),
    ).toBeNull();
    expect(
      turnPersistenceHandoffFromHeartbeat({
        persistenceHandoff: {
          ...modelHandoff,
          obligation: {
            ...modelHandoff.obligation,
            event: { ...modelHandoff.obligation.event, turnId: "different-turn" },
          },
        },
      }),
    ).toBeNull();
    expect(
      turnPersistenceHandoffFromHeartbeat({
        persistenceHandoff: {
          ...compactionHandoff,
          obligation: {
            ...compactionHandoff.obligation,
            compaction: {
              ...compactionHandoff.obligation.compaction,
              occurredAt: "not-a-date",
            },
          },
        },
      }),
    ).toBeNull();
    expect(
      turnPersistenceHandoffFromHeartbeat({
        persistenceHandoff: {
          ...compactionHandoff,
          obligation: {
            ...compactionHandoff.obligation,
            compaction: {
              ...compactionHandoff.obligation.compaction,
              eventPayload: {
                ...compactionHandoff.obligation.compaction.eventPayload,
                persistenceKey: "different",
              },
            },
          },
        },
      }),
    ).toBeNull();
  });
});

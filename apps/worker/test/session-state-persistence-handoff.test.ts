import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionStateActivities } from "../src/activities/session-state";
import type {
  PersistTurnHandoffAndRecoverInput,
  TurnPersistenceHandoff,
  TurnPersistenceObligation,
} from "../src/activities/types";
import { TurnAttemptFencedError } from "../src/activities/turn-attempt-fenced";
import { turnPersistenceObligationDigest } from "../src/turn-persistence-handoff";

const ids = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  triggerEventId: "55555555-5555-4555-8555-555555555555",
  attemptId: "66666666-6666-4666-8666-666666666666",
  receiptId: "77777777-7777-4777-8777-777777777777",
};

const toolObligation: TurnPersistenceObligation = {
  kind: "pending_tool_call",
  callId: "call-1",
  callType: "function_call",
  callItem: {
    type: "function_call",
    callId: "call-1",
    name: "mutate_external_state",
    arguments: "{}",
  },
};

const modelObligation: TurnPersistenceObligation = {
  kind: "model_call",
  history: {
    producerCodexCredentialId: null,
    modelToolOutputTruncationTokens: 4096,
    items: [
      {
        position: 8,
        item: { type: "message", role: "assistant", content: "completed response" },
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

const modelObligationWithoutUsage: TurnPersistenceObligation = {
  kind: "model_call",
  history: {
    producerCodexCredentialId: null,
    modelToolOutputTruncationTokens: 4096,
    items: [
      {
        position: 9,
        item: { type: "message", role: "assistant", content: "completed without usage" },
      },
    ],
  },
  metering: null,
  event: null,
};

const compactionObligation: TurnPersistenceObligation = {
  kind: "context_compaction",
  metering: {
    model: "gpt-5.6-sol",
    isCodexTurn: true,
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    sourceKey: "compaction-response-1",
  },
  event: {
    type: "agent.model.usage",
    payload: {
      turnId: ids.turnId,
      model: "gpt-5.6-sol",
      sourceKey: "compaction-response-1",
      inputTokens: 100,
      outputTokens: 10,
    },
    turnId: ids.turnId,
    producerId: `turn-attempt:${ids.attemptId}`,
    producerSeq: 18,
    occurredAt: "2026-07-18T22:22:37.000Z",
  },
  compaction: {
    action: "apply",
    persistenceKey: "compaction-response-1",
    replacementItems: [{ type: "message", role: "user", content: "keep this" }],
    summaryItem: {
      type: "message",
      role: "user",
      content: "durable summary",
      opengeni_context_summary: true,
    },
    replacementInputTokens: 42,
    clearRequestedCompaction: false,
    occurredAt: "2026-07-18T22:22:37.000Z",
    eventPayload: {
      persistenceKey: "compaction-response-1",
      trigger: "auto",
      replacementFingerprint: "fingerprint-1",
    },
    result: {
      signalTokens: 250_000,
      thresholdTokens: 244_800,
      estimatedTokensBefore: 240_000,
      estimatedTokensAfter: 42,
      replacementFingerprint: "fingerprint-1",
    },
  },
};

type ReceiptState = "pending" | "settled" | "quarantined";

function fixture(obligation: TurnPersistenceObligation, state: ReceiptState = "pending") {
  const obligationDigest = turnPersistenceObligationDigest(obligation);
  const handoff: TurnPersistenceHandoff = {
    version: 2,
    receiptId: ids.receiptId,
    turnId: ids.turnId,
    triggerEventId: ids.triggerEventId,
    executionGeneration: 7,
    attemptId: ids.attemptId,
    obligationKind: obligation.kind,
    obligationDigest,
  };
  const receipt = {
    id: ids.receiptId,
    ...ids,
    executionGeneration: 7,
    obligationKind: obligation.kind,
    obligationVersion: 1,
    obligationDigest,
    obligation,
    state,
    quarantineReason: state === "quarantined" ? "test" : null,
    createdAt: new Date("2026-07-18T22:22:36.000Z"),
    updatedAt: new Date("2026-07-18T22:22:36.000Z"),
    settledAt: state === "settled" ? new Date("2026-07-18T22:22:37.000Z") : null,
    quarantinedAt: state === "quarantined" ? new Date("2026-07-18T22:22:37.000Z") : null,
  };
  const input: PersistTurnHandoffAndRecoverInput = {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sessionId: ids.sessionId,
    attemptId: ids.attemptId,
    reason: "activity_result",
    handoff,
  };
  return { handoff, input, obligation, receipt };
}

const operations: Array<{ phase: string; value?: unknown }> = [];
const registrations: unknown[] = [];
const recoveries: unknown[] = [];
const published: unknown[] = [];
const quarantines: unknown[] = [];
let currentReceipt: ReturnType<typeof fixture>["receipt"] | null = null;
let registrationAccepted = true;
let historyAccepted = true;
let eventAccepted = true;
let compactionStale = false;
let receiptSettleAction: "settled" | "confirmed" | "fenced" = "settled";
let recoveryAction: "recovering" | "stale" = "recovering";
let interruptionAction: "paused" | "continue" | "stale" = "paused";
let fallbackRecoverDispatchCalls = 0;
let receiptAttemptLive = true;
let receiptStateOnFence: ReceiptState | null = null;

function moveCurrentReceiptTo(state: ReceiptState) {
  if (!currentReceipt) return;
  currentReceipt = {
    ...currentReceipt,
    state,
    settledAt: state === "settled" ? new Date("2026-07-18T22:22:38.000Z") : null,
    quarantineReason: state === "quarantined" ? "test" : null,
    quarantinedAt: state === "quarantined" ? new Date("2026-07-18T22:22:38.000Z") : null,
  };
}

function activities() {
  return createSessionStateActivities(
    async () =>
      ({
        db: {},
        bus: {},
        settings: {},
        observability: {},
        wakeSessionWorkflow: null,
      }) as any,
    {
      getSessionTurnPersistenceReceipt: mock(async (_db, _workspaceId, input) => {
        if (!currentReceipt) return null;
        if (input.receiptId && input.receiptId !== currentReceipt.id) return null;
        return currentReceipt as any;
      }) as any,
      inspectSessionTurnPersistenceReceipt: mock(async () => {
        operations.push({ phase: "receipt_reload" });
        if (!receiptAttemptLive) return { action: "stale", receipt: currentReceipt } as any;
        if (!currentReceipt) return { action: "missing", receipt: null } as any;
        return { action: currentReceipt.state, receipt: currentReceipt } as any;
      }) as any,
      settleSessionTurnPersistenceReceipt: mock(async (_db, value) => {
        operations.push({ phase: "receipt_settle", value });
        if (receiptSettleAction !== "fenced") moveCurrentReceiptTo("settled");
        else if (receiptStateOnFence) moveCurrentReceiptTo(receiptStateOnFence);
        return { action: receiptSettleAction };
      }) as any,
      quarantineSessionTurnPersistenceAttempt: mock(async (_db, _workspaceId, value) => {
        operations.push({ phase: "quarantine", value });
        quarantines.push(value);
        if (currentReceipt) {
          currentReceipt = {
            ...currentReceipt,
            state: "quarantined",
            quarantineReason: value.reason,
            quarantinedAt: new Date("2026-07-18T22:22:38.000Z"),
          };
        }
        return {
          action: "quarantined",
          turnId: ids.turnId,
          events: [{ id: "quarantine-event", type: "turn.failed" }],
        } as any;
      }) as any,
      appendSessionHistoryItems: mock(async (_db, value) => {
        operations.push({ phase: "history", value });
        if (!historyAccepted && receiptStateOnFence) moveCurrentReceiptTo(receiptStateOnFence);
        return historyAccepted;
      }) as any,
      registerPendingSessionToolCall: mock(async (_db, value) => {
        operations.push({ phase: "registration", value });
        registrations.push(value);
        if (!registrationAccepted && receiptStateOnFence) {
          moveCurrentReceiptTo(receiptStateOnFence);
        }
        return { accepted: registrationAccepted, registered: registrationAccepted };
      }) as any,
      requestSessionTurnRecovery: mock(async (_db, workspaceId, value) => {
        operations.push({ phase: "recovery", value });
        recoveries.push({ workspaceId, ...value });
        return recoveryAction === "stale"
          ? ({ action: "stale", events: [] } as const)
          : ({
              action: "recovering",
              events: [{ id: "recovery-event", type: "turn.recovery.requested" }],
            } as any);
      }) as any,
      publishDurableSessionEvents: mock(async (_bus, workspaceId, sessionId, events) => {
        published.push({ workspaceId, sessionId, events });
      }) as any,
      recordModelUsageAndDebitCredits: mock(async (_settings, _db, value) => {
        operations.push({ phase: "meter", value });
      }) as any,
      appendOrConfirmAndPublishTurnEventsFenced: mock(async (...args) => {
        operations.push({
          phase: "event",
          value: { events: args[7], persistenceReceiptId: args[9] },
        });
        if (!eventAccepted && receiptStateOnFence) moveCurrentReceiptTo(receiptStateOnFence);
        return { events: [], accepted: eventAccepted };
      }) as any,
      persistPreparedContextCompaction: mock(async (_db, scope, prepared) => {
        operations.push({ phase: "compaction", value: { scope, prepared } });
        if (compactionStale) {
          if (receiptStateOnFence) moveCurrentReceiptTo(receiptStateOnFence);
          throw new TurnAttemptFencedError("successor owns turn");
        }
        return {
          compacted: true,
          supersededFrom: 10,
          summaryPosition: 11,
          signalTokens: 250_000,
          thresholdTokens: 244_800,
          estimatedTokensBefore: 240_000,
          estimatedTokensAfter: 42,
          replacementFingerprint: "fingerprint-1",
          events: [{ id: "compaction-event", type: "session.context.compacted" }],
        } as any;
      }) as any,
      settleSessionAttemptInterruptions: mock(async () => {
        operations.push({ phase: "interruption" });
        return { action: interruptionAction, events: [] } as any;
      }) as any,
      recoverSessionDispatch: mock(async () => {
        fallbackRecoverDispatchCalls += 1;
        if (currentReceipt?.state === "pending") {
          return {
            action: "persistence_pending",
            receipt: currentReceipt,
            events: [],
          } as const;
        }
        return { action: "unclaimed" } as const;
      }) as any,
      countQueuedTurns: mock(async () => 0) as any,
      recordTurnsQueuedGauge: mock(() => {}) as any,
      deliverFailedChildTurnToParent: mock(async () => {}) as any,
    },
  );
}

beforeEach(() => {
  operations.length = 0;
  registrations.length = 0;
  recoveries.length = 0;
  published.length = 0;
  quarantines.length = 0;
  currentReceipt = null;
  registrationAccepted = true;
  historyAccepted = true;
  eventAccepted = true;
  compactionStale = false;
  receiptSettleAction = "settled";
  recoveryAction = "recovering";
  interruptionAction = "paused";
  fallbackRecoverDispatchCalls = 0;
  receiptAttemptLive = true;
  receiptStateOnFence = null;
});

describe("persistTurnHandoffAndRecover", () => {
  test("the persistence-only control lane cannot import provider, tool, or sandbox execution", () => {
    const activitiesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "activities");
    const persistenceModules = [
      "session-state.ts",
      "model-usage.ts",
      "context-compaction-persistence.ts",
    ];
    const forbiddenImports = [
      /from\s+["']@opengeni\/runtime["']/,
      /from\s+["']\.\/agent-turn["']/,
      /from\s+["']\.\/context-compaction["']/,
      /from\s+["'][^"']*(?:sandbox|tool-execution)[^"']*["']/,
    ];

    for (const module of persistenceModules) {
      const source = readFileSync(join(activitiesDir, module), "utf8");
      for (const forbidden of forbiddenImports) {
        expect(source).not.toMatch(forbidden);
      }
    }
    expect(readFileSync(join(activitiesDir, "model-usage.ts"), "utf8")).toContain(
      'from "@opengeni/runtime/usage-telemetry"',
    );
  });

  test("persists and settles the exact pending-tool receipt before same-turn recovery", async () => {
    const prepared = fixture(toolObligation);
    currentReceipt = prepared.receipt;

    expect(await activities().persistTurnHandoffAndRecover(prepared.input)).toEqual({
      action: "recovering",
      turnId: ids.turnId,
    });
    expect(operations.map(({ phase }) => phase)).toEqual([
      "registration",
      "receipt_settle",
      "recovery",
    ]);
    expect(registrations[0]).toMatchObject({
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sessionId: ids.sessionId,
      turnId: ids.turnId,
      attemptId: ids.attemptId,
      executionGeneration: 7,
      persistenceReceiptId: ids.receiptId,
      callId: "call-1",
      callType: "function_call",
      callItem: toolObligation.kind === "pending_tool_call" ? toolObligation.callItem : {},
    });
    expect(recoveries[0]).toMatchObject({
      workspaceId: ids.workspaceId,
      sessionId: ids.sessionId,
      turnId: ids.turnId,
      triggerEventId: ids.triggerEventId,
      attemptId: ids.attemptId,
      reason: "persistence_pending_tool_call_activity_result",
    });
  });

  test("stops stale-safe before settlement or recovery when a successor owns the turn", async () => {
    const prepared = fixture(toolObligation);
    currentReceipt = prepared.receipt;
    registrationAccepted = false;
    receiptAttemptLive = false;

    expect(await activities().persistTurnHandoffAndRecover(prepared.input)).toEqual({
      action: "stale",
    });
    expect(operations.map(({ phase }) => phase)).toEqual(["registration", "receipt_reload"]);
  });

  test("continues exact recovery when tool registration loses to concurrent receipt settlement", async () => {
    const prepared = fixture(toolObligation);
    currentReceipt = prepared.receipt;
    registrationAccepted = false;
    receiptStateOnFence = "settled";

    expect(await activities().persistTurnHandoffAndRecover(prepared.input)).toEqual({
      action: "recovering",
      turnId: ids.turnId,
    });
    expect(operations.map(({ phase }) => phase)).toEqual([
      "registration",
      "receipt_reload",
      "recovery",
    ]);
  });

  test("treats receipt-settlement response loss as duplicate-safe replay", async () => {
    const prepared = fixture(toolObligation);
    currentReceipt = prepared.receipt;
    const control = activities();

    expect(await control.persistTurnHandoffAndRecover(prepared.input)).toMatchObject({
      action: "recovering",
    });
    recoveryAction = "stale";
    expect(await control.persistTurnHandoffAndRecover(prepared.input)).toEqual({ action: "stale" });
    expect(operations.map(({ phase }) => phase)).toEqual([
      "registration",
      "receipt_settle",
      "recovery",
      "recovery",
    ]);
    expect(registrations).toHaveLength(1);
  });

  test("persists model truth with the receipt fence before settlement and recovery", async () => {
    const prepared = fixture(modelObligation);
    currentReceipt = prepared.receipt;

    expect(await activities().persistTurnHandoffAndRecover(prepared.input)).toEqual({
      action: "recovering",
      turnId: ids.turnId,
    });
    expect(operations.map(({ phase }) => phase)).toEqual([
      "history",
      "meter",
      "event",
      "receipt_settle",
      "recovery",
    ]);
    expect(operations[0]?.value).toMatchObject({
      turnId: ids.turnId,
      expectedExecutionGeneration: 7,
      expectedAttemptId: ids.attemptId,
      persistenceReceiptId: ids.receiptId,
      items: modelObligation.kind === "model_call" ? modelObligation.history.items : [],
    });
    expect(operations[2]?.value).toMatchObject({ persistenceReceiptId: ids.receiptId });
    expect(recoveries[0]).toMatchObject({ reason: "persistence_model_call_activity_result" });
  });

  test("persists and settles a completed model response without inventing usage or billing", async () => {
    const prepared = fixture(modelObligationWithoutUsage);
    currentReceipt = prepared.receipt;

    expect(await activities().persistTurnHandoffAndRecover(prepared.input)).toEqual({
      action: "recovering",
      turnId: ids.turnId,
    });
    expect(operations.map(({ phase }) => phase)).toEqual(["history", "receipt_settle", "recovery"]);
    expect(operations[0]?.value).toMatchObject({
      persistenceReceiptId: ids.receiptId,
      items:
        modelObligationWithoutUsage.kind === "model_call"
          ? modelObligationWithoutUsage.history.items
          : [],
    });
    expect(operations.some(({ phase }) => phase === "meter")).toBe(false);
    expect(operations.some(({ phase }) => phase === "event")).toBe(false);
  });

  test("does not meter or recover model truth after its attempt fence is stale", async () => {
    const prepared = fixture(modelObligation);
    currentReceipt = prepared.receipt;
    historyAccepted = false;
    receiptAttemptLive = false;

    expect(await activities().persistTurnHandoffAndRecover(prepared.input)).toEqual({
      action: "stale",
    });
    expect(operations.map(({ phase }) => phase)).toEqual(["history", "receipt_reload"]);
  });

  test("continues exact recovery when model-history persistence observes a concurrently settled receipt", async () => {
    const prepared = fixture(modelObligation);
    currentReceipt = prepared.receipt;
    historyAccepted = false;
    receiptStateOnFence = "settled";

    expect(await activities().persistTurnHandoffAndRecover(prepared.input)).toEqual({
      action: "recovering",
      turnId: ids.turnId,
    });
    expect(operations.map(({ phase }) => phase)).toEqual(["history", "receipt_reload", "recovery"]);
  });

  test("continues exact recovery when exact-event persistence observes concurrent settlement", async () => {
    const prepared = fixture(modelObligation);
    currentReceipt = prepared.receipt;
    eventAccepted = false;
    receiptStateOnFence = "settled";

    expect(await activities().persistTurnHandoffAndRecover(prepared.input)).toEqual({
      action: "recovering",
      turnId: ids.turnId,
    });
    expect(operations.map(({ phase }) => phase)).toEqual([
      "history",
      "meter",
      "event",
      "receipt_reload",
      "recovery",
    ]);
  });

  test("persists compaction accounting and replacement under the receipt fence", async () => {
    const prepared = fixture(compactionObligation);
    currentReceipt = prepared.receipt;

    expect(await activities().persistTurnHandoffAndRecover(prepared.input)).toEqual({
      action: "recovering",
      turnId: ids.turnId,
    });
    expect(operations.map(({ phase }) => phase)).toEqual([
      "meter",
      "event",
      "compaction",
      "receipt_settle",
      "recovery",
    ]);
    expect(operations[1]?.value).toMatchObject({ persistenceReceiptId: ids.receiptId });
    expect(operations[2]?.value).toMatchObject({
      scope: {
        turnId: ids.turnId,
        executionGeneration: 7,
        attemptId: ids.attemptId,
        persistenceReceiptId: ids.receiptId,
      },
      prepared: { action: "apply", persistenceKey: "compaction-response-1" },
    });
    expect(recoveries[0]).toMatchObject({
      reason: "persistence_context_compaction_activity_result",
    });
  });

  test("does not settle or recover when prepared compaction persistence is stale", async () => {
    const prepared = fixture(compactionObligation);
    currentReceipt = prepared.receipt;
    compactionStale = true;
    receiptAttemptLive = false;

    expect(await activities().persistTurnHandoffAndRecover(prepared.input)).toEqual({
      action: "stale",
    });
    expect(operations.map(({ phase }) => phase)).toEqual([
      "meter",
      "event",
      "compaction",
      "receipt_reload",
    ]);
  });

  test("continues exact recovery when compaction persistence loses to concurrent settlement", async () => {
    const prepared = fixture(compactionObligation);
    currentReceipt = prepared.receipt;
    compactionStale = true;
    receiptStateOnFence = "settled";

    expect(await activities().persistTurnHandoffAndRecover(prepared.input)).toEqual({
      action: "recovering",
      turnId: ids.turnId,
    });
    expect(operations.map(({ phase }) => phase)).toEqual([
      "meter",
      "event",
      "compaction",
      "receipt_reload",
      "recovery",
    ]);
  });

  test("quarantines a receipt/digest mismatch without entering any persistence effect path", async () => {
    const prepared = fixture(modelObligation);
    currentReceipt = { ...prepared.receipt, obligationDigest: "0".repeat(64) };

    expect(await activities().persistTurnHandoffAndRecover(prepared.input)).toEqual({
      action: "quarantined",
    });
    expect(operations.map(({ phase }) => phase)).toEqual(["quarantine"]);
    expect(quarantines[0]).toMatchObject({ reason: "invalid_receipt_reference" });
    expect(recoveries).toHaveLength(0);
  });

  test("quarantines malformed bounded references instead of replaying the turn", async () => {
    const prepared = fixture(toolObligation);
    currentReceipt = prepared.receipt;
    const malformed = {
      ...prepared.input,
      handoff: { ...prepared.handoff, rawObligation: toolObligation },
    } as unknown as PersistTurnHandoffAndRecoverInput;

    expect(await activities().persistTurnHandoffAndRecover(malformed)).toEqual({
      action: "quarantined",
    });
    expect(operations.map(({ phase }) => phase)).toEqual(["quarantine"]);
    expect(registrations).toHaveLength(0);
  });

  test("discovers and settles a PostgreSQL receipt when no heartbeat was observed", async () => {
    const prepared = fixture(toolObligation);
    currentReceipt = prepared.receipt;

    expect(
      await activities().recoverDispatch({
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sessionId: ids.sessionId,
        attemptId: ids.attemptId,
        timeoutType: "HEARTBEAT",
      }),
    ).toEqual({ action: "recovering", turnId: ids.turnId, redispatches: 0 });
    expect(operations.map(({ phase }) => phase)).toEqual([
      "registration",
      "receipt_settle",
      "recovery",
    ]);
    expect(recoveries[0]).toMatchObject({
      reason: "persistence_pending_tool_call_heartbeat_timeout",
    });
    expect(fallbackRecoverDispatchCalls).toBe(1);
  });

  test("reconciles a pending receipt before interruption settlement closes the attempt", async () => {
    const prepared = fixture(toolObligation);
    currentReceipt = prepared.receipt;

    expect(
      await activities().settleSessionInterruptions({
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sessionId: ids.sessionId,
        attemptId: ids.attemptId,
        workflowId: "session-workflow",
      }),
    ).toEqual({ action: "paused" });
    expect(operations.map(({ phase }) => phase)).toEqual([
      "registration",
      "receipt_settle",
      "interruption",
    ]);
    expect(recoveries).toHaveLength(0);
  });

  test("retries instead of closing an interruption while its exact receipt remains pending", async () => {
    const prepared = fixture(toolObligation);
    currentReceipt = prepared.receipt;
    receiptSettleAction = "fenced";

    await expect(
      activities().settleSessionInterruptions({
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sessionId: ids.sessionId,
        attemptId: ids.attemptId,
        workflowId: "session-workflow",
      }),
    ).rejects.toThrow("receipt remains pending");
    expect(operations.map(({ phase }) => phase)).toEqual([
      "registration",
      "receipt_settle",
      "receipt_reload",
    ]);
  });

  test("settles the interruption when receipt settlement response loses to a concurrent settler", async () => {
    const prepared = fixture(toolObligation);
    currentReceipt = prepared.receipt;
    receiptSettleAction = "fenced";
    receiptStateOnFence = "settled";

    expect(
      await activities().settleSessionInterruptions({
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sessionId: ids.sessionId,
        attemptId: ids.attemptId,
        workflowId: "session-workflow",
      }),
    ).toEqual({ action: "paused" });
    expect(operations.map(({ phase }) => phase)).toEqual([
      "registration",
      "receipt_settle",
      "receipt_reload",
      "interruption",
    ]);
  });
});

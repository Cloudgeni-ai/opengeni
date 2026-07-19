import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionStateActivities } from "../src/activities/session-state";
import type { PersistTurnHandoffAndRecoverInput } from "../src/activities/types";
import { TurnAttemptFencedError } from "../src/activities/turn-attempt-fenced";

const registrations: unknown[] = [];
const recoveries: unknown[] = [];
const published: unknown[] = [];
const modelPersistence: Array<{ phase: string; value: unknown }> = [];
let registrationAccepted = true;
let historyAccepted = true;
let eventAccepted = true;
let recoveryAction: "recovering" | "stale" = "recovering";

const input: PersistTurnHandoffAndRecoverInput = {
  accountId: "account-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  attemptId: "attempt-1",
  reason: "activity_result",
  handoff: {
    version: 1,
    turnId: "turn-1",
    triggerEventId: "trigger-1",
    executionGeneration: 7,
    obligation: {
      kind: "pending_tool_call",
      callId: "call-1",
      callType: "function_call",
      callItem: {
        type: "function_call",
        callId: "call-1",
        name: "mutate_external_state",
        arguments: "{}",
      },
    },
  },
};

const modelInput: PersistTurnHandoffAndRecoverInput = {
  ...input,
  handoff: {
    version: 1,
    turnId: "turn-1",
    triggerEventId: "trigger-1",
    executionGeneration: 7,
    obligation: {
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
  },
};

const compactionInput: PersistTurnHandoffAndRecoverInput = {
  ...input,
  handoff: {
    version: 1,
    turnId: "turn-1",
    triggerEventId: "trigger-1",
    executionGeneration: 7,
    obligation: {
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
          turnId: "turn-1",
          model: "gpt-5.6-sol",
          sourceKey: "compaction-response-1",
          inputTokens: 100,
          outputTokens: 10,
        },
        turnId: "turn-1",
        producerId: "workflow:turn:activity",
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
    },
  },
};

let compactionStale = false;

function activities() {
  return createSessionStateActivities(
    async () =>
      ({
        db: {},
        bus: {},
        settings: {},
        observability: {},
      }) as any,
    {
      appendSessionHistoryItems: mock(async (_db, value) => {
        modelPersistence.push({ phase: "history", value });
        return historyAccepted;
      }) as any,
      registerPendingSessionToolCall: mock(async (_db, value) => {
        registrations.push(value);
        return { accepted: registrationAccepted, registered: registrationAccepted };
      }) as any,
      requestSessionTurnRecovery: mock(async (_db, workspaceId, value) => {
        modelPersistence.push({ phase: "recovery", value });
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
        modelPersistence.push({ phase: "meter", value });
      }) as any,
      appendOrConfirmAndPublishTurnEventsFenced: mock(async (...args) => {
        modelPersistence.push({ phase: "event", value: args.at(-1) });
        return { events: [], accepted: eventAccepted };
      }) as any,
      persistPreparedContextCompaction: mock(async (_db, scope, prepared) => {
        modelPersistence.push({ phase: "compaction", value: { scope, prepared } });
        if (compactionStale) throw new TurnAttemptFencedError("successor owns turn");
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
    },
  );
}

beforeEach(() => {
  registrations.length = 0;
  recoveries.length = 0;
  published.length = 0;
  modelPersistence.length = 0;
  registrationAccepted = true;
  historyAccepted = true;
  eventAccepted = true;
  recoveryAction = "recovering";
  compactionStale = false;
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

  test("persists only the exact receipt before requesting same-turn recovery", async () => {
    expect(await activities().persistTurnHandoffAndRecover(input)).toEqual({
      action: "recovering",
      turnId: "turn-1",
    });
    expect(registrations).toEqual([
      {
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        executionGeneration: 7,
        attemptId: "attempt-1",
        callId: "call-1",
        callType: "function_call",
        callItem: input.handoff.obligation.callItem,
      },
    ]);
    expect(recoveries).toEqual([
      {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        triggerEventId: "trigger-1",
        attemptId: "attempt-1",
        reason: "persistence_pending_tool_call_activity_result",
      },
    ]);
    expect(published).toHaveLength(1);
  });

  test("stops stale-safe when a successor attempt already owns the turn", async () => {
    registrationAccepted = false;
    expect(await activities().persistTurnHandoffAndRecover(input)).toEqual({ action: "stale" });
    expect(registrations).toHaveLength(1);
    expect(recoveries).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  test("treats completion-response loss as duplicate-safe receipt replay", async () => {
    const control = activities();
    expect(await control.persistTurnHandoffAndRecover(input)).toMatchObject({
      action: "recovering",
    });
    recoveryAction = "stale";
    expect(await control.persistTurnHandoffAndRecover(input)).toEqual({ action: "stale" });
    expect(registrations).toHaveLength(2);
    expect(recoveries).toHaveLength(2);
    expect(published).toHaveLength(1);
  });

  test("persists model history, metering, and exact event before recovery", async () => {
    expect(await activities().persistTurnHandoffAndRecover(modelInput)).toEqual({
      action: "recovering",
      turnId: "turn-1",
    });
    expect(modelPersistence.map(({ phase }) => phase)).toEqual([
      "history",
      "meter",
      "event",
      "recovery",
    ]);
    expect(modelPersistence[0]?.value).toMatchObject({
      turnId: "turn-1",
      expectedExecutionGeneration: 7,
      expectedAttemptId: "attempt-1",
      items:
        modelInput.handoff.obligation.kind === "model_call"
          ? modelInput.handoff.obligation.history.items
          : [],
    });
    expect(modelPersistence[1]?.value).toMatchObject({
      turnId: "turn-1",
      sourceKey: "resp-1",
    });
    expect(recoveries[0]).toMatchObject({ reason: "persistence_model_call_activity_result" });
  });

  test("does not meter or recover a model handoff after its attempt fence is stale", async () => {
    historyAccepted = false;
    expect(await activities().persistTurnHandoffAndRecover(modelInput)).toEqual({
      action: "stale",
    });
    expect(modelPersistence.map(({ phase }) => phase)).toEqual(["history"]);
    expect(recoveries).toHaveLength(0);
  });

  test("persists compaction accounting and the exact prepared result before recovery", async () => {
    expect(await activities().persistTurnHandoffAndRecover(compactionInput)).toEqual({
      action: "recovering",
      turnId: "turn-1",
    });
    expect(modelPersistence.map(({ phase }) => phase)).toEqual([
      "meter",
      "event",
      "compaction",
      "recovery",
    ]);
    expect(modelPersistence[2]?.value).toMatchObject({
      scope: {
        turnId: "turn-1",
        executionGeneration: 7,
        attemptId: "attempt-1",
      },
      prepared: {
        action: "apply",
        persistenceKey: "compaction-response-1",
      },
    });
    expect(recoveries[0]).toMatchObject({
      reason: "persistence_context_compaction_activity_result",
    });
    expect(published).toHaveLength(2);
  });

  test("does not recover when the prepared compaction fence is stale", async () => {
    compactionStale = true;
    expect(await activities().persistTurnHandoffAndRecover(compactionInput)).toEqual({
      action: "stale",
    });
    expect(modelPersistence.map(({ phase }) => phase)).toEqual(["meter", "event", "compaction"]);
    expect(recoveries).toHaveLength(0);
  });
});

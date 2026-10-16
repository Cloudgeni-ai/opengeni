import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RunRawModelStreamEvent } from "@openai/agents-core";
import * as opengeniDb from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { useNoSessionUsageLimitForFakeDatabases } from "@opengeni/testing/session-usage-limits";
import {
  createCompactionModelUsageEventState,
  createModelResponseEventState,
  createSessionTitleModelUsageEventState,
  emitModelCallUsage,
  processCompactionModelUsageEvent,
  processModelResponseTerminalEvent,
  processSessionTitleModelUsageEvent,
} from "../src/activities/agent-turn/model-usage";
// Fake databases have no per-task usage limit state.
useNoSessionUsageLimitForFakeDatabases();

// Every durable `agent.model.usage` event names why the worker made the call,
// so readers such as subscription guards can tell the turn's own inference
// from its auxiliary title and summarizer calls without inferring it.

const PROVIDER = "organization-claude-subscription";
const MAIN_MODEL = `${PROVIDER}/claude-sonnet-5-5`;
const TITLE_MODEL = `${PROVIDER}/claude-haiku-5-5`;
// A settled, externally billed call; matches the recorded pre-change payload plus `purpose`.
const SETTLED_PAYLOAD_KEYS = [
  "accountId",
  "billingPath",
  "cacheWriteTokens",
  "cachedTokens",
  "equivalentCreditCostMicros",
  "estimatedProviderCostMicros",
  "inputTokens",
  "listByClassApprox",
  "listByClassMicros",
  "model",
  "outputTokens",
  "pricedCostMicros",
  "pricingSource",
  "provider",
  "providerApi",
  "purpose",
  "reasoningTokens",
  "sessionId",
  "sourceKey",
  "turnId",
  "workspaceId",
];
const usage = { inputTokens: 164, outputTokens: 12, totalTokens: 176 };

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

type StoredEvent = {
  id: string;
  payload: Record<string, unknown>;
  turnAssociation: "current" | "duplicate";
  duplicateOfEventId: string | null;
};

/** The session-event writer's rule: the first usage event per turn and source key is canonical. */
function durableEvents() {
  const stored: StoredEvent[] = [];
  const canonical = new Map<string, string>();
  const publish = async (batch: Array<{ type: string; payload?: unknown }>) => ({
    accepted: true,
    canonicalStartupMilestones: [],
    events: batch.map((event) => {
      const payload = event.payload as Record<string, unknown>;
      const identity = `${String(payload.turnId)}:${String(payload.sourceKey)}`;
      const id = crypto.randomUUID();
      const duplicateOfEventId = canonical.get(identity) ?? null;
      if (!duplicateOfEventId) canonical.set(identity, id);
      const row: StoredEvent = {
        id,
        payload,
        turnAssociation: duplicateOfEventId ? "duplicate" : "current",
        duplicateOfEventId,
      };
      stored.push(row);
      return { ...row, type: event.type };
    }),
  });
  return { stored, publish: publish as any };
}

function captureBilling() {
  const billed: Array<Record<string, unknown>> = [];
  const usageEvents = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(
    async (_db, input) => {
      billed.push(input as unknown as Record<string, unknown>);
    },
  );
  const facts = spyOn(opengeniDb, "recordModelCallFact").mockResolvedValue(undefined as never);
  restores.push(
    () => usageEvents.mockRestore(),
    () => facts.mockRestore(),
  );
  return billed;
}

function observed() {
  const observability = createObservability(testSettings(), { component: "worker" });
  const logged: Array<Record<string, unknown>> = [];
  observability.info = (message: string, attributes?: Record<string, unknown>) => {
    if (message === "model call usage") logged.push(attributes ?? {});
  };
  return { observability, logged };
}

function callInput(observability: unknown, publish: unknown) {
  return {
    dispatchId: "dispatch-A",
    settings: testSettings(),
    db: {} as any,
    observability: observability as any,
    publish: publish as any,
    accountId: "acct-1",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    turnAttemptId: "attempt-1",
    provider: PROVIDER,
    providerApi: "anthropic-messages" as const,
    externallyBilled: true,
    servingCredentialId: null,
    priorSessionCredentialId: null,
    renewLease: async () => undefined,
    leaseLost: () => false,
    leaseLostMessage: "lease lost",
  };
}

test("main, compaction and session-title usage each record their purpose on the durable event", async () => {
  const billed = captureBilling();
  const { observability, logged } = observed();
  const { stored, publish } = durableEvents();
  const base = callInput(observability, publish);
  // Production shares one claimed and one emitted source-key set across the turn's calls.
  const claimed = new Set<string>();
  const emitted = new Set<string>();

  const main = await processModelResponseTerminalEvent({
    ...base,
    model: MAIN_MODEL,
    event: new RunRawModelStreamEvent({
      type: "response_done",
      response: { id: "msg_main", output: [], usage },
    } as any) as any,
    state: createModelResponseEventState(claimed),
    metricProvider: PROVIDER,
    emittedSourceKeys: emitted,
    setLastInputTokens: async () => undefined,
  });
  // No provider response id: the positional source keys stay exactly as before.
  const compaction = await processCompactionModelUsageEvent({
    ...base,
    model: MAIN_MODEL,
    usage: { usage } as any,
    state: createCompactionModelUsageEventState(claimed),
    emittedSourceKeys: emitted,
  });
  const title = await processSessionTitleModelUsageEvent({
    ...base,
    model: TITLE_MODEL,
    usage: { usage } as any,
    state: createSessionTitleModelUsageEventState(claimed),
    emittedSourceKeys: emitted,
  });
  // The aggregate billing fallback is the turn's own call (wiring pinned below).
  const aggregate = await emitModelCallUsage({
    observability,
    publish,
    accountId: "acct-1",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    provider: PROVIDER,
    providerApi: "anthropic-messages",
    model: MAIN_MODEL,
    purpose: "main",
    sourceKey: "dispatch-A:aggregate",
    usage: { usage },
    emittedSourceKeys: emitted,
  });

  expect([main, compaction, title]).toEqual([
    { status: "processed", sourceKey: "msg_main", authoritative: true, usageReported: true },
    { status: "processed", sourceKey: "dispatch-A:compaction-1", authoritative: true },
    { status: "processed", sourceKey: "dispatch-A:session-title-1", authoritative: true },
  ]);
  expect(aggregate).toBe(true);
  expect(
    stored.map((event) => [
      event.payload.purpose,
      event.payload.sourceKey,
      event.payload.model,
      event.turnAssociation,
    ]),
  ).toEqual([
    ["main", "msg_main", MAIN_MODEL, "current"],
    ["compaction", "dispatch-A:compaction-1", MAIN_MODEL, "current"],
    ["session-title", "dispatch-A:session-title-1", TITLE_MODEL, "current"],
    ["main", "dispatch-A:aggregate", MAIN_MODEL, "current"],
  ]);
  for (const event of stored.slice(0, 3)) {
    expect(Object.keys(event.payload).sort()).toEqual(SETTLED_PAYLOAD_KEYS);
    expect(event.payload).toMatchObject({ billingPath: "external", provider: PROVIDER });
  }
  expect(logged.map((attributes) => attributes.purpose)).toEqual([
    "main",
    "compaction",
    "session-title",
    "main",
  ]);

  // Billing identity and inputs are unchanged: keyed by turn and source key, never by purpose.
  expect(billed.length).toBeGreaterThan(0);
  expect(JSON.stringify(billed)).not.toContain('"purpose"');
  expect(
    new Set(
      billed.map((input) => /^usage:[a-z.]+:turn-1:(.+)$/.exec(String(input.idempotencyKey))?.[1]),
    ),
  ).toEqual(new Set(["msg_main", "dispatch-A:compaction-1", "dispatch-A:session-title-1"]));
  // Purpose is never a metric label.
  expect(await observability.prometheusMetrics()).not.toMatch(/purpose="/);
});

test("a replayed or mislabelled report cannot change the canonical event's purpose", async () => {
  captureBilling();
  const { observability, logged } = observed();
  const { stored, publish } = durableEvents();
  const base = callInput(observability, publish);
  const titleUsage = { responseId: "msg_title", usage } as any;
  const state = createSessionTitleModelUsageEventState();
  const emitted = new Set<string>();

  expect(
    await processSessionTitleModelUsageEvent({
      ...base,
      model: TITLE_MODEL,
      usage: titleUsage,
      state,
      emittedSourceKeys: emitted,
    }),
  ).toEqual({ status: "processed", sourceKey: "msg_title", authoritative: true });
  // The same process sees the terminal report again: claimed before any side effect.
  expect(
    await processSessionTitleModelUsageEvent({
      ...base,
      model: TITLE_MODEL,
      usage: titleUsage,
      state,
      emittedSourceKeys: emitted,
    }),
  ).toEqual({ status: "duplicate", sourceKey: "msg_title" });
  // A restarted worker replays the same provider response with fresh process state.
  expect(
    await processSessionTitleModelUsageEvent({
      ...base,
      turnAttemptId: "attempt-2",
      model: TITLE_MODEL,
      usage: titleUsage,
      state: createSessionTitleModelUsageEventState(),
      emittedSourceKeys: new Set(),
    }),
  ).toEqual({ status: "processed", sourceKey: "msg_title", authoritative: false });
  // Even a writer that labels the same response differently is only a duplicate.
  expect(
    await emitModelCallUsage({
      observability,
      publish,
      accountId: "acct-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      provider: PROVIDER,
      providerApi: "anthropic-messages",
      model: MAIN_MODEL,
      purpose: "main",
      sourceKey: "msg_title",
      usage: titleUsage,
    }),
  ).toBe(false);

  const canonical = stored.filter((event) => event.turnAssociation === "current");
  expect(canonical.map((event) => [event.payload.purpose, event.payload.model])).toEqual([
    ["session-title", TITLE_MODEL],
  ]);
  expect(
    stored
      .filter((event) => event.turnAssociation === "duplicate")
      .map((event) => [event.payload.purpose, event.duplicateOfEventId]),
  ).toEqual([
    ["session-title", canonical[0]!.id],
    ["main", canonical[0]!.id],
  ]);
  // Only the canonical emission is observed as authoritative.
  expect(logged).toHaveLength(1);
});

test("an event written before purpose existed stays unlabelled after a newer replay", async () => {
  captureBilling();
  const { observability } = observed();
  const { stored, publish } = durableEvents();
  // A pre-upgrade worker committed this title usage without a purpose.
  await publish([
    {
      type: "agent.model.usage",
      payload: {
        turnId: "turn-1",
        sourceKey: "msg_legacy",
        model: TITLE_MODEL,
        provider: PROVIDER,
      },
    },
  ]);
  const replay = await processSessionTitleModelUsageEvent({
    ...callInput(observability, publish),
    model: TITLE_MODEL,
    usage: { responseId: "msg_legacy", usage } as any,
    state: createSessionTitleModelUsageEventState(),
    emittedSourceKeys: new Set(),
  });
  expect(replay).toEqual({ status: "processed", sourceKey: "msg_legacy", authoritative: false });
  expect(stored[0]!.payload).not.toHaveProperty("purpose");
  expect(stored[1]).toMatchObject({
    turnAssociation: "duplicate",
    duplicateOfEventId: stored[0]!.id,
    payload: { purpose: "session-title" },
  });
});

test("the aggregate fallback and the summarizer call sites keep their purpose", () => {
  // Whitespace-normalized, so the formatter's line wrapping does not matter.
  const source = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ");
  const stream = source("../src/activities/agent-turn/stream-attempt.ts");
  const compaction = source("../src/activities/agent-turn/compaction-prep.ts");
  // The aggregate fallback is emitted inline and bills the turn's own model as a main call.
  expect(stream).toContain(
    'model: turnExecutionPolicy.productModelId, purpose: "main", sourceKey: aggregateSourceKey,',
  );
  // Title usage goes through the session-title processor.
  expect(stream).toContain("await processSessionTitleModelUsageEvent({");
  // Every summarizer path shares one callback that keeps the default compaction kind.
  expect(compaction).toContain("await processCompactionModelUsageEvent({");
  expect(compaction).not.toContain("sourceKind");
});

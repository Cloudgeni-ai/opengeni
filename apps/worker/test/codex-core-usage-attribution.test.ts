import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RunRawModelStreamEvent } from "@openai/agents-core";
import * as opengeniDb from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  createCompactionModelUsageEventState,
  createModelResponseEventState,
  processCompactionModelUsageEvent,
  processModelResponseTerminalEvent,
  processSessionTitleModelUsageEvent,
  recordAuthoritativeModelCallFact,
} from "../src/activities/agent-turn/model-usage";

// Billing attribution of core Codex model calls (M3 PR 2c): every usage path
// writes the served core connection into model_call_facts.connection_id.

const CONNECTION = "77777777-7777-4777-8777-777777777777";
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function capture() {
  const facts: Array<Record<string, unknown>> = [];
  const usage = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
  const fact = spyOn(opengeniDb, "recordModelCallFact").mockImplementation(async (_db, input) => {
    facts.push(input as unknown as Record<string, unknown>);
    return undefined as never;
  });
  restores.push(
    () => usage.mockRestore(),
    () => fact.mockRestore(),
  );
  return facts;
}

const observability = createObservability(testSettings(), { component: "worker" });
const publish = async (batch: any[]) => ({
  accepted: true,
  events: batch.map((event) => ({
    ...event,
    id: crypto.randomUUID(),
    turnAssociation: "current" as const,
  })),
});
const common = {
  dispatchId: "activity-A",
  settings: testSettings(),
  db: {} as any,
  observability,
  publish: publish as any,
  accountId: "acct-1",
  workspaceId: "ws-1",
  sessionId: "sess-1",
  turnId: "turn-1",
  turnAttemptId: "attempt-1",
  provider: "codex-subscription",
  providerApi: "responses" as const,
  model: "codex/gpt-5.6-sol",
  externallyBilled: true,
  servingCredentialId: CONNECTION,
  priorSessionCredentialId: CONNECTION,
  renewLease: async () => undefined,
  leaseLost: () => false,
  leaseLostMessage: "lease lost",
};
const usage = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  inputTokensDetails: { cached_tokens: 80 },
};

test("streamed responses attribute the fact to the core connection", async () => {
  const facts = capture();
  const event = new RunRawModelStreamEvent({
    type: "response_done",
    response: { id: "resp-stream", output: [], usage },
  } as any);
  await processModelResponseTerminalEvent({
    ...common,
    event: event as any,
    state: createModelResponseEventState(),
    metricProvider: "codex-subscription",
    emittedSourceKeys: new Set(),
    setLastInputTokens: async () => undefined,
    subscriptionConnectionId: CONNECTION,
  });
  expect(facts.map((fact) => fact.connectionId)).toEqual([CONNECTION]);
});

test("compaction summaries and session titles attribute the fact to the core connection", async () => {
  const facts = capture();
  await processCompactionModelUsageEvent({
    ...common,
    usage: { responseId: "resp-compaction", usage } as any,
    state: createCompactionModelUsageEventState(new Set()),
    emittedSourceKeys: new Set(),
    subscriptionConnectionId: CONNECTION,
  });
  await processSessionTitleModelUsageEvent({
    ...common,
    usage: { responseId: "resp-title", usage } as any,
    state: createCompactionModelUsageEventState(new Set()),
    emittedSourceKeys: new Set(),
    subscriptionConnectionId: CONNECTION,
  });
  expect(facts.map((fact) => fact.connectionId)).toEqual([CONNECTION, CONNECTION]);
});

test("legacy and non-subscription calls leave the connection empty", async () => {
  const facts = capture();
  await processCompactionModelUsageEvent({
    ...common,
    usage: { responseId: "resp-legacy", usage } as any,
    state: createCompactionModelUsageEventState(new Set()),
    emittedSourceKeys: new Set(),
  });
  expect(facts.map((fact) => fact.connectionId)).toEqual([null]);
});

test("a connection deleted mid-turn keeps the fact without its attribution", async () => {
  const attempts: Array<string | null> = [];
  const fact = spyOn(opengeniDb, "recordModelCallFact").mockImplementation(async (_db, input) => {
    attempts.push((input as { connectionId?: string | null }).connectionId ?? null);
    if (attempts.length === 1) {
      throw Object.assign(new Error("insert or update violates foreign key constraint"), {
        code: "23503",
      });
    }
    return undefined as never;
  });
  restores.push(() => fact.mockRestore());
  const billing = {
    upstreamProvider: null,
    billingPath: "external",
    pricedCostMicros: 0,
    estimatedProviderCostMicros: null,
    equivalentCreditCostMicros: null,
    pricingSource: null,
    listByClassMicros: null,
    normalizedUsage: {
      totalTokens: 120,
      telemetry: {
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 80,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
  } as any;
  const warnings: unknown[] = [];
  await recordAuthoritativeModelCallFact({
    db: {} as any,
    observability: { warn: (...args: unknown[]) => warnings.push(args) } as any,
    accountId: "acct-1",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    turnAttemptId: "attempt-1",
    sourceKey: "resp-deleted",
    provider: "codex-subscription",
    providerApi: "responses",
    model: "codex/gpt-5.6-sol",
    billing,
    subscriptionConnectionId: CONNECTION,
  });
  expect(attempts).toEqual([CONNECTION, null]);
  expect(warnings).toEqual([]);
});

test("the streamed, aggregate, compaction and title paths pass the core connection", () => {
  const stream = readFileSync(
    new URL("../src/activities/agent-turn/stream-attempt.ts", import.meta.url),
    "utf8",
  );
  const compaction = readFileSync(
    new URL("../src/activities/agent-turn/compaction-prep.ts", import.meta.url),
    "utf8",
  );
  const wiring =
    "subscriptionConnectionId: providerTurn.codexSubscriptionCore?.connectionId ?? null";
  // Title usage, the streamed terminal response and the aggregate fallback.
  expect(stream.split(wiring).length - 1).toBe(3);
  expect(compaction.split(wiring).length - 1).toBe(1);
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { RunRawModelStreamEvent } from "@openai/agents-core";
import { modelCallProcessingResidency } from "@opengeni/contracts";
import * as opengeniDb from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import { useNoSessionUsageLimitForFakeDatabases } from "@opengeni/testing/session-usage-limits";
import {
  createModelResponseEventState,
  processModelResponseTerminalEvent,
} from "../src/activities/agent-turn/model-usage";
useNoSessionUsageLimitForFakeDatabases();

// A deployment-paid (credit-billed) turn that ran OpenAI's hosted web search
// pays for those searches: the main model-response path counts the
// `web_search_call` items and settles them as a separate web-search debit.
// The user's own keys and subscriptions (externally billed) are unchanged.

const TURN = "44444444-4444-4444-8444-444444444444";
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function spyWrites() {
  const afterUse: Array<Record<string, unknown>> = [];
  const spies = [
    spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never),
    spyOn(opengeniDb, "recordModelCallFact").mockResolvedValue({
      promptCacheDiagnostics: null,
    } as never),
    spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(
      async (_db, input) =>
        ({
          balance: {},
          debitedMicros: input.requestedAmountMicros,
          grantDebitedMicros: 0,
        }) as never,
    ),
    spyOn(opengeniDb, "applyCreditDebitAfterUse").mockImplementation(async (_db, input) => {
      afterUse.push(input as unknown as Record<string, unknown>);
      return { balance: {}, debitedMicros: input.amountMicros } as never;
    }),
    spyOn(opengeniDb, "creditDebitAttributionForTurn").mockImplementation(
      async (_db, input) =>
        ({ kind: "turn", turnId: input.turnId, initiatingHumanSubjectId: null }) as never,
    ),
    spyOn(opengeniDb, "withRlsContext").mockImplementation(
      (async (database: unknown, _context: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        await fn(database)) as never,
    ),
  ];
  restores.push(() => {
    for (const spy of spies) spy.mockRestore();
  });
  return afterUse;
}

const publish = (async (batch: Array<{ type: string; payload?: unknown }>) => ({
  accepted: true,
  canonicalStartupMilestones: [],
  events: batch.map((event) => ({
    id: crypto.randomUUID(),
    type: event.type,
    payload: event.payload,
    turnAssociation: "current",
  })),
})) as any;

const settings = testSettings({
  billingMode: "stripe",
  usageLimitsMode: "none",
  modelPricingJson: JSON.stringify({
    "gpt-hosted": { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 0 },
  }),
});

async function settleResponse(externallyBilled: boolean) {
  await processModelResponseTerminalEvent({
    event: new RunRawModelStreamEvent({
      type: "response_done",
      response: {
        id: "resp_hosted_search",
        usage: { inputTokens: 1_000, outputTokens: 10, totalTokens: 1_010 },
        output: [
          { type: "hosted_tool_call", name: "web_search_call", status: "completed" },
          { type: "hosted_tool_call", name: "web_search_call", status: "completed" },
          { type: "message", role: "assistant", status: "completed", content: [] },
        ],
      },
    } as any) as any,
    state: createModelResponseEventState(new Set()),
    dispatchId: "dispatch-1",
    settings,
    db: {} as any,
    observability: createObservability(testSettings(), { component: "worker" }) as any,
    publish,
    accountId: "acct-1",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    turnId: TURN,
    turnAttemptId: "attempt-1",
    provider: "openai",
    providerApi: "responses",
    model: "gpt-hosted",
    metricProvider: "openai",
    externallyBilled,
    chargesOpenGeniCredits: !externallyBilled,
    countsTowardTokenCap: !externallyBilled,
    servingCredentialId: null,
    priorSessionCredentialId: null,
    emittedSourceKeys: new Set(),
    renewLease: async () => undefined,
    leaseLost: () => false,
    leaseLostMessage: "lease lost",
    setLastInputTokens: async () => undefined,
    processingResidency: modelCallProcessingResidency(null),
  });
}

describe("hosted web search on a credit-billed turn", () => {
  test("OpenAI's hosted searches are charged as a separate web-search debit", async () => {
    const debits = spyWrites();
    await settleResponse(false);
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      type: "web_search_debit",
      amountMicros: 21_000,
      idempotencyKey: `credit:web_search_debit:hosted:${TURN}:resp_hosted_search`,
      metadata: { requests: 2, providerCostMicros: 20_000, marginBps: 500 },
    });
  });

  test("an externally billed turn is never charged for hosted search", async () => {
    const debits = spyWrites();
    await settleResponse(true);
    expect(debits).toEqual([]);
  });
});

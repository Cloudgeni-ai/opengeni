import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { RunRawModelStreamEvent } from "@openai/agents-core";
import { DEFAULT_BILLING_LEGACY_ACCOUNT_IDS } from "@opengeni/config";
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

async function settleResponse(
  externallyBilled: boolean,
  withUsage = true,
  options: {
    responseId?: string;
    state?: ReturnType<typeof createModelResponseEventState>;
    accountId?: string;
  } = {},
) {
  return await processModelResponseTerminalEvent({
    event: new RunRawModelStreamEvent({
      type: "response_done",
      response: {
        id: options.responseId ?? "resp_hosted_search",
        ...(withUsage
          ? { usage: { inputTokens: 1_000, outputTokens: 10, totalTokens: 1_010 } }
          : {}),
        output: [
          { type: "hosted_tool_call", name: "web_search_call", status: "completed" },
          { type: "hosted_tool_call", name: "web_search_call", status: "completed" },
          { type: "message", role: "assistant", status: "completed", content: [] },
        ],
      },
    } as any) as any,
    state: options.state ?? createModelResponseEventState(new Set()),
    dispatchId: "dispatch-1",
    settings,
    db: {} as any,
    observability: createObservability(testSettings(), { component: "worker" }) as any,
    publish,
    accountId: options.accountId ?? "acct-1",
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
      // Plan credit and grants listing the turn's model pay for the tool.
      usage: { kind: "tool", modelId: "gpt-hosted" },
      idempotencyKey: `credit:web_search_debit:hosted:${TURN}:resp_hosted_search`,
      metadata: { requests: 2, providerCostMicros: 20_000, marginBps: 500 },
    });
  });

  test("searches of a response without usage are charged for that response alone", async () => {
    const debits = spyWrites();
    const result = await settleResponse(false, false);
    expect(result).toMatchObject({ status: "processed", usageReported: false });
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      type: "web_search_debit",
      amountMicros: 21_000,
      usage: { kind: "tool", modelId: "gpt-hosted" },
      idempotencyKey: `credit:web_search_debit:hosted:${TURN}:resp_hosted_search`,
      metadata: { requests: 2 },
    });
  });

  test("a stream mixing responses with and without usage charges every response's searches once", async () => {
    const debits = spyWrites();
    // Once one response reports usage the stream skips the aggregate
    // fallback, so the response without usage must settle its own searches.
    const state = createModelResponseEventState(new Set());
    await settleResponse(false, true, { responseId: "resp_with_usage", state });
    await settleResponse(false, false, { responseId: "resp_without_usage", state });
    // A replayed terminal event of the same response is not charged again.
    expect(
      await settleResponse(false, false, { responseId: "resp_without_usage", state }),
    ).toMatchObject({ status: "duplicate" });
    expect(debits.map((debit) => [debit.idempotencyKey, debit.amountMicros])).toEqual([
      [`credit:web_search_debit:hosted:${TURN}:resp_with_usage`, 21_000],
      [`credit:web_search_debit:hosted:${TURN}:resp_without_usage`, 21_000],
    ]);
  });

  test("an externally billed turn is never charged for hosted search", async () => {
    const debits = spyWrites();
    await settleResponse(true);
    await settleResponse(true, false, { responseId: "resp_external_without_usage" });
    expect(debits).toEqual([]);
  });

  test("internal accounts (CloudGeni and our team) are never charged for hosted search", async () => {
    const debits = spyWrites();
    expect(DEFAULT_BILLING_LEGACY_ACCOUNT_IDS).toContain("25eacc5d-f383-4f79-910a-b3d11dbf1310");
    for (const [index, accountId] of DEFAULT_BILLING_LEGACY_ACCOUNT_IDS.entries()) {
      await settleResponse(false, true, { responseId: `resp_legacy_usage_${index}`, accountId });
      await settleResponse(false, false, {
        responseId: `resp_legacy_no_usage_${index}`,
        accountId,
      });
    }
    expect(debits).toEqual([]);
  });
});

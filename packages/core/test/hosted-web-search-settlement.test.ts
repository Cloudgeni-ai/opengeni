import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { OPENGENI_GATEWAY_MODELS } from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { normalizeModelCallUsage } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing/settings";
import {
  settleModelUsage,
  type ModelUsageSettlementInput,
} from "../src/billing/model-usage-settlement";
import { WEB_SEARCH_DEBIT_TYPE } from "../src/domain/web-search-billing";

// Hosted (provider-run) web search is not in the token price: a credit-billed
// response that reports searches is charged them as a separate, idempotent
// web-search debit. Externally billed, free-policy, billing-off and
// Gateway-reported responses are never charged for them.

const ACCOUNT = "acct-hosted-search";
const WORKSPACE = "ws-hosted-search";
const TURN = "44444444-4444-4444-8444-444444444444";
const db = {} as Database;

type Call = { fn: string; input: Record<string, unknown> };

function spyWrites() {
  const calls: Call[] = [];
  const spies = [
    spyOn(opengeniDb, "recordUsageEvent").mockImplementation(async (_db, input) => {
      calls.push({ fn: "usage", input: input as unknown as Record<string, unknown> });
      return undefined as never;
    }),
    spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(async (_db, input) => {
      calls.push({ fn: "model_debit", input: input as unknown as Record<string, unknown> });
      return { balance: {}, debitedMicros: input.requestedAmountMicros } as never;
    }),
    spyOn(opengeniDb, "applyCreditDebitAfterUse").mockImplementation(async (_db, input) => {
      calls.push({ fn: "after_use_debit", input: input as unknown as Record<string, unknown> });
      return { balance: {}, debitedMicros: input.amountMicros } as never;
    }),
    spyOn(opengeniDb, "creditDebitAttributionForTurn").mockImplementation(
      async (_db, input) =>
        ({ kind: "turn", turnId: input.turnId, initiatingHumanSubjectId: "user:1" }) as never,
    ),
    spyOn(opengeniDb, "withRlsContext").mockImplementation(
      (async (database: unknown, _context: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        await fn(database)) as never,
    ),
    spyOn(opengeniDb, "settleSessionUsageReceipt").mockImplementation(async () => {
      return { outcome: "recorded" as const, state: null };
    }),
  ];
  return {
    calls,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

let active: ReturnType<typeof spyWrites> | null = null;
afterEach(() => {
  active?.restore();
  active = null;
});

const PRICED = JSON.stringify({
  "priced-model": {
    inputMicrosPerMillionTokens: 2_000_000,
    outputMicrosPerMillionTokens: 8_000_000,
  },
});

const billed = () =>
  testSettings({ billingMode: "stripe", usageLimitsMode: "none", modelPricingJson: PRICED });

function settlement(overrides: Partial<ModelUsageSettlementInput> = {}): ModelUsageSettlementInput {
  return {
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    model: "priced-model",
    chargesOpenGeniCredits: true,
    countsTowardTokenCap: true,
    normalizedUsage: normalizeModelCallUsage({
      inputTokens: 1_000,
      outputTokens: 500,
      totalTokens: 1_500,
    }),
    sourceId: `${TURN}:resp_1`,
    sessionId: "session-1",
    turnId: TURN,
    turnAttemptId: "attempt-1",
    hostedWebSearchRequests: 2,
    ...overrides,
  };
}

const searchDebits = (calls: Call[]) =>
  calls.filter(
    (call) => call.fn === "after_use_debit" && call.input.type === WEB_SEARCH_DEBIT_TYPE,
  );

describe("hosted web search settlement", () => {
  test("a credit-billed response is charged its hosted searches at list price plus 5%", async () => {
    active = spyWrites();
    await settleModelUsage(billed(), db, settlement());
    const debits = searchDebits(active.calls);
    expect(debits).toHaveLength(1);
    // 2 searches * $10/1k = 20_000 micros, +5% = 21_000.
    expect(debits[0]!.input).toMatchObject({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      amountMicros: 21_000,
      sourceType: "web_search",
      sourceId: `hosted:${TURN}:resp_1`,
      idempotencyKey: `credit:web_search_debit:hosted:${TURN}:resp_1`,
      // The plan and grants covering the response's model pay first.
      usage: "priced-model",
      metadata: {
        turnId: TURN,
        initiatingHumanSubjectId: "user:1",
        provider: "hosted",
        operation: "search",
        model: "priced-model",
        requests: 2,
        providerCostMicros: 20_000,
        marginBps: 500,
        basis: "list_price",
      },
    });
    // The model debit is separate and unchanged.
    expect(active.calls.filter((call) => call.fn === "model_debit")).toHaveLength(1);
    const usage = active.calls
      .filter((call) => call.fn === "usage" && call.input.sourceResourceType === "web_search")
      .map((call) => [call.input.eventType, call.input.quantity, call.input.idempotencyKey]);
    expect(usage).toEqual([
      ["web_search.search_requests", 2, `usage:web_search.search_requests:hosted:${TURN}:resp_1`],
      ["web_search.cost", 21_000, `usage:web_search.cost:hosted:${TURN}:resp_1`],
    ]);
  });

  test("managed usage limits charge hosted searches too", async () => {
    active = spyWrites();
    await settleModelUsage(
      testSettings({
        billingMode: "disabled",
        usageLimitsMode: "managed",
        modelPricingJson: PRICED,
      }),
      db,
      settlement({ hostedWebSearchRequests: 1 }),
    );
    expect(searchDebits(active.calls).map((call) => call.input.amountMicros)).toEqual([10_500]);
  });

  test("externally billed, billing-off and search-free responses are never charged", async () => {
    for (const [settings, overrides] of [
      // The user's own key or subscription (also free-policy models).
      [billed(), { chargesOpenGeniCredits: false, countsTowardTokenCap: false }],
      // A self-hosted deployment without credit billing.
      [testSettings({ billingMode: "disabled", modelPricingJson: PRICED }), {}],
      // No hosted searches reported.
      [billed(), { hostedWebSearchRequests: undefined }],
    ] as const) {
      active = spyWrites();
      await settleModelUsage(settings, db, settlement(overrides));
      expect(searchDebits(active.calls)).toEqual([]);
      expect(
        active.calls.some(
          (call) => call.fn === "usage" && call.input.sourceResourceType === "web_search",
        ),
      ).toBe(false);
      active.restore();
      active = null;
    }
  });

  test("a Gateway-reported cost already includes search and is not charged again", async () => {
    active = spyWrites();
    await settleModelUsage(
      testSettings({
        billingMode: "stripe",
        usageLimitsMode: "managed",
        vercelAiGatewayApiKey: "vck_test",
      }),
      db,
      settlement({
        model: OPENGENI_GATEWAY_MODELS.deepseek.productId,
        gatewayBilling: { finalProvider: "baseten", inferenceCostUsd: "0.0200" },
      }),
    );
    expect(active.calls.filter((call) => call.fn === "model_debit")).toHaveLength(1);
    expect(searchDebits(active.calls)).toEqual([]);
  });

  test("a legacy billing account (CloudGeni's host account) is not charged hosted searches", async () => {
    const legacy = "25eacc5d-f383-4f79-910a-b3d11dbf1310";
    active = spyWrites();
    await settleModelUsage(billed(), db, settlement({ accountId: legacy }));
    // The model debit is unchanged; no hosted-search usage or debit at all.
    expect(active.calls.filter((call) => call.fn === "model_debit")).toHaveLength(1);
    expect(searchDebits(active.calls)).toEqual([]);
    expect(
      active.calls.some(
        (call) => call.fn === "usage" && call.input.sourceResourceType === "web_search",
      ),
    ).toBe(false);
    active.restore();
    // Removing it from OPENGENI_BILLING_LEGACY_ACCOUNT_IDS charges it like anyone.
    active = spyWrites();
    await settleModelUsage(
      testSettings({
        billingMode: "stripe",
        usageLimitsMode: "none",
        modelPricingJson: PRICED,
        billingLegacyAccountIds: [],
      }),
      db,
      settlement({ accountId: legacy }),
    );
    expect(searchDebits(active.calls).map((call) => call.input.amountMicros)).toEqual([21_000]);
  });

  test("the hosted-search debit uses the turn's billing origin", async () => {
    // The response's origin, as the model debit uses it.
    active = spyWrites();
    await settleModelUsage(billed(), db, settlement({ billingOrigin: "api" }));
    expect(searchDebits(active.calls)[0]!.input).toMatchObject({ usageOrigin: "api" });
    expect(active.calls.find((call) => call.fn === "model_debit")!.input).toMatchObject({
      usageOrigin: "api",
    });
    active.restore();
    // Otherwise the turn's frozen origin from its attribution.
    active = spyWrites();
    spyOn(opengeniDb, "creditDebitAttributionForTurn").mockImplementation(
      async (_db, input) =>
        ({
          kind: "turn",
          turnId: input.turnId,
          initiatingHumanSubjectId: null,
          billingOrigin: "api",
        }) as never,
    );
    await settleModelUsage(billed(), db, settlement());
    expect(searchDebits(active.calls)[0]!.input).toMatchObject({
      usageOrigin: "api",
      metadata: { billingOrigin: "api" },
    });
  });
});

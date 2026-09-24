import { describe, expect, spyOn, test } from "bun:test";
import { OPENGENI_GATEWAY_MODELS } from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import type { Database } from "@opengeni/db";
import {
  ensureRunAllowed,
  modelCallReservationQuantities,
  recordModelUsageAndDebitCredits,
  usageReservationIdempotencyKey,
  usageReservationReleaseEvents,
} from "../src/activities/agent-turn";

const ACCOUNT = "acct-1";
const WORKSPACE = "ws-1";
const db = {} as Database;

// Live config that reproduces the bug: stripe + managed, 0 OpenGeni credits.
function billedSettings() {
  return testSettings({ billingMode: "stripe", usageLimitsMode: "managed" });
}

function mockZeroBalance(): () => void {
  const spy = spyOn(opengeniDb, "getBillingBalance").mockResolvedValue({
    accountId: ACCOUNT,
    balanceMicros: 0,
    currency: "usd",
    updatedAt: new Date().toISOString(),
  });
  return () => spy.mockRestore();
}

/**
 * Spy on the atomic usage+debit writer (BILL-03): one call carries the whole
 * batch — reservation releases, usage facts, and the bounded credit debit —
 * so this captures what used to need two separate spies.
 */
function mockAtomicWrites(input?: { failOnDebit?: boolean }) {
  const usageEvents: Array<Record<string, any>> = [];
  const creditDebits: Array<Record<string, any>> = [];
  const spy = spyOn(opengeniDb, "recordUsageEventsAndApplyCreditDebit").mockImplementation(
    async (_db, batch) => {
      if (input?.failOnDebit && batch.creditDebit) {
        throw new Error("credits must NOT be debited here");
      }
      usageEvents.push(...batch.usageEvents);
      if (batch.creditDebit) creditDebits.push(batch.creditDebit);
      return {
        events: [],
        debit: batch.creditDebit
          ? {
              balance: {
                accountId: ACCOUNT,
                balanceMicros: 1_000_000,
                currency: "usd",
                updatedAt: new Date().toISOString(),
              },
              debitedMicros: batch.creditDebit.requestedAmountMicros,
            }
          : null,
      };
    },
  );
  return { usageEvents, creditDebits, spy };
}

describe("worker ensureRunAllowed — codex bypass", () => {
  test("(a) codex turn with 0 credits does NOT throw (credit gate skipped, balance never read)", async () => {
    let balanceRead = false;
    const spy = spyOn(opengeniDb, "getBillingBalance").mockImplementation(async () => {
      balanceRead = true;
      return {
        accountId: ACCOUNT,
        balanceMicros: 0,
        currency: "usd",
        updatedAt: new Date().toISOString(),
      };
    });
    try {
      await ensureRunAllowed(billedSettings(), db, ACCOUNT, WORKSPACE, /* isCodexTurn */ true);
      expect(balanceRead).toBe(false); // short-circuited before any balance read
    } finally {
      spy.mockRestore();
    }
  });

  test("(c) a normal turn with 0 credits still throws insufficient OpenGeni credits", async () => {
    const restore = mockZeroBalance();
    try {
      await expect(
        ensureRunAllowed(billedSettings(), db, ACCOUNT, WORKSPACE, /* isCodexTurn */ false),
      ).rejects.toThrow("insufficient OpenGeni credits");
    } finally {
      restore();
    }
  });

  test("a deployment-funded free turn skips credits but still enforces the token cap", async () => {
    const balanceSpy = spyOn(opengeniDb, "getBillingBalance").mockImplementation(async () => {
      throw new Error("free turns must not read the credit balance");
    });
    const usageSpy = spyOn(opengeniDb, "sumUsageQuantity").mockResolvedValue(100);
    const openSpy = spyOn(opengeniDb, "openUsageReservationQuantity").mockResolvedValue(0);
    try {
      await expect(
        ensureRunAllowed(
          testSettings({
            billingMode: "stripe",
            usageLimitsMode: "managed",
            staticUsageLimitsJson: JSON.stringify({ maxMonthlyTokensPerWorkspace: 100 }),
          }),
          db,
          ACCOUNT,
          WORKSPACE,
          false,
          undefined,
          false,
          true,
        ),
      ).rejects.toThrow("monthly token limit reached (100)");
      expect(balanceSpy).not.toHaveBeenCalled();
      expect(usageSpy).toHaveBeenCalled();
    } finally {
      balanceSpy.mockRestore();
      usageSpy.mockRestore();
      openSpy.mockRestore();
    }
  });
});

describe("worker ensureRunAllowed — mid-stream monthly cost cap (BILL-01)", () => {
  const costCapSettings = () =>
    testSettings({
      billingMode: "stripe",
      usageLimitsMode: "managed",
      staticUsageLimitsJson: JSON.stringify({ maxMonthlyCostMicrosPerAccount: 1_000 }),
    });

  function mockPositiveBalance() {
    return spyOn(opengeniDb, "getBillingBalance").mockResolvedValue({
      accountId: ACCOUNT,
      balanceMicros: 10_000_000,
      currency: "usd",
      updatedAt: new Date().toISOString(),
    });
  }

  test("check-only admission denies at the committed+held boundary, not just committed", async () => {
    const balanceSpy = mockPositiveBalance();
    const usageSpy = spyOn(opengeniDb, "sumUsageQuantity").mockResolvedValue(800);
    const openSpy = spyOn(opengeniDb, "openUsageReservationQuantity").mockResolvedValue(300);
    try {
      // 800 committed + 300 held by a parallel turn = 1100 >= 1000 cap, even
      // though committed usage alone (800) is below the cap.
      await expect(
        ensureRunAllowed(costCapSettings(), db, ACCOUNT, WORKSPACE, false),
      ).rejects.toThrow("monthly cost limit reached (1000)");
    } finally {
      balanceSpy.mockRestore();
      usageSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  test("a reservation request writes a bounded hold through the atomic ledger", async () => {
    const balanceSpy = spyOn(opengeniDb, "getBillingBalance").mockResolvedValue({
      accountId: ACCOUNT,
      balanceMicros: 10_000_000,
      currency: "usd",
      updatedAt: new Date().toISOString(),
    });
    const reserveSpy = spyOn(opengeniDb, "tryReserveUsageBudget").mockImplementation(
      async (_db, input) => ({
        allowed: true as const,
        holds: input.reservations.map((r) => ({
          idempotencyKey: r.idempotencyKey,
          quantity: r.quantity,
        })),
      }),
    );
    try {
      const held = await ensureRunAllowed(
        costCapSettings(),
        db,
        ACCOUNT,
        WORKSPACE,
        false,
        undefined,
        true,
        true,
        {
          sessionId: "sess-1",
          turnId: "turn-1",
          turnAttemptId: "attempt-1",
          ordinal: 1,
          tokens: 50_000,
          costMicros: 250,
        },
      );
      expect(reserveSpy).toHaveBeenCalledTimes(1);
      const arg = reserveSpy.mock.calls[0]![1];
      // The cost cap reserves against the account scope and asks for the
      // priced estimate, letting the db clamp to the remaining balance.
      const costRequest = arg.reservations.find((r) => r.eventType === "model.cost");
      expect(costRequest).toMatchObject({
        scope: "account",
        cap: 1_000,
        quantity: 250,
        reservedEventType: "model.cost.reserved",
      });
      expect(held?.costMicros).toBe(250);
      // Only the token cap requested a hold when no token cap is configured.
      expect(arg.reservations).toHaveLength(1);
    } finally {
      balanceSpy.mockRestore();
      reserveSpy.mockRestore();
    }
  });

  test("a denied reservation surfaces the cap error before inference", async () => {
    const balanceSpy = mockPositiveBalance();
    const reserveSpy = spyOn(opengeniDb, "tryReserveUsageBudget").mockResolvedValue({
      allowed: false,
      eventType: "model.cost",
      cap: 1_000,
      used: 900,
      openReservations: 200,
    });
    try {
      await expect(
        ensureRunAllowed(costCapSettings(), db, ACCOUNT, WORKSPACE, false, undefined, true, true, {
          sessionId: "sess-1",
          turnId: "turn-1",
          turnAttemptId: "attempt-1",
          ordinal: 1,
          costMicros: 250,
        }),
      ).rejects.toThrow("monthly cost limit reached (1000)");
    } finally {
      balanceSpy.mockRestore();
      reserveSpy.mockRestore();
    }
  });

  test("an externally billed turn never reserves or reads the cost cap", async () => {
    const usageSpy = spyOn(opengeniDb, "sumUsageQuantity").mockResolvedValue(0);
    const reserveSpy = spyOn(opengeniDb, "tryReserveUsageBudget").mockImplementation(async () => {
      throw new Error("external turns must not reserve OpenGeni budget");
    });
    try {
      await ensureRunAllowed(
        costCapSettings(),
        db,
        ACCOUNT,
        WORKSPACE,
        /* isExternallyBilledTurn */ true,
        undefined,
        /* chargesOpenGeniCredits */ false,
        /* countsTowardTokenCap */ false,
        {
          sessionId: "sess-1",
          turnId: "turn-1",
          turnAttemptId: "attempt-1",
          ordinal: 1,
          tokens: 50_000,
          costMicros: 250,
        },
      );
      expect(reserveSpy).not.toHaveBeenCalled();
      // agent_run count cap still sums, but neither usage cap is consulted.
      const eventTypes = usageSpy.mock.calls.map((call) => call[1].eventType);
      expect(eventTypes).not.toContain("model.cost");
      expect(eventTypes).not.toContain("model.tokens");
    } finally {
      usageSpy.mockRestore();
      reserveSpy.mockRestore();
    }
  });
});

describe("pre-inference reservation estimates (BILL-02)", () => {
  test("bound = actual provider-bound prompt + reserved output headroom, clamped to the window", () => {
    const settings = testSettings({
      contextWindowTokens: 1_000,
      contextReservedOutputTokens: 200,
      modelPricingJson: JSON.stringify({
        "scripted-model": {
          inputMicrosPerMillionTokens: 1_000_000,
          outputMicrosPerMillionTokens: 2_000_000,
        },
      }),
    });
    const bound = modelCallReservationQuantities({
      settings,
      model: "scripted-model",
      promptTokens: 500,
      contextWindowTokens: settings.contextWindowTokens,
    });
    expect(bound.tokens).toBe(700);
    // 500 input micros + 400 output micros.
    expect(bound.costMicros).toBe(900);
    // A call that would overflow the window is clamped to it — the provider's
    // own context ceiling enforces the tail of the output cap.
    const clamped = modelCallReservationQuantities({
      settings,
      model: "scripted-model",
      promptTokens: 950,
      contextWindowTokens: settings.contextWindowTokens,
    });
    expect(clamped.tokens).toBe(1_000);
  });

  test("unpriceable models skip the cost hold and stay check-only", () => {
    const settings = testSettings({
      contextWindowTokens: 1_000,
      contextReservedOutputTokens: 200,
    });
    const bound = modelCallReservationQuantities({
      settings,
      model: "unpriced-model",
      promptTokens: 500,
      contextWindowTokens: settings.contextWindowTokens,
    });
    expect(bound.tokens).toBe(700);
    expect(bound.costMicros).toBeNull();
  });

  test("release rows negate the exact committed hold under the same key family", () => {
    const releases = usageReservationReleaseEvents({
      reservations: [
        [1, { tokens: 700, costMicros: 900 }],
        [2, { costMicros: 50 }],
      ],
      sessionId: "sess-1",
      turnId: "turn-1",
      turnAttemptId: "attempt-1",
    });
    expect(releases).toHaveLength(3);
    expect(releases[0]).toMatchObject({
      eventType: "model.tokens.reserved",
      quantity: -700,
      sessionId: "sess-1",
      turnId: "turn-1",
      turnAttemptId: "attempt-1",
      idempotencyKey: `${usageReservationIdempotencyKey(
        "model.tokens.reserved",
        "turn-1",
        "attempt-1",
        1,
      )}:release`,
    });
    expect(releases[1]?.eventType).toBe("model.cost.reserved");
    expect(releases[1]?.quantity).toBe(-900);
    expect(releases[2]?.quantity).toBe(-50);
  });
});

describe("worker recordModelUsageAndDebitCredits — codex usage recording", () => {
  test("managed Gateway uses exact reported cost and records the serving provider", async () => {
    const { usageEvents, creditDebits, spy } = mockAtomicWrites();
    try {
      const billing = await recordModelUsageAndDebitCredits(
        testSettings({
          billingMode: "stripe",
          usageLimitsMode: "managed",
          vercelAiGatewayApiKey: "vck_test",
        }),
        db,
        {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          sessionId: "sess-gateway",
          turnId: "turn-gateway",
          turnAttemptId: "attempt-gateway",
          model: OPENGENI_GATEWAY_MODELS.deepseek.productId,
          externallyBilled: false,
          gatewayBilling: { finalProvider: "baseten", inferenceCostUsd: "0.00000325" },
          usage: {
            inputTokens: 9,
            outputTokens: 8,
            totalTokens: 17,
            inputTokensDetails: { cached_tokens: 3 },
          },
          sourceKey: "response-gateway",
        },
      );

      expect(usageEvents).toContainEqual(
        expect.objectContaining({ eventType: "model.cost", quantity: 4 }),
      );
      expect(creditDebits).toHaveLength(1);
      expect(creditDebits[0]).toMatchObject({
        requestedAmountMicros: 4,
        metadata: { gatewayProvider: "baseten", cachedTokens: 3 },
      });
      expect(billing).toMatchObject({
        pricedCostMicros: 4,
        equivalentCreditCostMicros: 4,
        upstreamProvider: "baseten",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("managed Gateway rejects an unapproved reported provider before recording usage", async () => {
    const { spy } = mockAtomicWrites();
    try {
      await expect(
        recordModelUsageAndDebitCredits(
          testSettings({
            billingMode: "stripe",
            usageLimitsMode: "managed",
            vercelAiGatewayApiKey: "vck_test",
          }),
          db,
          {
            accountId: ACCOUNT,
            workspaceId: WORKSPACE,
            sessionId: "sess-gateway",
            turnId: "turn-gateway-rejected",
            turnAttemptId: "attempt-gateway-rejected",
            model: OPENGENI_GATEWAY_MODELS.deepseek.productId,
            externallyBilled: false,
            gatewayBilling: { finalProvider: "unapproved", inferenceCostUsd: "0.01" },
            usage: { inputTokens: 9, outputTokens: 8, totalTokens: 17 },
            sourceKey: "response-gateway-rejected",
          },
        ),
      ).rejects.toThrow("AI Gateway reported unapproved provider");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("uses a database-resolved Gateway model's route policy and pricing", async () => {
    const { creditDebits, spy } = mockAtomicWrites();
    try {
      const productId = "catalog-gateway/custom-model";
      const billing = await recordModelUsageAndDebitCredits(
        testSettings({
          billingMode: "stripe",
          usageLimitsMode: "managed",
          vercelAiGatewayApiKey: "vck_test",
          resolvedGatewayModelsJson: JSON.stringify([
            {
              productId,
              workspaceProductId: "workspace-gateway/catalog-custom-model",
              upstreamModelId: "provider/custom-model",
              label: "Catalog custom model",
              providers: ["fireworks"],
              pricing: {
                inputMicrosPerMillionTokens: 100_000,
                outputMicrosPerMillionTokens: 200_000,
                marginBps: 2_500,
              },
            },
          ]),
        }),
        db,
        {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          sessionId: "sess-catalog-gateway",
          turnId: "turn-catalog-gateway",
          turnAttemptId: "attempt-catalog-gateway",
          model: productId,
          externallyBilled: false,
          gatewayBilling: { finalProvider: "fireworks", inferenceCostUsd: "0.000001" },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          sourceKey: "response-catalog-gateway",
        },
      );
      expect(billing).toMatchObject({
        pricedCostMicros: 2,
        pricingSource: "gateway_reported",
        upstreamProvider: "fireworks",
      });
      expect(creditDebits).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("(d) codex turn records model.cost=0, does NOT throw 'Missing model pricing', and never debits", async () => {
    const { usageEvents, spy } = mockAtomicWrites({ failOnDebit: true });
    try {
      await recordModelUsageAndDebitCredits(billedSettings(), db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-1",
        turnAttemptId: "attempt-1",
        model: "codex/gpt-5.6-sol", // externally billed even though comparison pricing exists
        externallyBilled: true,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        sourceKey: "response-1",
      });
      // Exactly one event: a zero-cost audit marker. NO model.tokens row (it would
      // feed the OpenGeni token cap a codex turn is exempt from).
      expect(usageEvents).toEqual([
        expect.objectContaining({ eventType: "model.cost", quantity: 0, unit: "usd_micros" }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test("(control) a normal turn still records model.tokens and a non-zero model.cost", async () => {
    const { usageEvents, spy } = mockAtomicWrites();
    try {
      // A model the test settings price (the default openaiModel). testSettings
      // ships pricing for "scripted-model"; if cost is 0 the debit is skipped, but
      // the model.tokens row and a model.cost row must still be written.
      await recordModelUsageAndDebitCredits(billedSettings(), db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-2",
        turnAttemptId: "attempt-2",
        model: "scripted-model",
        externallyBilled: false,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        sourceKey: "response-1",
      });
      expect(usageEvents.some((r) => r.eventType === "model.tokens" && r.quantity === 1500)).toBe(
        true,
      );
      expect(usageEvents.some((r) => r.eventType === "model.cost")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("a deployment-funded free turn records tokens and zero cost without debiting", async () => {
    const { usageEvents, spy } = mockAtomicWrites({ failOnDebit: true });
    try {
      const billing = await recordModelUsageAndDebitCredits(billedSettings(), db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-free",
        turnAttemptId: "attempt-free",
        model: "scripted-model",
        externallyBilled: true,
        chargesOpenGeniCredits: false,
        countsTowardTokenCap: true,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        sourceKey: "response-1",
      });
      expect(usageEvents).toEqual([
        expect.objectContaining({ eventType: "model.tokens", quantity: 1500 }),
        expect.objectContaining({ eventType: "model.cost", quantity: 0 }),
      ]);
      expect(billing?.billingPath).toBe("external");
    } finally {
      spy.mockRestore();
    }
  });

  test("static mode records the actual priced model.cost without debiting credits", async () => {
    const { usageEvents, creditDebits, spy } = mockAtomicWrites({ failOnDebit: true });
    try {
      const staticSettings = testSettings({
        billingMode: "disabled",
        usageLimitsMode: "static",
      });
      const billing = await recordModelUsageAndDebitCredits(staticSettings, db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-static",
        turnAttemptId: "attempt-static",
        model: "gpt-5.6-sol",
        externallyBilled: false,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        sourceKey: "response-1",
      });
      // The monthly cost cap reconciles against this fact: cost accounting is
      // independent of credit debiting, so a static-mode turn must still write
      // its real priced cost — never a zero marker.
      const cost = usageEvents.find((r) => r.eventType === "model.cost");
      expect(cost).toBeDefined();
      expect(cost!.quantity).toBeGreaterThan(0);
      expect(billing?.pricedCostMicros).toBe(cost!.quantity);
      expect(creditDebits).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("malformed token counts cannot create token, cost, or debit quantities", async () => {
    const { usageEvents, creditDebits, spy } = mockAtomicWrites({ failOnDebit: true });
    try {
      const malformedUsages = [
        {
          inputTokens: 1.5,
          outputTokens: Number.POSITIVE_INFINITY,
          totalTokens: Number.NaN,
        },
        {
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: Number.MAX_SAFE_INTEGER,
          totalTokens: Number.MAX_SAFE_INTEGER,
        },
        {
          inputTokens: 1_000_000_001,
          outputTokens: 1_000_000_001,
          totalTokens: 1_000_000_001,
          inputTokensDetails: { cached_tokens: 1_000_000_001 },
        },
        { inputTokens: -1, outputTokens: -2, totalTokens: -3 },
      ];
      for (const [index, usage] of malformedUsages.entries()) {
        await recordModelUsageAndDebitCredits(billedSettings(), db, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          sessionId: "sess-1",
          turnId: "turn-malformed",
          turnAttemptId: `attempt-malformed-${index}`,
          model: "gpt-5.6-sol",
          externallyBilled: false,
          usage,
          sourceKey: `response-${index}`,
        });
      }

      expect(usageEvents).toHaveLength(0);
      expect(creditDebits).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("valid SDK aggregates are billed once with one canonical cached-token total", async () => {
    const { usageEvents, creditDebits, spy } = mockAtomicWrites();
    try {
      await recordModelUsageAndDebitCredits(billedSettings(), db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-aggregate",
        turnAttemptId: "attempt-aggregate",
        model: "gpt-5.6-sol",
        externallyBilled: false,
        usage: {
          inputTokens: 3000,
          outputTokens: 30,
          totalTokens: 3030,
          requestUsageEntries: [
            {
              inputTokens: 1000,
              outputTokens: 10,
              totalTokens: 1010,
              inputTokensDetails: {
                cached_tokens: 100,
                cachedInputTokens: 999,
              },
            },
            {
              inputTokens: 2000,
              outputTokens: 20,
              totalTokens: 2020,
              inputTokensDetails: { cached_tokens: 300 },
            },
          ],
        },
        sourceKey: "aggregate",
      });

      expect(usageEvents).toContainEqual(
        expect.objectContaining({ eventType: "model.tokens", quantity: 3030 }),
      );
      expect(usageEvents.some((record) => record.eventType === "model.cost")).toBe(true);
      expect(creditDebits).toHaveLength(1);
      expect(creditDebits[0]?.metadata).toMatchObject({
        inputTokens: 3000,
        outputTokens: 30,
        totalTokens: 3030,
        cachedTokens: 400,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("inconsistent reported totals cannot suppress token rows, cost, or debit metadata", async () => {
    const settings = testSettings({
      billingMode: "stripe",
      usageLimitsMode: "managed",
      modelPricingJson: JSON.stringify({
        "scripted-model": {
          inputMicrosPerMillionTokens: 1_000_000,
          outputMicrosPerMillionTokens: 1_000_000,
        },
      }),
    });
    const { usageEvents, creditDebits, spy } = mockAtomicWrites();
    try {
      const cases = [
        {
          sourceKey: "zero-total",
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 0 },
          expectedTotal: 120,
        },
        {
          sourceKey: "low-total",
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 3 },
          expectedTotal: 120,
        },
        {
          sourceKey: "request-authority",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
            requestUsageEntries: [
              { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
              { inputTokens: 200, outputTokens: 40, totalTokens: 240 },
            ],
          },
          expectedTotal: 350,
        },
      ];
      for (const value of cases) {
        await recordModelUsageAndDebitCredits(settings, db, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          sessionId: "sess-1",
          turnId: "turn-inconsistent",
          turnAttemptId: `attempt-inconsistent-${value.expectedTotal}`,
          model: "scripted-model",
          externallyBilled: false,
          usage: value.usage,
          sourceKey: value.sourceKey,
        });
      }

      for (const value of cases) {
        expect(usageEvents).toContainEqual(
          expect.objectContaining({
            eventType: "model.tokens",
            quantity: value.expectedTotal,
            sourceResourceId: `turn-inconsistent:${value.sourceKey}`,
          }),
        );
      }
      expect(creditDebits).toHaveLength(cases.length);
      expect(creditDebits.map((input) => input.metadata.totalTokens)).toEqual(
        cases.map((value) => value.expectedTotal),
      );
      expect(creditDebits[2]?.metadata).toMatchObject({
        inputTokens: 300,
        outputTokens: 50,
        totalTokens: 350,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("worker recordModelUsageAndDebitCredits — atomic batch (BILL-03)", () => {
  test("usage facts, reservation releases, and the debit commit in ONE write", async () => {
    const settings = testSettings({
      billingMode: "stripe",
      usageLimitsMode: "managed",
      modelPricingJson: JSON.stringify({
        "scripted-model": {
          inputMicrosPerMillionTokens: 1_000_000,
          outputMicrosPerMillionTokens: 1_000_000,
        },
      }),
    });
    const { creditDebits, spy } = mockAtomicWrites();
    try {
      const releases = usageReservationReleaseEvents({
        reservations: [[1, { tokens: 800, costMicros: 900 }]],
        sessionId: "sess-1",
        turnId: "turn-atomic",
        turnAttemptId: "attempt-atomic",
      });
      await recordModelUsageAndDebitCredits(settings, db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-atomic",
        turnAttemptId: "attempt-atomic",
        model: "scripted-model",
        externallyBilled: false,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        sourceKey: "response-atomic",
        reservationReleases: releases,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const batch = spy.mock.calls[0]![1];
      // Releases land first inside the same batch as the usage facts…
      expect(batch.usageEvents[0]?.eventType).toBe("model.tokens.reserved");
      expect(batch.usageEvents[0]?.quantity).toBe(-800);
      expect(batch.usageEvents[1]?.eventType).toBe("model.cost.reserved");
      expect(batch.usageEvents[1]?.quantity).toBe(-900);
      // …then the committed facts, then the debit — one transaction.
      expect(batch.usageEvents.some((e) => e.eventType === "model.tokens")).toBe(true);
      expect(batch.usageEvents.some((e) => e.eventType === "model.cost")).toBe(true);
      expect(creditDebits).toHaveLength(1);
      expect(creditDebits[0]?.idempotencyKey).toBe(
        "credit:model_usage_debit:turn-atomic:response-atomic",
      );
    } finally {
      spy.mockRestore();
    }
  });
});

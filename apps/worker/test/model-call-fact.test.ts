import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { OPENGENI_GATEWAY_MODELS } from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createObservability } from "@opengeni/observability";

import {
  emitModelCallUsage,
  recordAuthoritativeModelCallFact,
  recordModelUsageAndDebitCredits,
  createCompactionModelUsageEventState,
  processCompactionModelUsageEvent,
  createModelResponseEventState,
  processModelResponseTerminalEvent,
} from "../src/activities/agent-turn";

const ACCOUNT = "acct-1";
const WORKSPACE = "ws-1";
const db = {} as Database;

function billedSettings() {
  return testSettings({
    billingMode: "stripe",
    usageLimitsMode: "managed",
    vercelAiGatewayApiKey: "test-gateway-key",
    modelPricingJson: JSON.stringify({
      "gpt-5.6-sol": {
        inputMicrosPerMillionTokens: 4_000_000,
        cachedInputMicrosPerMillionTokens: 400_000,
        cacheWriteMicrosPerMillionTokens: 5_000_000,
        outputMicrosPerMillionTokens: 20_000_000,
        marginBps: 500,
      },
    }),
  });
}

describe("recordAuthoritativeModelCallFact", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
  });

  /**
   * The atomic usage+debit writer (BILL-03) carries the whole batch in one
   * call; capture its usageEvents and creditDebit the way the old per-write
   * spies did.
   */
  function mockAtomicWrites(input?: { failOnDebit?: boolean }) {
    const usageEvents: Array<Record<string, any>> = [];
    const creditDebits: Array<Record<string, any>> = [];
    const spy = spyOn(opengeniDb, "recordUsageEventsAndApplyCreditDebit").mockImplementation(
      async (_db, batch) => {
        if (input?.failOnDebit && batch.creditDebit) {
          throw new Error("credits must NOT be debited for an externally billed turn");
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
    restores.push(() => spy.mockRestore());
    return { usageEvents, creditDebits, spy };
  }

  test.each([false, true])(
    "compaction settles its reservation atomically, including duplicate usage (duplicate=%s)",
    async (duplicate) => {
      const { usageEvents, creditDebits, spy } = mockAtomicWrites();
      const settings = billedSettings();
      const release = {
        eventType: "model.tokens.reserved",
        quantity: -2_000,
        unit: "tokens",
        sourceResourceType: "model_call_reservation",
        sourceResourceId: "reservation-1",
        sessionId: "sess-1",
        turnId: "turn-1",
        turnAttemptId: "attempt-1",
        idempotencyKey: "reservation-1:release",
      };
      const input: Parameters<typeof processCompactionModelUsageEvent>[0] = {
        usage: {
          responseId: "compaction-response",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        },
        state: createCompactionModelUsageEventState(
          new Set(duplicate ? ["compaction-response"] : []),
        ),
        dispatchId: "dispatch-1",
        settings,
        db,
        observability: createObservability(settings, { component: "compaction-test" }),
        publish: null,
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-1",
        turnAttemptId: "attempt-1",
        provider: "openai",
        providerApi: "responses",
        model: "gpt-5.6-sol",
        externallyBilled: false,
        servingCredentialId: null,
        priorSessionCredentialId: null,
        emittedSourceKeys: new Set(),
        renewLease: async () => undefined,
        leaseLost: () => false,
        leaseLostMessage: "lease lost",
        reservationReleases: [release],
      };
      if (!duplicate) {
        const failedCommit = new Error("Synthetic billing transaction failure");
        spy.mockRejectedValueOnce(failedCommit);
        await expect(processCompactionModelUsageEvent(input)).rejects.toBe(failedCommit);
        expect(input.state.claimedSourceKeys.has("compaction-response")).toBe(false);
        expect(input.state.usageCount).toBe(0);
      }
      const callsBeforeMalformed = spy.mock.calls.length;
      const malformed = await processCompactionModelUsageEvent({
        ...input,
        usage: {
          responseId: "compaction-response",
          usage: { inputTokens: 100, outputTokens: -1, totalTokens: 150 },
        },
      });
      expect(malformed.usageReported).toBe(false);
      expect(spy).toHaveBeenCalledTimes(callsBeforeMalformed);
      expect(input.state.claimedSourceKeys.has("compaction-response")).toBe(duplicate);
      const result = await processCompactionModelUsageEvent(input);
      expect(result.usageReported).toBe(true);
      expect(result.status).toBe(duplicate ? "duplicate" : "processed");
      expect(spy).toHaveBeenCalledTimes(duplicate ? 1 : 2);
      expect(usageEvents).toContainEqual(release);
      expect(usageEvents.filter((event) => event.eventType === "model.tokens")).toHaveLength(1);
      expect(usageEvents.find((event) => event.eventType === "model.tokens")?.quantity).toBe(150);
      expect(creditDebits).toHaveLength(1);
    },
  );

  test.each([
    { inputTokens: 100 },
    { outputTokens: 50 },
    { inputTokens: 100, outputTokens: 50, inputTokensDetails: { cached_tokens: -1 } },
  ])(
    "incomplete or rejected telemetry keeps a hold until complete usage arrives: %j",
    async (usage) => {
      const { usageEvents, creditDebits, spy } = mockAtomicWrites();
      const release = {
        eventType: "model.tokens.reserved",
        quantity: -2_000,
        unit: "tokens",
        sourceResourceType: "model_call_reservation",
        sourceResourceId: "reservation-malformed",
        sessionId: "sess-1",
        turnId: "turn-1",
        turnAttemptId: "attempt-1",
        idempotencyKey: "reservation-malformed:release",
      };
      const input: Parameters<typeof recordModelUsageAndDebitCredits>[2] = {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-1",
        turnAttemptId: "attempt-1",
        model: "gpt-5.6-sol",
        externallyBilled: false,
        sourceKey: "malformed-response",
        usage,
        reservationReleases: [release],
      };
      expect(await recordModelUsageAndDebitCredits(billedSettings(), db, input)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      await recordModelUsageAndDebitCredits(billedSettings(), db, {
        ...input,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(usageEvents).toContainEqual(release);
      expect(usageEvents.find((event) => event.eventType === "model.tokens")?.quantity).toBe(150);
      expect(creditDebits).toHaveLength(1);
    },
  );

  test.each([false, true])(
    "a terminal response with unknown spend keeps its reservation (malformed=%s)",
    async (malformed) => {
      const { usageEvents, spy } = mockAtomicWrites();
      const settings = billedSettings();
      const input: Parameters<typeof processModelResponseTerminalEvent>[0] = {
        event: {
          type: "raw_model_stream_event",
          data: {
            type: "response_done",
            response: {
              id: "usage-less-response",
              ...(malformed ? { usage: { inputTokens: 100, outputTokens: -1 } } : {}),
            },
          },
        },
        state: createModelResponseEventState(),
        dispatchId: "dispatch-1",
        settings,
        db,
        observability: createObservability(settings, { component: "unknown-spend-test" }),
        publish: null,
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-1",
        turnId: "turn-1",
        turnAttemptId: "attempt-1",
        provider: "openai",
        metricProvider: "openai",
        providerApi: "responses",
        model: "gpt-5.6-sol",
        externallyBilled: false,
        servingCredentialId: null,
        priorSessionCredentialId: null,
        emittedSourceKeys: new Set(),
        renewLease: async () => undefined,
        leaseLost: () => false,
        leaseLostMessage: "lease lost",
        setLastInputTokens: async () => undefined,
        reservationReleases: [
          {
            eventType: "model.tokens.reserved",
            quantity: -2_000,
            unit: "tokens",
            idempotencyKey: "unknown-spend:release",
          },
        ],
      };
      const result = await processModelResponseTerminalEvent(input);
      expect(result).toMatchObject({ status: "processed", usageReported: false });
      expect(spy).not.toHaveBeenCalled();
      if (malformed) {
        expect(input.state.claimedSourceKeys.has("usage-less-response")).toBe(false);
        const settled = await processModelResponseTerminalEvent({
          ...input,
          event: {
            type: "raw_model_stream_event",
            data: {
              type: "response_done",
              response: {
                id: "usage-less-response",
                usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
              },
            },
          },
        });
        expect(settled).toMatchObject({ status: "processed", usageReported: true });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(usageEvents.find((event) => event.eventType === "model.tokens")?.quantity).toBe(150);
        expect(
          usageEvents.find((event) => event.eventType === "model.tokens.reserved")?.quantity,
        ).toBe(-2_000);
      }
    },
  );

  test("soft-fails fact persist without throwing", async () => {
    const sentinel = "SECRET_SENTINEL_123";
    const SecretSentinelError = class SECRET_SENTINEL_123 extends Error {};
    const exactError = Object.assign(new SecretSentinelError(`db unavailable ${sentinel}`), {
      name: sentinel,
      code: sentinel,
      cause: { exact: sentinel },
    });
    const factSpy = spyOn(opengeniDb, "recordModelCallFact").mockImplementation(async () => {
      throw exactError;
    });
    restores.push(() => factSpy.mockRestore());
    const warns: Array<{ message: string; attributes: Record<string, unknown> }> = [];
    await recordAuthoritativeModelCallFact({
      db,
      observability: {
        warn: (message: string, attributes: Record<string, unknown>) => {
          warns.push({ message, attributes });
        },
      } as never,
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-1",
      turnId: "turn-1",
      turnAttemptId: "attempt-1",
      sourceKey: "response-1",
      provider: "openai",
      providerApi: "responses",
      model: "scripted-model",
      billing: {
        billingPath: "opengeni_credits",
        pricedCostMicros: 1000,
        estimatedProviderCostMicros: 800,
        equivalentCreditCostMicros: 1000,
        pricingSource: "configured_list_price",
        normalizedUsage: {
          telemetry: {
            inputTokens: 10,
            outputTokens: 2,
            cachedTokens: 1,
            cacheWriteTokens: null,
            reasoningTokens: null,
          },
          totalTokens: 12,
          rejectedFields: [],
        },
      },
    });
    expect(warns).toEqual([
      {
        message: "model call fact persist failed",
        attributes: {
          errorClass: "WorkerOperationError",
          errorCode: "worker_operation_failed",
          origin: "worker",
        },
      },
    ]);
    expect(JSON.stringify(warns)).not.toContain(ACCOUNT);
    expect(JSON.stringify(warns)).not.toContain(WORKSPACE);
    expect(JSON.stringify(warns)).not.toContain("sess-1");
    expect(JSON.stringify(warns)).not.toContain("turn-1");
    expect(JSON.stringify(warns)).not.toContain("response-1");
    expect(JSON.stringify(warns)).not.toContain(sentinel);
    expect(exactError.message).toBe(`db unavailable ${sentinel}`);
    expect(exactError.constructor.name).toBe(sentinel);
    expect(exactError.code).toBe(sentinel);
    expect(factSpy).toHaveBeenCalledTimes(1);
  });

  test("records the endpoint provider reported by managed Gateway billing", async () => {
    const facts: Array<Record<string, unknown>> = [];
    const factSpy = spyOn(opengeniDb, "recordModelCallFact").mockImplementation(
      async (_db, input) => {
        facts.push(input);
      },
    );
    restores.push(() => factSpy.mockRestore());

    await recordAuthoritativeModelCallFact({
      db,
      observability: { warn: () => undefined } as never,
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-gateway",
      turnId: "turn-gateway",
      turnAttemptId: "attempt-gateway",
      sourceKey: "response-gateway",
      provider: "opengeni-gateway",
      providerApi: "responses",
      model: "deepseek-v4-flash-0731",
      billing: {
        billingPath: "opengeni_credits",
        pricedCostMicros: 5,
        estimatedProviderCostMicros: 4,
        equivalentCreditCostMicros: 5,
        pricingSource: "gateway_reported",
        upstreamProvider: "baseten",
        normalizedUsage: {
          telemetry: {
            inputTokens: 9,
            outputTokens: 8,
            cachedTokens: 0,
            cacheWriteTokens: null,
            reasoningTokens: null,
          },
          totalTokens: 17,
          rejectedFields: [],
        },
      },
    });

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      provider: "baseten",
      pricedCostMicros: 5,
      estimatedProviderCostMicros: 4,
      pricingSource: "gateway_reported",
    });
  });

  test("external billing returns pricedCostMicros 0 for facts", async () => {
    const { creditDebits } = mockAtomicWrites({ failOnDebit: true });
    const billing = await recordModelUsageAndDebitCredits(billedSettings(), db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-1",
      turnId: "turn-1",
      turnAttemptId: "attempt-1",
      model: "codex/gpt-5.6-sol",
      externallyBilled: true,
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      sourceKey: "response-1",
    });
    expect(billing.billingPath).toBe("external");
    expect(billing.pricedCostMicros).toBe(0);
    expect(billing.estimatedProviderCostMicros).toBe(14_000);
    expect(billing.equivalentCreditCostMicros).toBe(14_700);
    expect(billing.pricingSource).toBe("configured_list_price");
    expect(creditDebits).toHaveLength(0);
  });

  test("external Codex ignores non-Gateway billing metadata and uses product list pricing", async () => {
    const { creditDebits } = mockAtomicWrites({ failOnDebit: true });

    const billing = await recordModelUsageAndDebitCredits(billedSettings(), db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-codex-gateway",
      turnId: "turn-codex-gateway",
      turnAttemptId: "attempt-codex-gateway",
      model: "codex/gpt-5.6-sol",
      externallyBilled: true,
      gatewayBilling: { finalProvider: "openai", inferenceCostUsd: "0.014" },
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      sourceKey: "response-codex-gateway",
    });

    expect(billing).toMatchObject({
      billingPath: "external",
      pricedCostMicros: 0,
      estimatedProviderCostMicros: 14_000,
      equivalentCreditCostMicros: 14_700,
      pricingSource: "configured_list_price",
    });
    expect(billing).not.toHaveProperty("upstreamProvider");
    expect(creditDebits).toHaveLength(0);
  });

  test("persists free external billing authority before a soft fact-write failure", async () => {
    const { usageEvents } = mockAtomicWrites();
    const factSpy = spyOn(opengeniDb, "recordModelCallFact").mockImplementation(async () => {
      throw new Error("fact writer unavailable");
    });
    restores.push(() => factSpy.mockRestore());
    const payloads: Array<Record<string, unknown>> = [];
    const warns: Array<{ message: string; attributes: Record<string, unknown> }> = [];
    const observability = {
      info: () => undefined,
      warn: (message: string, attributes: Record<string, unknown>) => {
        warns.push({ message, attributes });
      },
    } as never;
    const usage = { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 };
    const billing = await recordModelUsageAndDebitCredits(billedSettings(), db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-free",
      turnId: "turn-free",
      turnAttemptId: "attempt-free",
      model: "scripted-model",
      externallyBilled: true,
      chargesOpenGeniCredits: false,
      countsTowardTokenCap: true,
      usage,
      sourceKey: "response-free",
    });
    expect(billing).not.toBeNull();
    if (!billing) return;

    const authoritative = await emitModelCallUsage({
      observability,
      publish: async (batch) => {
        payloads.push(batch[0]?.payload as Record<string, unknown>);
        return {
          accepted: true,
          events: batch.map((event) => ({
            ...event,
            id: crypto.randomUUID(),
            turnAssociation: "current" as const,
          })) as never,
        };
      },
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-free",
      turnId: "turn-free",
      provider: "openai",
      providerApi: "responses",
      model: "scripted-model",
      sourceKey: "response-free",
      usage: { usage },
      normalizedUsage: billing.normalizedUsage,
      billingPath: billing.billingPath,
    });
    expect(authoritative).toBe(true);

    await recordAuthoritativeModelCallFact({
      db,
      observability,
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-free",
      turnId: "turn-free",
      turnAttemptId: "attempt-free",
      sourceKey: "response-free",
      provider: "openai",
      providerApi: "responses",
      model: "scripted-model",
      billing,
    });

    expect(payloads).toEqual([
      expect.objectContaining({
        sourceKey: "response-free",
        billingPath: "external",
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ]);
    expect(usageEvents).toEqual([
      expect.objectContaining({ eventType: "model.tokens", quantity: 1500 }),
      expect.objectContaining({ eventType: "model.cost", quantity: 0 }),
    ]);
    expect(factSpy).toHaveBeenCalledTimes(1);
    expect(warns).toEqual([
      {
        message: "model call fact persist failed",
        attributes: {
          errorClass: "WorkerOperationError",
          errorCode: "worker_operation_failed",
          origin: "worker",
        },
      },
    ]);
  });

  test("external estimates preserve per-request pricing tiers", async () => {
    mockAtomicWrites();
    const billing = await recordModelUsageAndDebitCredits(billedSettings(), db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-tiered",
      turnId: "turn-tiered",
      turnAttemptId: "attempt-tiered",
      model: "codex/gpt-5.6-luna",
      externallyBilled: true,
      usage: {
        inputTokens: 300_000,
        outputTokens: 0,
        totalTokens: 300_000,
        requestUsageEntries: [
          { inputTokens: 150_000, outputTokens: 0, totalTokens: 150_000 },
          { inputTokens: 150_000, outputTokens: 0, totalTokens: 150_000 },
        ],
      },
      sourceKey: "response-tiered",
    });
    expect(billing).toMatchObject({
      billingPath: "external",
      pricedCostMicros: 0,
      estimatedProviderCostMicros: 60_000,
      equivalentCreditCostMicros: 63_000,
      pricingSource: "configured_list_price",
    });
  });

  test("partial or malformed configured usage stays externally uncharged and unpriced", async () => {
    const { usageEvents, creditDebits } = mockAtomicWrites({ failOnDebit: true });

    const usageCases = [
      { sourceKey: "response-partial", usage: { inputTokens: 100, totalTokens: 100 } },
      {
        sourceKey: "response-malformed",
        usage: { inputTokens: "invalid", outputTokens: 20, totalTokens: 20 },
      },
    ];
    for (const usageCase of usageCases) {
      const billing = await recordModelUsageAndDebitCredits(billedSettings(), db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-incomplete",
        turnId: `turn-${usageCase.sourceKey}`,
        turnAttemptId: `attempt-${usageCase.sourceKey}`,
        model: "codex/gpt-5.6-sol",
        externallyBilled: true,
        usage: usageCase.usage,
        sourceKey: usageCase.sourceKey,
      });
      expect(billing).toMatchObject({
        billingPath: "external",
        pricedCostMicros: 0,
        estimatedProviderCostMicros: null,
        equivalentCreditCostMicros: null,
        pricingSource: null,
      });
    }

    expect(usageEvents).toEqual([
      expect.objectContaining({ eventType: "model.cost", quantity: 0 }),
      expect.objectContaining({ eventType: "model.cost", quantity: 0 }),
    ]);
    expect(creditDebits).toHaveLength(0);
  });

  test("Gateway exact cost remains known with malformed core token telemetry", async () => {
    const { creditDebits } = mockAtomicWrites();

    const billing = await recordModelUsageAndDebitCredits(billedSettings(), db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-gateway-incomplete",
      turnId: "turn-gateway-incomplete",
      turnAttemptId: "attempt-gateway-incomplete",
      model: OPENGENI_GATEWAY_MODELS.deepseek.productId,
      externallyBilled: false,
      gatewayBilling: { finalProvider: "baseten", inferenceCostUsd: "0.00000325" },
      usage: { inputTokens: "invalid", outputTokens: 8, totalTokens: 8 },
      sourceKey: "response-gateway-incomplete",
    });

    expect(billing).toMatchObject({
      billingPath: "opengeni_credits",
      pricedCostMicros: 4,
      estimatedProviderCostMicros: 4,
      equivalentCreditCostMicros: 4,
      pricingSource: "gateway_reported",
      upstreamProvider: "baseten",
    });
    expect(creditDebits).toHaveLength(1);
  });

  test("external usage stays uncharged and explicitly unpriced when no schedule exists", async () => {
    mockAtomicWrites();
    const billing = await recordModelUsageAndDebitCredits(billedSettings(), db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-unknown",
      turnId: "turn-unknown",
      turnAttemptId: "attempt-unknown",
      model: "codex/not-priced",
      externallyBilled: true,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      sourceKey: "response-unknown",
    });
    expect(billing).toMatchObject({
      billingPath: "external",
      pricedCostMicros: 0,
      estimatedProviderCostMicros: null,
      equivalentCreditCostMicros: null,
      pricingSource: null,
    });
  });
});

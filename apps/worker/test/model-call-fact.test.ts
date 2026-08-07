import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

import {
  recordAuthoritativeModelCallFact,
  recordModelUsageAndDebitCredits,
} from "../src/activities/agent-turn";

const ACCOUNT = "acct-1";
const WORKSPACE = "ws-1";
const db = {} as Database;

function billedSettings() {
  return testSettings({
    billingMode: "stripe",
    usageLimitsMode: "managed",
    modelPricingJson: JSON.stringify({
      "gpt-5.6-sol": {
        inputMicrosPerMillionTokens: 5_000_000,
        cachedInputMicrosPerMillionTokens: 500_000,
        outputMicrosPerMillionTokens: 30_000_000,
        marginBps: 2_500,
      },
    }),
  });
}

describe("recordAuthoritativeModelCallFact", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
  });

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
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
    restores.push(() => recordSpy.mockRestore());
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(
      async () => {
        throw new Error("credits must NOT be debited for an externally billed turn");
      },
    );
    restores.push(() => debitSpy.mockRestore());
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
    expect(billing.estimatedProviderCostMicros).toBe(20_000);
    expect(billing.pricingSource).toBe("configured_list_price");
    expect(debitSpy).not.toHaveBeenCalled();
  });

  test("external estimates preserve per-request pricing tiers", async () => {
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
    restores.push(() => recordSpy.mockRestore());
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
      pricingSource: "configured_list_price",
    });
  });

  test("external usage stays uncharged and explicitly unpriced when no schedule exists", async () => {
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
    restores.push(() => recordSpy.mockRestore());
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
      pricingSource: null,
    });
  });
});

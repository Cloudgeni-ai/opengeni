import { describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { recordModelUsageAndDebitCredits } from "../src/activities/agent-turn";

const db = {} as Database;
const PRODUCT = "gpt-5.6-luna";

function settings(active: boolean) {
  return testSettings({
    billingMode: "stripe",
    usageLimitsMode: "managed",
    vercelAiGatewayApiKey: "vck_test",
    modelPricingJson: JSON.stringify({
      [PRODUCT]: {
        inputMicrosPerMillionTokens: 110_000,
        cachedInputMicrosPerMillionTokens: 11_000,
        cacheWriteMicrosPerMillionTokens: 137_500,
        outputMicrosPerMillionTokens: 550_000,
        marginBps: 500,
      },
    }),
    resolvedModelFallbackRoutesJson: JSON.stringify([
      {
        productId: PRODUCT,
        via: "opengeni-gateway",
        upstreamModelId: "openai/gpt-5.6-luna",
        providers: ["openai"],
      },
    ]),
    ...(active ? { activeModelFallbackRoutesJson: JSON.stringify([PRODUCT]) } : {}),
  });
}

function usageInput(finalProvider: string) {
  return {
    accountId: "acct-fallback",
    workspaceId: "ws-fallback",
    sessionId: "sess-fallback",
    turnId: "turn-fallback",
    turnAttemptId: "attempt-fallback",
    model: PRODUCT,
    externallyBilled: false,
    gatewayBilling: { finalProvider, inferenceCostUsd: "0.002" },
    usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 },
    sourceKey: `response-fallback-${finalProvider}`,
  };
}

describe("credits fallback route billing", () => {
  test("debits the Gateway-reported cost plus the product margin under the same product id", async () => {
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined);
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockResolvedValue({
      balance: {
        accountId: "acct-fallback",
        balanceMicros: 1_000_000,
        currency: "usd",
        updatedAt: new Date().toISOString(),
      },
      debitedMicros: 2_100,
    });
    try {
      const billing = await recordModelUsageAndDebitCredits(
        settings(true),
        db,
        usageInput("openai"),
      );
      expect(billing).toMatchObject({
        billingPath: "opengeni_credits",
        pricingSource: "gateway_reported",
        upstreamProvider: "openai",
        estimatedProviderCostMicros: 2_000,
        pricedCostMicros: 2_100,
      });
      expect(debitSpy).toHaveBeenCalledTimes(1);
      expect(debitSpy.mock.calls[0]?.[1]).toMatchObject({
        requestedAmountMicros: 2_100,
        metadata: { model: PRODUCT, gatewayProvider: "openai" },
      });
    } finally {
      recordSpy.mockRestore();
      debitSpy.mockRestore();
    }
  });

  test("refuses a provider outside the route's single pinned endpoint", async () => {
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined);
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockResolvedValue(
      undefined as never,
    );
    try {
      await expect(
        recordModelUsageAndDebitCredits(settings(true), db, usageInput("azure")),
      ).rejects.toThrow("AI Gateway reported unapproved provider azure");
      expect(debitSpy).not.toHaveBeenCalled();
    } finally {
      recordSpy.mockRestore();
      debitSpy.mockRestore();
    }
  });

  test("the primary route keeps list-price token billing", async () => {
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined);
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockResolvedValue({
      balance: {
        accountId: "acct-fallback",
        balanceMicros: 1_000_000,
        currency: "usd",
        updatedAt: new Date().toISOString(),
      },
      debitedMicros: 1,
    });
    try {
      const billing = await recordModelUsageAndDebitCredits(settings(false), db, {
        ...usageInput("openai"),
        gatewayBilling: undefined,
      });
      expect(billing).toMatchObject({ pricingSource: "configured_list_price" });
    } finally {
      recordSpy.mockRestore();
      debitSpy.mockRestore();
    }
  });
});

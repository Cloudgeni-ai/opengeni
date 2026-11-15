import { describe, expect, spyOn, test } from "bun:test";
import {
  defaultModelPricing,
  resolveTurnExecutionPolicyV1,
  withOrganizationAzureOpenAICredential,
} from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

import {
  recordModelUsageAndDebitCredits,
  turnExecutionPolicyBillingIdentity,
} from "../src/activities/agent-turn";
import { useNoSessionUsageLimitForFakeDatabases } from "@opengeni/testing/session-usage-limits";
// Fake databases have no per-task usage limit state.
useNoSessionUsageLimitForFakeDatabases();

const db = {} as Database;
const MODEL_ID = "organization-azure-openai/gpt-6.1-sol";

function settings(price: Record<string, unknown> = {}) {
  return withOrganizationAzureOpenAICredential(
    testSettings({ billingMode: "stripe", usageLimitsMode: "managed" }),
    "azure-org-key",
    {
      endpoint: "https://contoso.openai.azure.com/openai/v1",
      models: [{ upstreamModelId: "gpt-6.1-sol", ...price }],
    },
  );
}

/** Settle one call of the deployment and return its billing record. */
async function settle(price: Record<string, unknown>, sourceKey: string) {
  const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(async () => {});
  const debitSpy = spyOn(opengeniDb, "applyCreditDebitAfterUse");
  try {
    const billing = await recordModelUsageAndDebitCredits(settings(price), db, {
      accountId: "acct",
      workspaceId: "ws",
      sessionId: "sess",
      turnId: `turn-${sourceKey}`,
      turnAttemptId: "attempt",
      model: MODEL_ID,
      externallyBilled: true,
      usage: { inputTokens: 100_000, outputTokens: 10_000, totalTokens: 110_000 },
      sourceKey,
    });
    expect(debitSpy).not.toHaveBeenCalled();
    return billing;
  } finally {
    recordSpy.mockRestore();
    debitSpy.mockRestore();
  }
}

describe("organization Azure OpenAI usage", () => {
  test("an accepted turn is organization-paid and externally metered", () => {
    const policy = resolveTurnExecutionPolicyV1(settings(), {
      modelId: MODEL_ID,
      requestedModelId: MODEL_ID,
      modelSource: "explicit",
      reasoningEffort: "medium",
      reasoningSource: "deployment",
    });
    expect(policy).toMatchObject({
      providerId: "organization-azure-openai",
      upstreamModelId: "gpt-6.1-sol",
      credentialSource: { kind: "organization_connection", mechanism: "api_key" },
      billing: { upstreamPayer: "organization", metering: "external" },
    });
    expect(turnExecutionPolicyBillingIdentity(policy)).toEqual({
      externallyBilled: true,
      countsTowardTokenCap: false,
      codexSubscription: false,
      xaiSubscription: false,
    });
  });

  test("usage is recorded for the organization and never debits Opengeni credits", async () => {
    const recorded: Array<{ eventType: string; quantity: number }> = [];
    const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(
      async (_db, input) => {
        recorded.push({ eventType: input.eventType, quantity: input.quantity });
      },
    );
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitAfterUse");
    try {
      const billing = await recordModelUsageAndDebitCredits(settings(), db, {
        accountId: "acct",
        workspaceId: "ws",
        sessionId: "sess",
        turnId: "turn-organization-azure",
        turnAttemptId: "attempt",
        model: MODEL_ID,
        externallyBilled: true,
        usage: { inputTokens: 700, outputTokens: 80, totalTokens: 780 },
        sourceKey: "response-organization-azure",
      });
      expect(debitSpy).not.toHaveBeenCalled();
      expect(billing).toMatchObject({ billingPath: "external", pricedCostMicros: 0 });
      expect(recorded.some((event) => event.eventType === "model.cost" && event.quantity > 0)).toBe(
        false,
      );
    } finally {
      recordSpy.mockRestore();
      debitSpy.mockRestore();
    }
  });

  test("without a declared price, the call's cost is unknown, never zero", async () => {
    const billing = await settle({}, "response-unpriced");
    expect(billing).toMatchObject({
      billingPath: "external",
      estimatedProviderCostMicros: null,
      pricingSource: null,
    });
  });

  test("a deployment's base model prices its usage at that model's list rate", async () => {
    const billing = await settle({ listPricingModelId: "gpt-6-astra" }, "response-base");
    const rate = defaultModelPricing["gpt-6-astra"]!.default;
    expect(billing).toMatchObject({
      billingPath: "external",
      pricedCostMicros: 0,
      pricingSource: "configured_list_price",
      estimatedProviderCostMicros:
        rate.inputMicrosPerMillionTokens / 10 + rate.outputMicrosPerMillionTokens / 100,
    });
  });

  test("an administrator's own price overrides the base model", async () => {
    const billing = await settle(
      {
        listPricingModelId: "gpt-6-astra",
        listPricing: {
          inputMicrosPerMillionTokens: 2_000_000,
          outputMicrosPerMillionTokens: 8_000_000,
        },
      },
      "response-custom",
    );
    expect(billing).toMatchObject({
      pricingSource: "configured_list_price",
      estimatedProviderCostMicros: 200_000 + 80_000,
    });
  });
});

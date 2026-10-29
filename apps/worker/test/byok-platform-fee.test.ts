import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { withOrganizationAzureOpenAICredential, type Settings } from "@opengeni/config";
import {
  BYOK_PAID_CREDIT_REQUIRED_CODE,
  BYOK_PAID_CREDIT_REQUIRED_MESSAGE,
} from "@opengeni/contracts";
import {
  admitModelCall,
  BYOK_FALLBACK_LIST_RATE,
  byokListEquivalent,
  byokPlatformFeeActive,
  byokPlatformFeeMicros,
  checkLimit,
  modelFundingForAdmission,
} from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { useNoSessionUsageLimitForFakeDatabases } from "@opengeni/testing/session-usage-limits";
import { recordModelUsageAndDebitCredits } from "../src/activities/agent-turn";
import { ensureRunAllowedBetweenModelCalls } from "../src/activities/agent-turn/admission";

// Fake databases have no per-task usage limit state.
useNoSessionUsageLimitForFakeDatabases();

const db = {} as Database;
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const OWN_KEY_MODEL = "organization-azure-openai/gpt-6.1-sol";

/** Billing on, a 5% fee, and a model served by the organization's own Azure key. */
function settings(overrides: Partial<Settings> = {}) {
  return withOrganizationAzureOpenAICredential(
    testSettings({
      billingMode: "stripe",
      usageLimitsMode: "managed",
      byokPlatformFeeBps: 500,
      ...overrides,
    }),
    "azure-org-key",
    {
      endpoint: "https://contoso.openai.azure.com/openai/v1",
      models: [{ upstreamModelId: "gpt-6.1-sol" }],
    },
  );
}

function paidCredit(micros: number) {
  return spyOn(opengeniDb, "getByokFeeSpendableBalance").mockResolvedValue({
    accountId: ACCOUNT,
    balanceMicros: micros,
    currency: "usd",
    updatedAt: new Date().toISOString(),
  });
}

describe("own-key platform fee math", () => {
  test("the fee is 5% of the list equivalent, rounded up, and off without billing", () => {
    expect(byokPlatformFeeMicros(2_000_000, 500)).toBe(100_000);
    expect(byokPlatformFeeMicros(1, 500)).toBe(1);
    expect(byokPlatformFeeMicros(0, 500)).toBe(0);
    expect(byokPlatformFeeMicros(2_000_000, 0)).toBe(0);
    expect(byokPlatformFeeActive(settings())).toBe(true);
    expect(byokPlatformFeeActive(settings({ byokPlatformFeeBps: 0 }))).toBe(false);
    expect(
      byokPlatformFeeActive(settings({ billingMode: "disabled", usageLimitsMode: "none" })),
    ).toBe(false);
  });

  test("an endpoint with no list price uses the fallback rate", () => {
    expect(BYOK_FALLBACK_LIST_RATE).toEqual({
      inputMicrosPerMillionTokens: 1_250_000,
      outputMicrosPerMillionTokens: 10_000_000,
    });
    expect(
      byokListEquivalent({
        estimatedProviderCostMicros: null,
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      }),
    ).toEqual({ listMicros: 2_250_000, source: "fallback_rate" });
    expect(
      byokListEquivalent({ estimatedProviderCostMicros: 42, inputTokens: 9, outputTokens: 9 }),
    ).toEqual({ listMicros: 42, source: "list_price" });
  });

  test("own keys and subscriptions are byok; a deployment-funded free model is not", () => {
    expect(modelFundingForAdmission(settings(), OWN_KEY_MODEL, false)).toMatchObject({
      fundedWithoutCredits: true,
      byok: true,
    });
    // A Codex subscription turn is the person's own subscription.
    expect(modelFundingForAdmission(settings(), "gpt-6-luna", true).byok).toBe(true);
    // Opengeni's own credit-billed model pays credits, not the fee.
    expect(modelFundingForAdmission(settings(), "gpt-6-luna", false).byok).toBe(false);
  });
});

describe("own-key admission", () => {
  let codex: ReturnType<typeof spyOn<typeof opengeniDb, "isCodexBilledTurn">>;
  let allowance: ReturnType<typeof spyOn<typeof opengeniDb, "checkWorkspaceAllowance">>;
  beforeEach(() => {
    codex = spyOn(opengeniDb, "isCodexBilledTurn").mockResolvedValue(false);
    allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockResolvedValue(null);
  });
  afterEach(() => {
    codex.mockRestore();
    allowance.mockRestore();
  });

  test("with no paid credit an own-key run is refused with Add credits, everywhere", async () => {
    const balance = paidCredit(0);
    try {
      const services = { db, settings: settings(), entitlements: null };
      const input = {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        model: OWN_KEY_MODEL,
        requestedAgentRuns: 1,
      };
      expect(await checkLimit(services, { ...input, action: "agent_run:create" })).toEqual({
        allowed: false,
        code: BYOK_PAID_CREDIT_REQUIRED_CODE,
        message: BYOK_PAID_CREDIT_REQUIRED_MESSAGE,
      });
      await expect(
        ensureRunAllowedBetweenModelCalls({
          ...services,
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          modelId: OWN_KEY_MODEL,
          isExternallyBilledTurn: true,
          chargesOpenGeniCredits: false,
          countsTowardTokenCap: false,
          initiatingHumanSubjectId: null,
          billingOrigin: "app",
          byok: true,
        }),
      ).rejects.toThrow(BYOK_PAID_CREDIT_REQUIRED_MESSAGE);
      expect(
        await admitModelCall(services, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          chargesOpenGeniCredits: false,
          countsTowardTokenCap: false,
          subjectId: null,
          billingOrigin: "api",
          byok: true,
        }),
      ).toMatchObject({ allowed: false, byokPaidCreditRequired: true });
      expect(balance.mock.calls.map((call) => call[2])).toEqual([undefined, "app", "api"]);
    } finally {
      balance.mockRestore();
    }
  });

  test("paid credit admits it; with the fee off nothing is read", async () => {
    const balance = paidCredit(1);
    try {
      const input = {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        model: OWN_KEY_MODEL,
        requestedAgentRuns: 1,
        action: "agent_run:create" as const,
      };
      expect(
        (await checkLimit({ db, settings: settings(), entitlements: null }, input)).allowed,
      ).toBe(true);
      balance.mockClear();
      const off = { db, settings: settings({ byokPlatformFeeBps: 0 }), entitlements: null };
      expect((await checkLimit(off, input)).allowed).toBe(true);
      expect(balance).not.toHaveBeenCalled();
    } finally {
      balance.mockRestore();
    }
  });
});

describe("own-key settlement", () => {
  let recorded: ReturnType<typeof spyOn<typeof opengeniDb, "recordUsageEvent">>;
  let debit: ReturnType<typeof spyOn<typeof opengeniDb, "applyCreditDebitAfterUse">>;
  beforeEach(() => {
    recorded = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
    debit = spyOn(opengeniDb, "applyCreditDebitAfterUse").mockResolvedValue({
      balance: {} as never,
      debitedMicros: 0,
    });
  });
  afterEach(() => {
    recorded.mockRestore();
    debit.mockRestore();
  });

  const settle = (s: Settings, byok?: boolean) =>
    recordModelUsageAndDebitCredits(s, db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess",
      turnId: "turn-own-key",
      turnAttemptId: "attempt",
      model: OWN_KEY_MODEL,
      externallyBilled: true,
      chargesOpenGeniCredits: false,
      countsTowardTokenCap: false,
      ...(byok !== undefined ? { byok } : {}),
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 },
      sourceKey: "response-own-key",
    });

  test("a response on the person's own key debits the fee once, keyed by the response", async () => {
    const billing = await settle(settings(), true);
    expect(debit).toHaveBeenCalledTimes(1);
    const charge = debit.mock.calls[0]![1];
    const list = charge.metadata!.listEquivalentMicros as number;
    expect(list).toBeGreaterThan(0);
    expect(charge).toMatchObject({
      type: "byok_platform_fee",
      amountMicros: Math.ceil((list * 500) / 10_000),
      byokPlatformFee: true,
      sourceType: "model_response",
      sourceId: "turn-own-key:response-own-key",
      idempotencyKey: "credit:byok_platform_fee:turn-own-key:response-own-key",
      metadata: { feeBps: 500, model: OWN_KEY_MODEL },
    });
    expect(charge.usage).toBeUndefined();
    expect(billing).toMatchObject({
      billingPath: "external",
      pricedCostMicros: 0,
      byokPlatformFeeMicros: charge.amountMicros,
    });
  });

  test("the served route decides when the caller does not say", async () => {
    await settle(settings());
    expect(debit).toHaveBeenCalledTimes(1);
  });

  test("no fee when it is off, or when Opengeni funds the model", async () => {
    await settle(settings({ byokPlatformFeeBps: 0 }), true);
    await settle(settings(), false);
    expect(debit).not.toHaveBeenCalled();
  });
});

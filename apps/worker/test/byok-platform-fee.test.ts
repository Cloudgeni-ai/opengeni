import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { RunRawModelStreamEvent } from "@openai/agents-core";
import { createObservability } from "@opengeni/observability";
import { withOrganizationAzureOpenAICredential, type Settings } from "@opengeni/config";
import {
  BYOK_PAID_CREDIT_REQUIRED_CODE,
  BYOK_PAID_CREDIT_REQUIRED_MESSAGE,
  BYOK_UPGRADE_REQUIRED_MESSAGE,
  UPGRADE_PLAN_ACTION,
  ADD_CREDITS_ACTION,
  byokRefusalAction,
} from "@opengeni/contracts";
import {
  admitModelCall,
  BYOK_FALLBACK_LIST_RATE,
  byokListEquivalent,
  byokPaidCreditRefusalMessage,
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
import {
  createCompactionModelUsageEventState,
  createModelResponseEventState,
  processCompactionModelUsageEvent,
  processModelResponseTerminalEvent,
} from "../src/activities/agent-turn/model-usage";
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

function paidCredit(micros: number, planKey?: "free" | "pro") {
  return spyOn(opengeniDb, "getByokFeeSpendableBalance").mockResolvedValue({
    accountId: ACCOUNT,
    balanceMicros: micros,
    ...(planKey ? { plan: { key: planKey } as never } : {}),
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
    expect(byokPlatformFeeActive(settings(), ACCOUNT)).toBe(true);
    expect(byokPlatformFeeActive(settings({ byokPlatformFeeBps: 0 }), ACCOUNT)).toBe(false);
    expect(
      byokPlatformFeeActive(
        settings({ billingMode: "disabled", usageLimitsMode: "none" }),
        ACCOUNT,
      ),
    ).toBe(false);
  });

  test("only Stripe billing charges it: without it nobody could buy the credit", () => {
    expect(
      byokPlatformFeeActive(
        settings({ billingMode: "disabled", usageLimitsMode: "managed" }),
        ACCOUNT,
      ),
    ).toBe(false);
  });

  test("an account on legacy billing terms (CloudGeni) never pays it", () => {
    const legacy = settings({ billingLegacyAccountIds: [ACCOUNT] });
    expect(byokPlatformFeeActive(legacy, ACCOUNT)).toBe(false);
    expect(byokPlatformFeeActive(legacy, WORKSPACE)).toBe(true);
  });

  test("an endpoint with no list price uses the fallback rate", () => {
    expect(BYOK_FALLBACK_LIST_RATE).toEqual({
      inputMicrosPerMillionTokens: 1_250_000,
      outputMicrosPerMillionTokens: 10_000_000,
    });
    expect(
      byokListEquivalent({
        listPriceMicros: null,
        reportedCostMicros: null,
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      }),
    ).toEqual({ listMicros: 2_250_000, source: "fallback_rate" });
  });

  test("the list price wins; a gateway's $0 report never zeroes the fee", () => {
    expect(
      byokListEquivalent({
        listPriceMicros: 42,
        reportedCostMicros: 7,
        inputTokens: 9,
        outputTokens: 9,
      }),
    ).toEqual({ listMicros: 42, source: "list_price" });
    expect(
      byokListEquivalent({
        listPriceMicros: null,
        reportedCostMicros: 7,
        inputTokens: 9,
        outputTokens: 9,
      }),
    ).toEqual({ listMicros: 7, source: "reported_cost" });
    expect(
      byokListEquivalent({
        listPriceMicros: null,
        reportedCostMicros: 0,
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toEqual({ listMicros: 1_250_000, source: "fallback_rate" });
  });

  test("the refusal names its one fix: Upgrade to Pro on the Free plan in the app, else Add credits", () => {
    const free = { plan: { key: "free" } as never };
    const pro = { plan: { key: "pro" } as never };
    expect(byokPaidCreditRefusalMessage(free, "app")).toBe(BYOK_UPGRADE_REQUIRED_MESSAGE);
    expect(byokPaidCreditRefusalMessage(free, "api")).toBe(BYOK_PAID_CREDIT_REQUIRED_MESSAGE);
    expect(byokPaidCreditRefusalMessage(pro, "app")).toBe(BYOK_PAID_CREDIT_REQUIRED_MESSAGE);
    expect(byokPaidCreditRefusalMessage({ plan: null }, "app")).toBe(
      BYOK_PAID_CREDIT_REQUIRED_MESSAGE,
    );
    expect(byokRefusalAction(BYOK_UPGRADE_REQUIRED_MESSAGE)).toBe(UPGRADE_PLAN_ACTION);
    expect(byokRefusalAction(BYOK_PAID_CREDIT_REQUIRED_MESSAGE)).toBe(ADD_CREDITS_ACTION);
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

  test.each([
    { host: "without host entitlements", entitlements: null },
    {
      // A host's own entitlements admit the run; the fee rule is the same.
      host: "with host entitlements bound",
      entitlements: { admitRun: async () => ({ allowed: true as const }) },
    },
  ])(
    "with no paid credit an own-key run is refused with Add credits, everywhere ($host)",
    async ({ entitlements }) => {
      const balance = paidCredit(0);
      try {
        const services = { db, settings: settings(), entitlements };
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
    },
  );

  test("on the Free plan the app refusal is Upgrade to Pro; API work still says Add credits", async () => {
    const balance = paidCredit(0, "free");
    try {
      const services = { db, settings: settings(), entitlements: null };
      expect(
        await checkLimit(services, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          model: OWN_KEY_MODEL,
          requestedAgentRuns: 1,
          action: "agent_run:create",
          billingOrigin: "app",
        }),
      ).toMatchObject({ allowed: false, message: BYOK_UPGRADE_REQUIRED_MESSAGE });
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
          billingOrigin: "api",
          byok: true,
        }),
      ).rejects.toThrow(BYOK_PAID_CREDIT_REQUIRED_MESSAGE);
    } finally {
      balance.mockRestore();
    }
  });

  test("a legacy-billing account (CloudGeni) is never refused or read", async () => {
    const balance = paidCredit(0);
    try {
      const services = {
        db,
        settings: settings({ billingLegacyAccountIds: [ACCOUNT] }),
        entitlements: null,
      };
      expect(
        (
          await checkLimit(services, {
            accountId: ACCOUNT,
            workspaceId: WORKSPACE,
            model: OWN_KEY_MODEL,
            requestedAgentRuns: 1,
            action: "agent_run:create",
          })
        ).allowed,
      ).toBe(true);
      expect(balance).not.toHaveBeenCalled();
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

  test("no fee when it is off, when Opengeni funds the model, or for a legacy-billing account", async () => {
    await settle(settings({ byokPlatformFeeBps: 0 }), true);
    await settle(settings(), false);
    await settle(settings({ billingLegacyAccountIds: [ACCOUNT] }), true);
    expect(debit).not.toHaveBeenCalled();
  });
});

describe("own-key fee on the turn's real response paths", () => {
  let recorded: ReturnType<typeof spyOn<typeof opengeniDb, "recordUsageEvent">>;
  let fact: ReturnType<typeof spyOn<typeof opengeniDb, "recordModelCallFact">>;
  let debit: ReturnType<typeof spyOn<typeof opengeniDb, "applyCreditDebitAfterUse">>;
  beforeEach(() => {
    recorded = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
    fact = spyOn(opengeniDb, "recordModelCallFact").mockResolvedValue(undefined as never);
    debit = spyOn(opengeniDb, "applyCreditDebitAfterUse").mockResolvedValue({
      balance: {} as never,
      debitedMicros: 0,
    });
  });
  afterEach(() => {
    recorded.mockRestore();
    fact.mockRestore();
    debit.mockRestore();
  });

  // A subscription serves a catalog model Opengeni would otherwise fund, so
  // only the turn's funding (not the model) says it is the person's own.
  const common = (byok?: boolean) => ({
    dispatchId: "activity-A",
    settings: settings(),
    db,
    observability: createObservability(testSettings(), { component: "worker" }),
    publish: (async (batch: any[]) => ({
      accepted: true,
      events: batch.map((event) => ({
        ...event,
        id: crypto.randomUUID(),
        turnAssociation: "current",
      })),
    })) as any,
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    sessionId: "sess",
    turnId: "turn-subscription",
    turnAttemptId: "attempt",
    provider: "codex-subscription",
    providerApi: "responses" as const,
    model: "gpt-6-luna",
    externallyBilled: true,
    chargesOpenGeniCredits: false,
    countsTowardTokenCap: false,
    ...(byok !== undefined ? { byok } : {}),
    servingCredentialId: null,
    priorSessionCredentialId: null,
    renewLease: async () => undefined,
    leaseLost: () => false,
    leaseLostMessage: "lease lost",
  });
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 };

  test("streamed responses and compaction charge the fee when the turn is on the person's own subscription", async () => {
    await processModelResponseTerminalEvent({
      ...common(true),
      event: new RunRawModelStreamEvent({
        type: "response_done",
        response: { id: "resp-own", output: [], usage },
      } as any) as any,
      state: createModelResponseEventState(),
      metricProvider: "codex-subscription",
      emittedSourceKeys: new Set(),
      setLastInputTokens: async () => undefined,
    });
    await processCompactionModelUsageEvent({
      ...common(true),
      usage: { responseId: "resp-compaction", usage } as any,
      state: createCompactionModelUsageEventState(new Set()),
      emittedSourceKeys: new Set(),
    });
    expect(debit.mock.calls.map((call) => call[1].type)).toEqual([
      "byok_platform_fee",
      "byok_platform_fee",
    ]);
  });

  test("an Opengeni-funded turn on the same model pays no fee", async () => {
    await processCompactionModelUsageEvent({
      ...common(false),
      usage: { responseId: "resp-funded", usage } as any,
      state: createCompactionModelUsageEventState(new Set()),
      emittedSourceKeys: new Set(),
    });
    expect(debit).not.toHaveBeenCalled();
  });
});

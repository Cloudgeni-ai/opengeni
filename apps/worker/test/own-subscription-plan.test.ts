import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  resolveModelProviderForTurn,
  resolveTurnExecutionPolicyV1,
  withCodexCatalogProvider,
  withOrganizationAzureOpenAICredential,
  withXaiSubscriptionCatalogProvider,
  type Settings,
} from "@opengeni/config";
import {
  BYOK_PAID_CREDIT_REQUIRED_CODE,
  SUBSCRIPTION_PLAN_REQUIRED_CODE,
  SUBSCRIPTION_PLAN_REQUIRED_MESSAGE,
  planIncludesOwnSubscriptions,
  SUBSCRIPTION_API_UNAVAILABLE_CODE,
  SUBSCRIPTION_API_UNAVAILABLE_MESSAGE,
  type BillingOrigin,
} from "@opengeni/contracts";
import {
  admitModelCall,
  agentRunAdmissionDenial,
  checkLimit,
  goalRunBudgetBlocked,
  modelFundingForAdmission,
  ownModelFunding,
  planAllowsOwnSubscriptions,
} from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { useNoSessionUsageLimitForFakeDatabases } from "@opengeni/testing/session-usage-limits";
import { recordModelUsageAndDebitCredits } from "../src/activities/agent-turn";
import {
  ensureRunAllowedBetweenModelCalls,
  turnExecutionPolicyOwnFunding,
} from "../src/activities/agent-turn/admission";

// Own subscriptions (Claude, Codex, SuperGrok) pay no platform fee; using one
// needs a paid plan of at least $20 a month. Own API keys keep the 5% fee.
// Internal accounts on legacy billing terms are exempt from both.

useNoSessionUsageLimitForFakeDatabases();

const db = {} as Database;
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const OWN_KEY_MODEL = "organization-azure-openai/gpt-6.1-sol";
const CODEX_MODEL = "codex/gpt-6-luna";
const SUPERGROK_MODEL = "supergrok/grok-4.7";
const PRICES: Record<string, number | null> = {
  free: 0,
  pro: 20_000_000,
  max: 100_000_000,
  enterprise: null,
};

/** Stripe billing with plans, a 5% fee, an own Azure key, Codex and SuperGrok. */
function settings(overrides: Partial<Settings> = {}): Settings {
  const base = withOrganizationAzureOpenAICredential(
    testSettings({
      billingMode: "stripe",
      usageLimitsMode: "managed",
      byokPlatformFeeBps: 500,
      subscriptionPlansEnabled: true,
      codexSubscriptionEnabled: true,
      supergrokSubscriptionEnabled: true,
      ...overrides,
    }),
    "azure-org-key",
    {
      endpoint: "https://contoso.openai.azure.com/openai/v1",
      models: [{ upstreamModelId: "gpt-6.1-sol" }],
    },
  );
  return withXaiSubscriptionCatalogProvider(withCodexCatalogProvider(base));
}

function onPlan(key: string | null, status = "active") {
  return spyOn(opengeniDb, "getOrganizationPlanStanding").mockResolvedValue({
    plan: key ? ({ key, status } as never) : null,
    monthlyPriceMicros: key ? (PRICES[key] ?? null) : null,
  });
}

function paidCredit(micros: number) {
  return spyOn(opengeniDb, "getByokFeeSpendableBalance").mockResolvedValue({
    accountId: ACCOUNT,
    balanceMicros: micros,
    currency: "usd",
    updatedAt: new Date().toISOString(),
  });
}

describe("own key or own subscription", () => {
  test("subscription routes are subscriptions, keys are keys, deployment models are neither", () => {
    const s = settings();
    for (const model of [CODEX_MODEL, SUPERGROK_MODEL]) {
      expect(ownModelFunding(resolveModelProviderForTurn(s, model)?.model)).toBe("subscription");
    }
    expect(ownModelFunding(resolveModelProviderForTurn(s, OWN_KEY_MODEL)?.model)).toBe("api_key");
    expect(ownModelFunding(resolveModelProviderForTurn(s, "gpt-6-luna")?.model)).toBeNull();
    // A Claude subscription policy accepted before its labels were corrected
    // still carries workspace labels; its provider kind says subscription.
    const legacyClaude = {
      billing: { upstreamPayer: "workspace" },
      credentialSource: { kind: "workspace_connection" },
    };
    expect(ownModelFunding(legacyClaude, "claude-subscription-workspace")).toBe("subscription");
    expect(ownModelFunding(legacyClaude, "anthropic-workspace")).toBe("api_key");
  });

  test("the claimed turn's accepted policy decides: subscription turns are never byok turns", () => {
    const s = settings();
    const claim = (model: string, chargesOpenGeniCredits = false) => {
      const policy = resolveTurnExecutionPolicyV1(s, {
        modelId: model,
        requestedModelId: model,
        modelSource: "explicit",
        reasoningEffort: "medium",
        reasoningSource: "deployment",
      });
      return turnExecutionPolicyOwnFunding(policy, {
        chargesOpenGeniCredits,
        providerKind: resolveModelProviderForTurn(s, model)?.provider.kind ?? null,
      });
    };
    for (const model of [CODEX_MODEL, SUPERGROK_MODEL]) {
      expect(claim(model)).toEqual({ isByokTurn: false, isOwnSubscriptionTurn: true });
    }
    expect(claim(OWN_KEY_MODEL)).toEqual({ isByokTurn: true, isOwnSubscriptionTurn: false });
    // The deployment default: Opengeni pays upstream.
    expect(claim(s.openaiModel)).toEqual({ isByokTurn: false, isOwnSubscriptionTurn: false });
    // A credits-billed turn is never the person's own model.
    expect(claim(OWN_KEY_MODEL, true)).toEqual({ isByokTurn: false, isOwnSubscriptionTurn: false });
    // An older frozen Claude policy with workspace labels: the verified
    // provider kind says subscription.
    const legacyClaude = resolveTurnExecutionPolicyV1(s, {
      modelId: OWN_KEY_MODEL,
      requestedModelId: OWN_KEY_MODEL,
      modelSource: "explicit",
      reasoningEffort: "medium",
      reasoningSource: "deployment",
    });
    expect(
      turnExecutionPolicyOwnFunding(legacyClaude, {
        chargesOpenGeniCredits: false,
        providerKind: "claude-subscription-workspace",
      }),
    ).toEqual({ isByokTurn: false, isOwnSubscriptionTurn: true });
  });

  test("admission funding on every route: a subscription is not byok; an own key is", () => {
    const s = settings();
    // A Codex subscription turn (the live credential predicate says so).
    expect(modelFundingForAdmission(s, "gpt-6-luna", true)).toMatchObject({
      fundedWithoutCredits: true,
      byok: false,
      ownSubscription: true,
    });
    // SuperGrok on the shared core, funded by the person's subscription.
    expect(modelFundingForAdmission(s, SUPERGROK_MODEL, false, true)).toMatchObject({
      fundedWithoutCredits: true,
      byok: false,
      ownSubscription: true,
    });
    expect(modelFundingForAdmission(s, OWN_KEY_MODEL, false)).toMatchObject({
      fundedWithoutCredits: true,
      byok: true,
      ownSubscription: false,
    });
    expect(modelFundingForAdmission(s, "gpt-6-luna", false)).toMatchObject({
      byok: false,
      ownSubscription: false,
    });
  });

  test("plans of at least $20 a month include own subscriptions; Free and lapsed plans don't", () => {
    const standing = (key: string | null, status = "active") => ({
      plan: key ? { key, status } : null,
      monthlyPriceMicros: key ? (PRICES[key] ?? null) : null,
    });
    expect(planAllowsOwnSubscriptions(standing("pro"))).toBe(true);
    expect(planAllowsOwnSubscriptions(standing("max"))).toBe(true);
    expect(planAllowsOwnSubscriptions(standing("enterprise"))).toBe(true);
    expect(planAllowsOwnSubscriptions(standing("pro", "trialing"))).toBe(true);
    expect(planAllowsOwnSubscriptions(standing("free"))).toBe(false);
    expect(planAllowsOwnSubscriptions(standing(null))).toBe(false);
    expect(planAllowsOwnSubscriptions(standing("pro", "past_due"))).toBe(false);
    expect(planAllowsOwnSubscriptions(standing("pro", "canceled"))).toBe(false);
    // A cheaper paid plan would not include them.
    expect(planIncludesOwnSubscriptions({ key: "starter", monthlyPriceMicros: 10_000_000 })).toBe(
      false,
    );
    expect(planIncludesOwnSubscriptions({ key: "free", monthlyPriceMicros: null })).toBe(false);
  });
});

describe("own-subscription admission", () => {
  let codex: ReturnType<typeof spyOn<typeof opengeniDb, "isCodexBilledTurn">>;
  let core: ReturnType<typeof spyOn<typeof opengeniDb, "readSubscriptionCoreFunding">>;
  let allowance: ReturnType<typeof spyOn<typeof opengeniDb, "checkWorkspaceAllowance">>;
  let balance: ReturnType<typeof paidCredit>;
  beforeEach(() => {
    codex = spyOn(opengeniDb, "isCodexBilledTurn").mockResolvedValue(true);
    core = spyOn(opengeniDb, "readSubscriptionCoreFunding").mockResolvedValue(true);
    allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockResolvedValue(null);
    // No paid credit at all: a subscription never needs any.
    balance = paidCredit(0);
  });
  afterEach(() => {
    codex.mockRestore();
    core.mockRestore();
    allowance.mockRestore();
    balance.mockRestore();
  });

  /** Every admission path for one own-subscription run or call. */
  async function admissions(s: Settings, model: string, billingOrigin: BillingOrigin = "app") {
    const services = { db, settings: s, entitlements: null };
    const run = await checkLimit(services, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      model,
      action: "agent_run:create",
      billingOrigin,
    });
    const denial = await agentRunAdmissionDenial(services, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      model,
      requestedAgentRuns: 1,
      billingOrigin,
    });
    const goal = await goalRunBudgetBlocked(services, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      model,
      billingOrigin,
    });
    const call = await admitModelCall(services, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      model,
      chargesOpenGeniCredits: false,
      countsTowardTokenCap: false,
      subjectId: null,
      billingOrigin,
      ownSubscription: true,
    });
    let between: unknown = null;
    try {
      await ensureRunAllowedBetweenModelCalls({
        ...services,
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        modelId: model,
        isExternallyBilledTurn: true,
        chargesOpenGeniCredits: false,
        countsTowardTokenCap: false,
        initiatingHumanSubjectId: null,
        billingOrigin,
        ownSubscription: true,
      });
    } catch (error) {
      between = error;
    }
    return { run, denial, goal, call, between };
  }

  test.each([CODEX_MODEL, SUPERGROK_MODEL])(
    "the Free plan is refused with one Upgrade to Pro action, on every path (%s)",
    async (model) => {
      const plan = onPlan("free");
      try {
        const result = await admissions(settings(), model);
        expect(result.run).toEqual({
          allowed: false,
          code: SUBSCRIPTION_PLAN_REQUIRED_CODE,
          message: SUBSCRIPTION_PLAN_REQUIRED_MESSAGE,
        });
        expect(result.denial).toBe("subscription_plan_required");
        expect(result.goal).toEqual({
          pausedReason: "credits",
          message: "Upgrade to Pro to use your own subscription, then resume.",
        });
        expect(result.call).toMatchObject({
          allowed: false,
          subscriptionPlanRequired: true,
          message: SUBSCRIPTION_PLAN_REQUIRED_MESSAGE,
        });
        expect(String(result.between)).toContain(SUBSCRIPTION_PLAN_REQUIRED_MESSAGE);
        // A subscription never reads paid credit for a fee.
        expect(balance).not.toHaveBeenCalled();
      } finally {
        plan.mockRestore();
      }
    },
  );

  test("no plan, a past-due plan and a canceled plan are refused too", async () => {
    for (const [key, status] of [
      [null, "active"],
      ["pro", "past_due"],
      ["max", "canceled"],
    ] as const) {
      const plan = onPlan(key, status);
      try {
        const result = await admissions(settings(), CODEX_MODEL);
        expect(result.run).toMatchObject({ allowed: false, code: SUBSCRIPTION_PLAN_REQUIRED_CODE });
        expect(result.denial).toBe("subscription_plan_required");
      } finally {
        plan.mockRestore();
      }
    }
  });

  test.each([CODEX_MODEL, SUPERGROK_MODEL])(
    "API work never uses a connected subscription, on any plan or fee setting (%s)",
    async (model) => {
      for (const key of [null, "free", "pro", "max", "enterprise"]) {
        const plan = onPlan(key);
        try {
          for (const byokPlatformFeeBps of [0, 500]) {
            const result = await admissions(settings({ byokPlatformFeeBps }), model, "api");
            expect(result.run).toEqual({
              allowed: false,
              code: SUBSCRIPTION_API_UNAVAILABLE_CODE,
              message: SUBSCRIPTION_API_UNAVAILABLE_MESSAGE,
            });
            expect(result.denial).toBe(SUBSCRIPTION_API_UNAVAILABLE_CODE);
            expect(result.goal).toEqual({
              pausedReason: "model_unavailable",
              message: SUBSCRIPTION_API_UNAVAILABLE_MESSAGE,
            });
            expect(result.call).toEqual({
              allowed: false,
              denial: SUBSCRIPTION_API_UNAVAILABLE_CODE,
              message: SUBSCRIPTION_API_UNAVAILABLE_MESSAGE,
            });
            expect(String(result.between)).toContain(SUBSCRIPTION_API_UNAVAILABLE_MESSAGE);
          }
          expect(plan).not.toHaveBeenCalled();
          expect(balance).not.toHaveBeenCalled();
        } finally {
          plan.mockRestore();
        }
      }
    },
  );

  test.each(["pro", "max", "enterprise"])(
    "%s admits unlimited subscription use with no paid credit and no fee read",
    async (key) => {
      const plan = onPlan(key);
      try {
        for (const model of [CODEX_MODEL, SUPERGROK_MODEL]) {
          const result = await admissions(settings(), model);
          expect(result.run).toEqual({ allowed: true });
          expect(result.denial).toBeNull();
          expect(result.goal).toBeNull();
          expect(result.call.allowed).toBe(true);
          expect(result.between).toBeNull();
        }
        expect(balance).not.toHaveBeenCalled();
      } finally {
        plan.mockRestore();
      }
    },
  );

  test.each([CODEX_MODEL, SUPERGROK_MODEL])(
    "with the operator opt-in, API work uses a connected subscription like app work (%s)",
    async (model) => {
      const optedIn = settings({ apiConnectedSubscriptionsEnabled: true });
      const pro = onPlan("pro");
      try {
        const result = await admissions(optedIn, model, "api");
        expect(result.run).toEqual({ allowed: true });
        expect(result.denial).toBeNull();
        expect(result.goal).toBeNull();
        expect(result.call.allowed).toBe(true);
        expect(result.between).toBeNull();
        expect(balance).not.toHaveBeenCalled();
      } finally {
        pro.mockRestore();
      }
      // The opt-in lifts only the API refusal; the paid-plan rule still applies.
      const free = onPlan("free");
      try {
        const result = await admissions(optedIn, model, "api");
        expect(result.run).toEqual({
          allowed: false,
          code: SUBSCRIPTION_PLAN_REQUIRED_CODE,
          message: SUBSCRIPTION_PLAN_REQUIRED_MESSAGE,
        });
        expect(result.denial).toBe("subscription_plan_required");
        expect(result.call).toMatchObject({ allowed: false, subscriptionPlanRequired: true });
        expect(String(result.between)).toContain(SUBSCRIPTION_PLAN_REQUIRED_MESSAGE);
      } finally {
        free.mockRestore();
      }
      // Without credit billing (a typical self-hosted deployment) no plan is read.
      const unread = onPlan(null);
      try {
        const result = await admissions(
          settings({
            apiConnectedSubscriptionsEnabled: true,
            billingMode: "disabled",
            usageLimitsMode: "none",
            subscriptionPlansEnabled: false,
          }),
          model,
          "api",
        );
        expect(result.run).toEqual({ allowed: true });
        expect(result.denial).toBeNull();
        expect(result.goal).toBeNull();
        expect(result.call.allowed).toBe(true);
        expect(result.between).toBeNull();
        expect(unread).not.toHaveBeenCalled();
      } finally {
        unread.mockRestore();
      }
    },
  );

  test("a legacy-billing account (internal) is exempt and its plan is never read", async () => {
    const plan = onPlan("free");
    try {
      const result = await admissions(
        settings({ billingLegacyAccountIds: [ACCOUNT] }),
        CODEX_MODEL,
      );
      expect(result.run).toEqual({ allowed: true });
      expect(result.denial).toBeNull();
      expect(result.call.allowed).toBe(true);
      expect(result.between).toBeNull();
      expect(plan).not.toHaveBeenCalled();
      expect(balance).not.toHaveBeenCalled();
    } finally {
      plan.mockRestore();
    }
  });

  test("without Stripe billing or subscription plans there is no plan to need", async () => {
    const plan = onPlan("free");
    try {
      for (const s of [
        settings({ subscriptionPlansEnabled: false }),
        settings({ billingMode: "disabled" }),
      ]) {
        expect((await admissions(s, CODEX_MODEL)).run).toEqual({ allowed: true });
      }
      expect(plan).not.toHaveBeenCalled();
    } finally {
      plan.mockRestore();
    }
  });

  test("an own API key still needs paid credit for its fee on any plan", async () => {
    codex.mockResolvedValue(false);
    const plan = onPlan("max");
    try {
      const services = { db, settings: settings(), entitlements: null };
      expect(
        await checkLimit(services, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          model: OWN_KEY_MODEL,
          action: "agent_run:create",
          billingOrigin: "app",
        }),
      ).toMatchObject({ allowed: false, code: BYOK_PAID_CREDIT_REQUIRED_CODE });
      expect(plan).not.toHaveBeenCalled();
    } finally {
      plan.mockRestore();
    }
  });
});

const NO_FEE_DEBIT = {
  debitedMicros: 0,
  planPaidMicros: 0,
  creditPaidMicros: 0,
  unfundedMicros: 0,
};

describe("own-subscription settlement", () => {
  let recorded: ReturnType<typeof spyOn<typeof opengeniDb, "recordUsageEvent">>;
  let debit: ReturnType<typeof spyOn<typeof opengeniDb, "applyByokPlatformFeeDebit">>;
  beforeEach(() => {
    recorded = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
    debit = spyOn(opengeniDb, "applyByokPlatformFeeDebit").mockResolvedValue(NO_FEE_DEBIT);
  });
  afterEach(() => {
    recorded.mockRestore();
    debit.mockRestore();
  });

  const settle = (model: string) =>
    recordModelUsageAndDebitCredits(settings(), db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess",
      turnId: "turn",
      turnAttemptId: "attempt",
      model,
      externallyBilled: true,
      chargesOpenGeniCredits: false,
      countsTowardTokenCap: false,
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 },
      sourceKey: `response-${model}`,
    });

  test("a response on the person's own subscription pays no fee", async () => {
    for (const model of [CODEX_MODEL, SUPERGROK_MODEL]) {
      const billing = await settle(model);
      expect(billing.byokPlatformFeeMicros).toBeUndefined();
    }
    expect(debit).not.toHaveBeenCalled();
  });

  test("a response on the person's own API key still pays it", async () => {
    await settle(OWN_KEY_MODEL);
    expect(debit).toHaveBeenCalledTimes(1);
    expect(debit.mock.calls[0]![1].metadata).toMatchObject({ feeBps: 500 });
  });
});

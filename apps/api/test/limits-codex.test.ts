import { describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import type { Settings } from "@opengeni/config";
import { checkLimit, requireLimit } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";

const ACCOUNT = "acct-1";
const WORKSPACE = "ws-1";

// Live config that reproduces the bug: billingMode=stripe + usageLimitsMode=managed,
// codex feature enabled, account has 0 OpenGeni credits.
function billedSettings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({
    billingMode: "stripe",
    usageLimitsMode: "managed",
    codexSubscriptionEnabled: true,
    ...overrides,
  });
}

function deps(settings: Settings): ApiRouteDeps {
  return { settings, db: {} as opengeniDb.Database } as ApiRouteDeps;
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

function mockCodexBilled(active: boolean): () => void {
  // This suite owns the API credit-gate decision, not the DB allocator. Mock
  // the canonical billed-turn seam directly so a deliberately empty DB fixture
  // does not need to emulate the cutover-aware RLS/rotation-row transaction.
  // Real credential status, pool admission, and cutover behavior are exercised
  // against native Postgres in the DB suites.
  const spy = spyOn(opengeniDb, "isCodexBilledTurn").mockResolvedValue(active);
  return () => spy.mockRestore();
}

describe("API edge credit gate — codex bypass", () => {
  test("(a) codex model + ACTIVE credential bypasses the 0-credit gate", async () => {
    const restoreBal = mockZeroBalance();
    const restoreCred = mockCodexBilled(true);
    try {
      const decision = await checkLimit(deps(billedSettings()), {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        action: "agent_run:create",
        quantity: 1,
        model: "codex/gpt-5.6-sol",
      });
      expect(decision.allowed).toBe(true);
      // requireLimit must NOT throw a 402 for a codex-billed turn.
      await requireLimit(deps(billedSettings()), {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        action: "agent_run:create",
        quantity: 1,
        model: "codex/gpt-5.6-sol",
      });
    } finally {
      restoreCred();
      restoreBal();
    }
  });

  test("(b) codex MODEL but NO active credential is still gated (402, no free bypass)", async () => {
    const restoreBal = mockZeroBalance();
    const restoreCred = mockCodexBilled(false);
    try {
      const decision = await checkLimit(deps(billedSettings()), {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        action: "agent_run:create",
        quantity: 1,
        model: "codex/gpt-5.6-sol",
      });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("insufficient_credits");
      await expect(
        requireLimit(deps(billedSettings()), {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          action: "agent_run:create",
          quantity: 1,
          model: "codex/gpt-5.6-sol",
        }),
      ).rejects.toMatchObject({ status: 402 });
    } finally {
      restoreCred();
      restoreBal();
    }
  });

  test("(c) a normal model with 0 credits is still gated exactly as before (402)", async () => {
    const restoreBal = mockZeroBalance();
    // No credential spy: a normal model never triggers a credential read.
    try {
      const decision = await checkLimit(deps(billedSettings()), {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        action: "agent_run:create",
        quantity: 1,
        model: "scripted-model",
      });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("insufficient_credits");
      await expect(
        requireLimit(deps(billedSettings()), {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          action: "agent_run:create",
          quantity: 1,
          model: "scripted-model",
        }),
      ).rejects.toMatchObject({ status: 402 });
    } finally {
      restoreBal();
    }
  });

  test("(c2) a normal model with a positive balance is allowed (control: gate logic intact)", async () => {
    const spy = spyOn(opengeniDb, "getBillingBalance").mockResolvedValue({
      accountId: ACCOUNT,
      balanceMicros: 1_000_000,
      currency: "usd",
      updatedAt: new Date().toISOString(),
    });
    try {
      const decision = await checkLimit(deps(billedSettings()), {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        action: "agent_run:create",
        quantity: 1,
        model: "scripted-model",
      });
      expect(decision.allowed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("an external provider bypasses credits only when deployment cost marks it free", async () => {
    const restoreBal = mockZeroBalance();
    const settings = billedSettings({
      modelCostPolicyJson: JSON.stringify({ "opencode/x-preview-f-free": "free" }),
      modelProvidersJson: JSON.stringify([
        {
          kind: "anonymous",
          id: "opencode-zen",
          label: "OpenCode Zen",
          api: "chat",
          baseUrl: "https://opencode.ai/zen/v1",
          models: [
            {
              id: "opencode/x-preview-f-free",
              upstreamModelId: "x-preview-f-free",
              label: "OpenCode Ox Alpha",
            },
          ],
        },
      ]),
    });
    try {
      const decision = await checkLimit(deps(settings), {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        action: "agent_run:create",
        quantity: 1,
        model: "opencode/x-preview-f-free",
      });
      expect(decision.allowed).toBe(true);
      await requireLimit(deps(settings), {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        action: "agent_run:create",
        quantity: 1,
        model: "opencode/x-preview-f-free",
      });
    } finally {
      restoreBal();
    }
  });

  test("external upstream settlement alone does not bypass deployment credit pricing", async () => {
    const restoreBal = mockZeroBalance();
    const settings = billedSettings({
      modelProvidersJson: JSON.stringify([
        {
          kind: "anonymous",
          id: "opencode-zen",
          label: "OpenCode Zen",
          api: "chat",
          baseUrl: "https://opencode.ai/zen/v1",
          models: [
            {
              id: "opencode/x-preview-f-free",
              upstreamModelId: "x-preview-f-free",
              label: "OpenCode Ox Alpha",
            },
          ],
        },
      ]),
    });
    try {
      const decision = await checkLimit(deps(settings), {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        action: "agent_run:create",
        quantity: 1,
        model: "opencode/x-preview-f-free",
      });
      expect(decision).toMatchObject({ allowed: false, code: "insufficient_credits" });
    } finally {
      restoreBal();
    }
  });

  test("deployment cost free bypasses credits without bypassing the workspace token cap", async () => {
    const restoreBal = mockZeroBalance();
    const usageSpy = spyOn(opengeniDb, "sumUsageQuantity").mockResolvedValue(100);
    const settings = billedSettings({
      staticUsageLimitsJson: JSON.stringify({ maxMonthlyTokensPerWorkspace: 100 }),
      modelCostPolicyJson: JSON.stringify({ "scripted-model": "free" }),
    });
    try {
      const decision = await checkLimit(deps(settings), {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        action: "tokens:consume",
        quantity: 1,
        model: "scripted-model",
      });
      expect(decision).toMatchObject({
        allowed: false,
        code: "max_monthly_tokens_per_workspace",
      });
    } finally {
      usageSpy.mockRestore();
      restoreBal();
    }
  });

  test("infra cap (workspace:create) never reads codex credential and is unaffected", async () => {
    const restoreBal = mockZeroBalance();
    // workspace:create is a non-costly action with no workspaceId/model: getBillingBalance
    // is never even consulted (not costly), so 0 credits does not block it.
    try {
      const decision = await checkLimit(deps(billedSettings()), {
        accountId: ACCOUNT,
        action: "workspace:create",
        quantity: 1,
      });
      expect(decision.allowed).toBe(true);
    } finally {
      restoreBal();
    }
  });
});

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
  return testSettings({ billingMode: "stripe", usageLimitsMode: "managed", codexSubscriptionEnabled: true, ...overrides });
}

function deps(settings: Settings): ApiRouteDeps {
  return { settings, db: {} as opengeniDb.Database } as ApiRouteDeps;
}

function mockZeroBalance(): () => void {
  const spy = spyOn(opengeniDb, "getBillingBalance").mockResolvedValue({
    accountId: ACCOUNT, balanceMicros: 0, currency: "usd", updatedAt: new Date().toISOString(),
  });
  return () => spy.mockRestore();
}

function mockCredentialStatus(status: string): () => void {
  const spy = spyOn(opengeniDb, "getCodexCredentialStatus").mockResolvedValue({
    connected: status === "active", chatgptAccountId: "a", scopes: null, planType: "pro",
    status, expiresAt: null, lastRefreshAt: null, lastError: null,
  } as Awaited<ReturnType<typeof opengeniDb.getCodexCredentialStatus>>);
  return () => spy.mockRestore();
}

describe("API edge credit gate — codex bypass", () => {
  test("(a) codex model + ACTIVE credential bypasses the 0-credit gate", async () => {
    const restoreBal = mockZeroBalance();
    const restoreCred = mockCredentialStatus("active");
    try {
      const decision = await checkLimit(deps(billedSettings()), {
        accountId: ACCOUNT, workspaceId: WORKSPACE, action: "agent_run:create", quantity: 1, model: "codex/gpt-5.5",
      });
      expect(decision.allowed).toBe(true);
      // requireLimit must NOT throw a 402 for a codex-billed turn.
      await requireLimit(deps(billedSettings()), {
        accountId: ACCOUNT, workspaceId: WORKSPACE, action: "agent_run:create", quantity: 1, model: "codex/gpt-5.5",
      });
    } finally { restoreCred(); restoreBal(); }
  });

  test("(b) codex MODEL but NO active credential is still gated (402, no free bypass)", async () => {
    const restoreBal = mockZeroBalance();
    const restoreCred = mockCredentialStatus("needs_relogin");
    try {
      const decision = await checkLimit(deps(billedSettings()), {
        accountId: ACCOUNT, workspaceId: WORKSPACE, action: "agent_run:create", quantity: 1, model: "codex/gpt-5.5",
      });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("insufficient_credits");
      await expect(requireLimit(deps(billedSettings()), {
        accountId: ACCOUNT, workspaceId: WORKSPACE, action: "agent_run:create", quantity: 1, model: "codex/gpt-5.5",
      })).rejects.toMatchObject({ status: 402 });
    } finally { restoreCred(); restoreBal(); }
  });

  test("(c) a normal model with 0 credits is still gated exactly as before (402)", async () => {
    const restoreBal = mockZeroBalance();
    // No credential spy: a normal model never triggers a credential read.
    try {
      const decision = await checkLimit(deps(billedSettings()), {
        accountId: ACCOUNT, workspaceId: WORKSPACE, action: "agent_run:create", quantity: 1, model: "scripted-model",
      });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("insufficient_credits");
      await expect(requireLimit(deps(billedSettings()), {
        accountId: ACCOUNT, workspaceId: WORKSPACE, action: "agent_run:create", quantity: 1, model: "scripted-model",
      })).rejects.toMatchObject({ status: 402 });
    } finally { restoreBal(); }
  });

  test("(c2) a normal model with a positive balance is allowed (control: gate logic intact)", async () => {
    const spy = spyOn(opengeniDb, "getBillingBalance").mockResolvedValue({
      accountId: ACCOUNT, balanceMicros: 1_000_000, currency: "usd", updatedAt: new Date().toISOString(),
    });
    try {
      const decision = await checkLimit(deps(billedSettings()), {
        accountId: ACCOUNT, workspaceId: WORKSPACE, action: "agent_run:create", quantity: 1, model: "scripted-model",
      });
      expect(decision.allowed).toBe(true);
    } finally { spy.mockRestore(); }
  });

  test("infra cap (workspace:create) never reads codex credential and is unaffected", async () => {
    const restoreBal = mockZeroBalance();
    // workspace:create is a non-costly action with no workspaceId/model: getBillingBalance
    // is never even consulted (not costly), so 0 credits does not block it.
    try {
      const decision = await checkLimit(deps(billedSettings()), {
        accountId: ACCOUNT, action: "workspace:create", quantity: 1,
      });
      expect(decision.allowed).toBe(true);
    } finally { restoreBal(); }
  });
});

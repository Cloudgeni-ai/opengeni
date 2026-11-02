import { afterEach, expect, spyOn, test } from "bun:test";
import { DEFAULT_OPENROUTER_MODEL_ID, type Settings } from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { resolveDefaultSessionModelForSelections } from "../src/default-session-model";
import { resolveWorkspaceModelSelection } from "../src/model-catalog";

// Own subscriptions need a paid plan of at least $20 a month. On Free a
// connected subscription stays connected, but it is never picked as the
// default for a new chat or scheduled task: every use would be refused.
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function settings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({
    openrouterApiKey: "openrouter-test-key",
    openaiModel: DEFAULT_OPENROUTER_MODEL_ID,
    openaiAllowedModels: "gpt-6-astra,gpt-6-sol,gpt-6-luna",
    billingMode: "stripe",
    subscriptionPlansEnabled: true,
    codexSubscriptionEnabled: true,
    ...overrides,
  });
}

function onPlan(key: string, monthlyPriceMicros: number) {
  const mocked = spyOn(opengeniDb, "getOrganizationPlanStanding").mockResolvedValue({
    plan: { key, status: "active" } as never,
    monthlyPriceMicros,
  });
  restores.push(() => mocked.mockRestore());
  return mocked;
}

async function defaultFor(s: Settings, accountId = crypto.randomUUID()) {
  return await resolveDefaultSessionModelForSelections({} as Database, {
    settings: s,
    accountId,
    workspaceSettings: {},
    selections: resolveWorkspaceModelSelection({
      settings: s,
      policy: null,
      codexSubscriptionActive: true,
      xaiSubscriptionActive: false,
    }),
    organizationDefaults: null,
    creditBalance: {
      accountId,
      balanceMicros: 0,
      currency: "usd",
      updatedAt: new Date().toISOString(),
    },
  });
}

test("on Pro a connected subscription is the default", async () => {
  const standing = onPlan("pro", 20_000_000);
  expect(await defaultFor(settings())).toMatchObject({ source: "subscription" });
  expect(standing).toHaveBeenCalledTimes(1);
});

test("on Free a connected subscription is not the default; a model the account can run is", async () => {
  onPlan("free", 0);
  const chosen = await defaultFor(settings());
  expect(chosen.source).not.toBe("subscription");
  expect(chosen.model).toBe(DEFAULT_OPENROUTER_MODEL_ID);
});

test("without subscription plans the plan is never read and the subscription stays the default", async () => {
  const standing = onPlan("free", 0);
  expect(await defaultFor(settings({ subscriptionPlansEnabled: false }))).toMatchObject({
    source: "subscription",
  });
  expect(standing).not.toHaveBeenCalled();
});

test("a failed plan read keeps the subscription selectable instead of failing the default", async () => {
  const mocked = spyOn(opengeniDb, "getOrganizationPlanStanding").mockRejectedValue(
    new Error("Subscription plan catalog is missing"),
  );
  restores.push(() => mocked.mockRestore());
  expect(await defaultFor(settings())).toMatchObject({ source: "subscription" });
});

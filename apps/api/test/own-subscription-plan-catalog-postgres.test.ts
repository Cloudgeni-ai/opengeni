import { afterAll, beforeAll, expect, test } from "bun:test";
import { DEFAULT_BILLING_LEGACY_ACCOUNT_IDS } from "@opengeni/config";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  readSubscriptionPlanCatalog,
  upsertOrganizationPlan,
  type DbClient,
  type OrganizationPlanStateInput,
} from "@opengeni/db";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createApp } from "../src/app";
import { ownSubscriptionPlanNeeded } from "../src/own-subscription-plan";

// Real PostgreSQL: the model catalog says which plan an organization needs
// before its own subscriptions run, named and priced from the plan catalog,
// on the same plan read admission refuses with.

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-own-subscription-plan-catalog");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("PostgreSQL required");
  }
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: "own-subscription-plan-catalog",
  billingMode: "stripe",
  stripeSecretKey: "sk_test_example",
  subscriptionPlansEnabled: true,
  billingLegacyAccountIds: [...DEFAULT_BILLING_LEGACY_ACCOUNT_IDS],
  sandboxBackend: "none",
  openrouterApiKey: "test-key",
  openaiAllowedModels: "gpt-6-astra,gpt-6-luna",
});

async function organizationOn(
  planKey: string,
  status: OrganizationPlanStateInput["status"] = "active",
) {
  const user = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test:own-subscription-plan",
    accountExternalId: user,
    accountName: "Own subscription plan",
    workspaceExternalSource: "test:own-subscription-plan",
    workspaceExternalId: user,
    workspaceName: "Own subscription plan",
    subjectId: `user:${user}`,
  });
  const grant = access.workspaceGrants[0]!;
  await upsertOrganizationPlan(client!.db, {
    accountId: grant.accountId,
    planKey,
    status,
    ...(planKey === "free" ? {} : { stripeSubscriptionId: `sub_${crypto.randomUUID()}` }),
    currentPeriodStart: new Date(Date.now() - 1000),
    currentPeriodEnd: new Date(Date.now() + 3_600_000),
  });
  return grant;
}

async function modelCatalog(grant: Awaited<ReturnType<typeof organizationOn>>) {
  const app = createApp({
    settings,
    db: client!.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    managedAuth: null,
  });
  const token = await signDelegatedAccessToken(settings.delegationSecret!, {
    ...grant,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const response = await app.request(`/v1/workspaces/${grant.workspaceId}/model-catalog`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { ownSubscriptionPlan?: unknown };
}

/** Pro and Max on sale through Stripe (priced), or with no Stripe price (not buyable). */
async function sellPaidPlans(priced: boolean) {
  const { plans } = await readSubscriptionPlanCatalog(client!.db);
  const catalog = plans.map((plan) =>
    plan.key === "pro" || plan.key === "max"
      ? { ...plan, stripePriceId: priced ? `price_${plan.key}` : null }
      : plan,
  );
  await shared!
    .admin`select set_subscription_plan_catalog(${shared!.admin.json(catalog)}, 'own-subscription-plan-test', 'Own subscription plan hint')`;
}

test("Free names the cheapest catalog plan that includes own subscriptions, with its price", async () => {
  if (!client) return;
  await sellPaidPlans(true);
  const { plans } = await readSubscriptionPlanCatalog(client.db);
  const pro = plans.find((plan) => plan.key === "pro")!;
  const expected = { key: "pro", label: pro.label, monthlyPriceMicros: pro.monthlyPriceMicros };
  const free = await organizationOn("free");
  expect(await ownSubscriptionPlanNeeded(client.db, settings, free.accountId)).toEqual(expected);
  // The catalog says so before anything is connected, for connect steps.
  expect((await modelCatalog(free)).ownSubscriptionPlan).toEqual(expected);
  // A lapsed Pro payment doesn't include them either.
  const pastDue = await organizationOn("pro", "past_due");
  expect(await ownSubscriptionPlanNeeded(client.db, settings, pastDue.accountId)).toEqual(expected);
}, 180_000);

test("Pro and above, legacy terms, and deployments without paid plans need nothing", async () => {
  if (!client) return;
  for (const key of ["pro", "max"]) {
    const grant = await organizationOn(key);
    expect(await ownSubscriptionPlanNeeded(client.db, settings, grant.accountId)).toBe(null);
    expect((await modelCatalog(grant)).ownSubscriptionPlan).toBeUndefined();
  }
  const free = await organizationOn("free");
  expect(
    await ownSubscriptionPlanNeeded(
      client.db,
      { ...settings, subscriptionPlansEnabled: false },
      free.accountId,
    ),
  ).toBe(null);
  expect(
    await ownSubscriptionPlanNeeded(
      client.db,
      { ...settings, billingLegacyAccountIds: [free.accountId] },
      free.accountId,
    ),
  ).toBe(null);
}, 180_000);

test("a catalog that sells no such plan names none", async () => {
  if (!client) return;
  await sellPaidPlans(false);
  const free = await organizationOn("free");
  expect(await ownSubscriptionPlanNeeded(client.db, settings, free.accountId)).toBe(null);
  expect((await modelCatalog(free)).ownSubscriptionPlan).toBeUndefined();
  await sellPaidPlans(true);
}, 180_000);

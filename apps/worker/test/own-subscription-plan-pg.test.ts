import { afterAll, beforeAll, expect, test } from "bun:test";
import { DEFAULT_BILLING_LEGACY_ACCOUNT_IDS } from "@opengeni/config";
import { SUBSCRIPTION_PLAN_REQUIRED_CODE } from "@opengeni/contracts";
import {
  admitModelCall,
  checkOwnSubscriptionPlan,
  ownSubscriptionPlanAllows,
} from "@opengeni/core";
import {
  createDb,
  ensureManagedAccessForUser,
  getOrganizationPlanStanding,
  readSubscriptionPlanCatalog,
  upsertOrganizationPlan,
  type DbClient,
  type OrganizationPlanStateInput,
} from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

// Real PostgreSQL: own subscriptions need an active or trialing plan of at
// least $20 a month, read from the organization's plan row and the catalog.
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-own-subscription-plan");
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
  billingMode: "stripe",
  usageLimitsMode: "managed",
  subscriptionPlansEnabled: true,
  billingLegacyAccountIds: [...DEFAULT_BILLING_LEGACY_ACCOUNT_IDS],
});

async function organization() {
  return (await organizationWithWorkspace()).accountId;
}

async function organizationWithWorkspace() {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Subscription owner",
  });
  return { accountId: access.defaultAccountId!, workspaceId: access.defaultWorkspaceId! };
}

async function onPlan(
  accountId: string,
  planKey: string,
  status: OrganizationPlanStateInput["status"] = "active",
) {
  await upsertOrganizationPlan(client!.db, {
    accountId,
    planKey,
    status,
    ...(planKey === "free" ? {} : { stripeSubscriptionId: `sub_${crypto.randomUUID()}` }),
    currentPeriodStart: new Date(Date.now() - 1000),
    currentPeriodEnd: new Date(Date.now() + 3_600_000),
  });
}

test("Free is refused with the upgrade code; Pro and above are allowed while in good standing", async () => {
  if (!client) return;
  const catalog = await readSubscriptionPlanCatalog(client.db);
  const price = (key: string) =>
    catalog.plans.find((entry) => entry.key === key)?.monthlyPriceMicros ?? null;
  expect(price("free")).toBe(0);
  expect(price("pro")).toBe(20_000_000);

  const fresh = await organization();
  expect(await ownSubscriptionPlanAllows(client.db, settings, fresh)).toBe(false);
  expect(await checkOwnSubscriptionPlan({ db: client.db, settings }, fresh)).toEqual({
    allowed: false,
    code: SUBSCRIPTION_PLAN_REQUIRED_CODE,
    message: "Upgrade to Pro to use your own subscription.",
  });

  const free = await organization();
  await onPlan(free, "free");
  expect((await getOrganizationPlanStanding(client.db, free)).monthlyPriceMicros).toBe(0);
  expect(await ownSubscriptionPlanAllows(client.db, settings, free)).toBe(false);

  for (const key of catalog.plans.map((entry) => entry.key).filter((name) => name !== "free")) {
    const paid = await organization();
    await onPlan(paid, key);
    const standing = await getOrganizationPlanStanding(client.db, paid);
    expect(standing.plan?.key).toBe(key);
    expect(standing.monthlyPriceMicros).toBe(price(key));
    expect(await ownSubscriptionPlanAllows(client.db, settings, paid)).toBe(
      price(key) === null || price(key)! >= 20_000_000,
    );
    expect(await checkOwnSubscriptionPlan({ db: client.db, settings }, paid, "api")).toMatchObject({
      allowed: false,
      code: "subscription_api_unavailable",
    });
    expect(
      await admitModelCall(
        { db: client.db, settings },
        {
          accountId: paid,
          workspaceId: crypto.randomUUID(),
          model: "codex/gpt-6-luna",
          chargesOpenGeniCredits: false,
          countsTowardTokenCap: false,
          subjectId: null,
          billingOrigin: "api",
          ownSubscription: true,
        },
      ),
    ).toMatchObject({ allowed: false, denial: "subscription_api_unavailable" });
  }

  const trialing = await organization();
  await onPlan(trialing, "pro", "trialing");
  expect(await ownSubscriptionPlanAllows(client.db, settings, trialing)).toBe(true);

  const pastDue = await organization();
  await onPlan(pastDue, "pro", "past_due");
  expect(await ownSubscriptionPlanAllows(client.db, settings, pastDue)).toBe(false);
}, 120_000);

test("internal accounts on legacy billing are never refused, even without a plan", async () => {
  if (!client) return;
  const internal = DEFAULT_BILLING_LEGACY_ACCOUNT_IDS[0]!;
  expect(await checkOwnSubscriptionPlan({ db: client.db, settings }, internal)).toEqual({
    allowed: true,
  });
});

test("the operator opt-in lets API work use a subscription on a paid plan; Free still needs Pro", async () => {
  if (!client) return;
  const optedIn = { ...settings, apiConnectedSubscriptionsEnabled: true };
  const call = async ({ accountId, workspaceId }: { accountId: string; workspaceId: string }) =>
    await admitModelCall(
      { db: client!.db, settings: optedIn },
      {
        accountId,
        workspaceId,
        model: "codex/gpt-6-luna",
        chargesOpenGeniCredits: false,
        countsTowardTokenCap: false,
        subjectId: null,
        billingOrigin: "api",
        ownSubscription: true,
      },
    );
  const pro = await organizationWithWorkspace();
  await onPlan(pro.accountId, "pro");
  // Titles, transcription and realtime voice share this plan check.
  expect(
    await checkOwnSubscriptionPlan({ db: client.db, settings: optedIn }, pro.accountId, "api"),
  ).toEqual({ allowed: true });
  expect(await call(pro)).toMatchObject({ allowed: true });
  // Default off: the same account is refused for API work.
  expect(
    await checkOwnSubscriptionPlan({ db: client.db, settings }, pro.accountId, "api"),
  ).toMatchObject({ allowed: false, code: "subscription_api_unavailable" });

  const free = await organizationWithWorkspace();
  await onPlan(free.accountId, "free");
  expect(
    await checkOwnSubscriptionPlan({ db: client.db, settings: optedIn }, free.accountId, "api"),
  ).toMatchObject({ allowed: false, code: SUBSCRIPTION_PLAN_REQUIRED_CODE });
  expect(await call(free)).toMatchObject({ allowed: false, subscriptionPlanRequired: true });
}, 120_000);

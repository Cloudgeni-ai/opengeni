import { afterAll, beforeAll, expect, test } from "bun:test";
import { DEFAULT_BILLING_LEGACY_ACCOUNT_IDS } from "@opengeni/config";
import { SUBSCRIPTION_PLAN_REQUIRED_CODE } from "@opengeni/contracts";
import { checkOwnSubscriptionPlan, ownSubscriptionPlanAllows } from "@opengeni/core";
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
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Subscription owner",
  });
  return access.defaultAccountId!;
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

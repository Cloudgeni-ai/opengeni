import { afterAll, beforeAll, expect, test } from "bun:test";
import type Stripe from "stripe";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  applyCreditLedgerEntryOnce,
  autoTopUpCreditKey,
  createDb,
  ensureManagedAccessForUser,
  getCreditLedgerEntry,
  type DbClient,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { handleStripeWebhookEvent } from "../src/routes/billing";

let database: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  database = await acquireRestrictedRuntimeTestDatabase(
    "auto-top-up-adjustments",
    "adjustment_data",
  );
  if (!database) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(database.appUrl, { max: 2, searchPath: database.schema });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await database?.release();
}, 180_000);

async function fixture() {
  const userId = crypto.randomUUID();
  const accountId = (
    await ensureManagedAccessForUser(client!.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Auto-top-up adjustment",
    })
  ).defaultAccountId!;
  const key = crypto.randomUUID(),
    paymentId = `pi_${key}`;
  const metadata = {
    opengeni_account_id: accountId,
    opengeni_auto_top_up_v1: "1",
    opengeni_auto_top_up_operation: key,
    opengeni_credit_idempotency_key: autoTopUpCreditKey(key),
    opengeni_credit_micros: "25000000",
    opengeni_credit_coupon_v1: "1",
  };
  const deps = {
    db: client!.db,
    settings: testSettings({ billingMode: "stripe" }),
  } as ApiRouteDeps;
  const stripe = {
    paymentIntents: { retrieve: async () => ({ id: paymentId, metadata }) },
  } as unknown as Stripe;
  const grant = () =>
    applyCreditLedgerEntryOnce(client!.db, {
      accountId,
      type: "credit_topup",
      amountMicros: 25_000_000,
      sourceType: "stripe_auto_top_up",
      sourceId: paymentId,
      idempotencyKey: autoTopUpCreditKey(key),
      metadata: { stripeAmountTotalCents: 2750, stripePaymentIntentId: paymentId },
    });
  const event = (type: string, object: unknown) =>
    ({ id: `evt_${crypto.randomUUID()}`, type, livemode: false, data: { object } }) as Stripe.Event;
  return { accountId, paymentId, metadata, deps, stripe, grant, event };
}

test("refund arriving before settlement retries, then reverses only the original credit part once", async () => {
  if (!client) return;
  const f = await fixture();
  const refundId = `re_${crypto.randomUUID()}`;
  const event = f.event("refund.created", {
    id: refundId,
    status: "succeeded",
    amount: 1375,
    payment_intent: f.paymentId,
    metadata: {},
  });
  await expect(handleStripeWebhookEvent(f.deps, f.stripe, event)).rejects.toThrow(
    "missing a settled checkout",
  );
  await f.grant();
  await handleStripeWebhookEvent(f.deps, f.stripe, event);
  await handleStripeWebhookEvent(f.deps, f.stripe, event);
  expect(
    (await getCreditLedgerEntry(client.db, f.accountId, `stripe:refund:${refundId}`))?.amountMicros,
  ).toBe(-12_500_000);
}, 180_000);

test("out-of-order won dispute materializes one hold and one release for the paid top-up", async () => {
  if (!client) return;
  const f = await fixture();
  await f.grant();
  const disputeId = `dp_${crypto.randomUUID()}`;
  const dispute = { id: disputeId, status: "won", amount: 2750, metadata: f.metadata };
  await handleStripeWebhookEvent(f.deps, f.stripe, f.event("charge.dispute.closed", dispute));
  await handleStripeWebhookEvent(f.deps, f.stripe, f.event("charge.dispute.created", dispute));
  await handleStripeWebhookEvent(
    f.deps,
    f.stripe,
    f.event("charge.dispute.funds_reinstated", dispute),
  );
  expect(
    (await getCreditLedgerEntry(client.db, f.accountId, `stripe:dispute_hold:${disputeId}`))
      ?.amountMicros,
  ).toBe(-25_000_000);
  expect(
    (await getCreditLedgerEntry(client.db, f.accountId, `stripe:dispute_release:${disputeId}`))
      ?.amountMicros,
  ).toBe(25_000_000);
}, 180_000);

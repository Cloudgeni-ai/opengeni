import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import Stripe from "stripe";
import * as db from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { registerBillingRoutes } from "../src/routes/billing";

let shared: SharedTestDatabase | null = null;
let client: db.DbClient | null = null;
const stripe = new Stripe("sk_test_example");
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("stripe-dispute-ordering");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = db.createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture() {
  const userId = crypto.randomUUID();
  const access = await db.ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Credit test",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const creditKey = `checkout:${crypto.randomUUID()}`;
  await db.applyCreditLedgerEntry(client!.db, {
    accountId,
    amountMicros: 25_000_000,
    type: "credit_topup",
    sourceType: "stripe_checkout_session",
    idempotencyKey: creditKey,
    metadata: { stripeAmountTotalCents: 2500 },
  });
  await db.applyCreditLedgerEntry(client!.db, {
    accountId,
    amountMicros: 100_000_000,
    type: "grant",
    eligibleModelIds: ["model-a"],
    idempotencyKey: crypto.randomUUID(),
  });
  const disputeId = `dp_${crypto.randomUUID()}`;
  const app = new Hono();
  registerBillingRoutes(app, {
    db: client!.db,
    settings: testSettings({
      billingMode: "stripe",
      stripeSecretKey: "sk_test_example",
      stripeWebhookSecret: "whsec_example",
    }),
  } as never);
  const send = async (type: string, status = "won") => {
    const payload = JSON.stringify({
      id: `evt_${disputeId}_${type}`,
      type,
      livemode: false,
      data: {
        object: {
          id: disputeId,
          amount: 2500,
          status,
          metadata: {
            opengeni_account_id: accountId,
            opengeni_credit_micros: "25000000",
            opengeni_credit_idempotency_key: creditKey,
            opengeni_credit_coupon_v1: "1",
          },
        },
      },
    });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: "whsec_example",
    });
    return await app.request("/v1/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": signature },
      body: payload,
    });
  };
  return { accountId, disputeId, send };
}

test.each(["charge.dispute.closed", "charge.dispute.funds_reinstated"])(
  "%s restores general credits for ordered, reordered, concurrent and repeated notifications",
  async (resolution) => {
    if (!client) return;
    for (const order of ["ordered", "reordered", "concurrent"] as const) {
      const f = await fixture();
      const hold = () => f.send("charge.dispute.created", "needs_response");
      const release = () => f.send(resolution);
      const responses =
        order === "concurrent"
          ? await Promise.all([hold(), release()])
          : order === "ordered"
            ? [await hold(), await release()]
            : [await release(), await hold()];
      for (const response of responses) expect(response.status).toBe(200);
      expect((await release()).status).toBe(200);
      expect((await f.send("charge.dispute.funds_withdrawn", "needs_response")).status).toBe(200);
      expect((await f.send("charge.dispute.funds_reinstated")).status).toBe(200);
      const balance = await db.getBillingBalance(client.db, f.accountId);
      expect(balance.generalBalanceMicros).toBe(25_000_000);
      expect(balance.promotionalCredits?.[0]?.remainingMicros).toBe(100_000_000);
    }
  },
  180_000,
);

test("a failed release rolls back its synthesized hold and remains retryable", async () => {
  if (!client) return;
  const f = await fixture();
  const apply = db.applyCreditLedgerEntry;
  const failure = spyOn(db, "applyCreditLedgerEntry").mockImplementation(async (tx, input) => {
    if (input.type === "credit_dispute_release") throw new Error("Synthetic release failure");
    return await apply(tx, input);
  });
  try {
    expect((await f.send("charge.dispute.closed")).status).toBe(500);
    expect(
      await db.hasCreditLedgerEntry(client.db, f.accountId, `stripe:dispute_hold:${f.disputeId}`),
    ).toBe(false);
    expect((await db.getBillingBalance(client.db, f.accountId)).generalBalanceMicros).toBe(
      25_000_000,
    );
  } finally {
    failure.mockRestore();
  }
  expect((await f.send("charge.dispute.closed")).status).toBe(200);
  expect(
    await db.hasCreditLedgerEntry(client.db, f.accountId, `stripe:dispute_release:${f.disputeId}`),
  ).toBe(true);
  expect((await db.getBillingBalance(client.db, f.accountId)).generalBalanceMicros).toBe(
    25_000_000,
  );
}, 180_000);

test("a lost dispute retains the hold", async () => {
  if (!client) return;
  const f = await fixture();
  expect((await f.send("charge.dispute.created", "needs_response")).status).toBe(200);
  expect((await f.send("charge.dispute.closed", "lost")).status).toBe(200);
  const balance = await db.getBillingBalance(client.db, f.accountId);
  expect(balance.generalBalanceMicros).toBe(0);
  expect(balance.promotionalCredits?.[0]?.remainingMicros).toBe(100_000_000);
}, 180_000);

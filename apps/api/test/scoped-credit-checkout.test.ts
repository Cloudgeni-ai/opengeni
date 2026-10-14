import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import Stripe from "stripe";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { registerBillingRoutes } from "../src/routes/billing";

const accountId = "00000000-0000-4000-8000-000000000001";
const stripe = new Stripe("sk_test_example");
const sessionPrototype = Object.getPrototypeOf(stripe.checkout.sessions);
const promoPrototype = Object.getPrototypeOf(stripe.promotionCodes);
const restores: { mockRestore(): void }[] = [];
let app: Hono;
let settings: ReturnType<typeof testSettings>;
let session: Stripe.Checkout.Session;
let created: Stripe.Checkout.SessionCreateParams | null;
let grants: Parameters<typeof db.applyCreditLedgerEntryOnce>[1][];

beforeEach(() => {
  restores.push(spyOn(db, "readCreditPromotionPolicy").mockResolvedValue(null));
  grants = [];
  created = null;
  settings = testSettings({
    billingMode: "stripe",
    stripeSecretKey: "sk_test_example",
    stripeWebhookSecret: "whsec_example",
    publicBaseUrl: "https://app.example.test",
    creditPromotionPolicy: {
      defaultModelIds: ["model-a"],
      offers: { coupon_example: { label: "Launch credits" } },
    },
  });
  restores.push(
    spyOn(core, "requireAccessContext").mockResolvedValue({
      defaultAccountId: accountId,
      accountGrants: [{ accountId, permissions: ["account:admin"] }],
      workspaceGrants: [],
    } as never),
  );
  restores.push(
    spyOn(db, "getBillingCustomer").mockResolvedValue({
      providerCustomerId: "cus_example",
    } as never),
  );
  restores.push(spyOn(db, "getManagedAccount").mockResolvedValue({ id: accountId } as never));
  restores.push(spyOn(db, "upsertBillingCustomer").mockResolvedValue(undefined as never));
  restores.push(
    spyOn(db, "hasCreditLedgerEntry").mockImplementation(async (_db, _account, key) =>
      grants.some((grant) => grant.idempotencyKey === key),
    ),
  );
  restores.push(
    spyOn(db, "getCreditLedgerEntry").mockImplementation(
      async (_db, _account, key) =>
        (grants.find((grant) => grant.idempotencyKey === key) as never) ?? null,
    ),
  );
  restores.push(
    spyOn(db, "applyCreditLedgerEntryOnce").mockImplementation(async (_db, grant) => {
      grants.push(grant);
      return { balance: {} as never, inserted: true };
    }),
  );
  restores.push(
    spyOn(db, "getBillingBalance").mockImplementation(async () => ({
      accountId,
      balanceMicros: grants.reduce((sum, grant) => sum + grant.amountMicros, 0),
      currency: "usd",
      updatedAt: new Date().toISOString(),
    })),
  );
  restores.push(spyOn(db, "recordStripeWebhookEvent").mockResolvedValue(true));
  restores.push(spyOn(db, "markStripeWebhookProcessed").mockResolvedValue(undefined));
  restores.push(
    spyOn(promoPrototype, "list").mockResolvedValue({
      data: [
        {
          id: "promo_example",
          promotion: {
            coupon: { id: "coupon_example", valid: true, currency: "usd", amount_off: 10000 },
          },
        },
      ],
    }),
  );
  restores.push(
    spyOn(sessionPrototype, "create").mockImplementation(
      async (params: Stripe.Checkout.SessionCreateParams) => {
        created = params;
        session = {
          id: "cs_test_example",
          mode: "payment",
          status: "open",
          payment_status: "unpaid",
          livemode: false,
          customer: "cus_example",
          url: "https://checkout.example.test/session",
          metadata: params.metadata,
          amount_subtotal: 10000,
          amount_total: 0,
          currency: "usd",
          total_details: { amount_discount: 10000, amount_shipping: 0, amount_tax: 0 },
        } as Stripe.Checkout.Session;
        return session;
      },
    ),
  );
  restores.push(spyOn(sessionPrototype, "retrieve").mockImplementation(async () => session));
  app = new Hono();
  registerBillingRoutes(app, { settings, db: {} } as core.ApiRouteDeps);
});
afterEach(() => {
  for (const spy of restores.splice(0).reverse()) spy.mockRestore();
});

function checkout(extra: Record<string, unknown> = {}) {
  return app.request("/v1/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId, promotionCode: "EXAMPLE", ...extra }),
  });
}
function complete() {
  session.status = "complete";
  session.payment_status = "no_payment_required";
}

test("scoped code uses a fixed $0 package and rejects a larger mixed purchase", async () => {
  expect((await checkout({ amountUsd: 125 })).status).toBe(422);
  expect(created).toBeNull();
  const response = await checkout();
  expect(response.status).toBe(200);
  expect((await response.json()).promotionalScope).toEqual({
    label: "Launch credits",
    eligibleModelIds: ["model-a"],
  });
  expect(created!.line_items?.[0]?.quantity).toBe(1);
  expect(created!.line_items?.[0]?.adjustable_quantity).toBeUndefined();
  expect(created!.automatic_tax?.enabled).toBe(false);
  expect(created!.allow_promotion_codes).toBeUndefined();
});

test("status recovery and duplicate webhooks grant the original scope exactly once", async () => {
  await checkout();
  settings.creditPromotionPolicy.defaultModelIds = ["model-b"];
  complete();
  const recovered = await app.request(`/v1/billing/checkout/${session.id}?accountId=${accountId}`);
  expect(recovered.status).toBe(200);
  expect((await recovered.json()).credit.promotionalScope.eligibleModelIds).toEqual(["model-a"]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const payload = JSON.stringify({
      id: "evt_example",
      type: "checkout.session.completed",
      livemode: false,
      data: { object: session },
    });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: "whsec_example",
    });
    const webhook = await app.request("/v1/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": signature },
      body: payload,
    });
    expect(webhook.status).toBe(200);
  }
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({
    amountMicros: 100_000_000,
    type: "grant",
    eligibleModelIds: ["model-a"],
  });
});

test("a scoped checkout that unexpectedly charges money cannot become unrestricted credit", async () => {
  await checkout();
  complete();
  session.payment_status = "paid";
  session.amount_total = 2500;
  const response = await app.request(`/v1/billing/checkout/${session.id}?accountId=${accountId}`);
  expect(response.status).toBe(500);
  expect(grants).toHaveLength(0);
});

test("checkout uses the current runtime policy over the deployment default", async () => {
  restores.push(
    spyOn(db, "readCreditPromotionPolicy").mockResolvedValue({
      defaultModelIds: ["model-b"],
      offers: { coupon_example: { label: "Launch credits" } },
    }),
  );
  const response = await checkout();
  expect(response.status).toBe(200);
  expect((await response.json()).promotionalScope.eligibleModelIds).toEqual(["model-b"]);
});

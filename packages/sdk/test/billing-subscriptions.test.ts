import { expect, test } from "bun:test";
import {
  BillingSubscriptionChange,
  CancelBillingSubscriptionRequest,
  ChangeBillingSubscriptionRequest,
  CreateSubscriptionCheckoutRequest,
  CreateSubscriptionCheckoutResponse,
} from "@opengeni/contracts";
import { OpenGeniClient } from "../src/client";
import type { ChangeBillingSubscriptionRequest as SdkChange } from "../src/index";

const accountId = "7d6c2b1e-4a5f-4e3d-9c8b-1a2b3c4d5e6f";
const idempotencyKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("subscription SDK methods preserve account selection, provider request keys and exact endpoint contracts", async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "dummy",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: `${url.pathname}${url.search}`, method: init?.method ?? "GET", body });
      return Response.json(
        url.pathname.endsWith("/checkout")
          ? { checkoutSessionId: "cs_plan", url: "https://checkout.stripe.test/plan" }
          : url.pathname.endsWith("/portal")
            ? { portalSessionId: "bps_plan", url: "https://billing.stripe.test/portal" }
            : url.pathname.endsWith("/plans")
              ? { accountId, revision: 1, plans: [], plan: null }
              : {
                  subscriptionId: "sub_plan",
                  planKey: "pro",
                  effectiveAt: "2026-10-16T12:00:00.000Z",
                  cancelAtPeriodEnd: false,
                },
      );
    },
  });
  const change: SdkChange = ChangeBillingSubscriptionRequest.parse({
    accountId,
    idempotencyKey,
    planKey: "pro",
  });
  await client.getBillingSubscriptionPlans({ accountId });
  const checkout = await client.createSubscriptionCheckout(
    CreateSubscriptionCheckoutRequest.parse(change),
  );
  expect(CreateSubscriptionCheckoutResponse.parse(checkout).checkoutSessionId).toBe("cs_plan");
  expect(
    BillingSubscriptionChange.parse(await client.upgradeBillingSubscription(change)).subscriptionId,
  ).toBe("sub_plan");
  await client.changeBillingSubscription(change);
  await client.cancelBillingSubscription(
    CancelBillingSubscriptionRequest.parse({ accountId, idempotencyKey }),
  );
  await client.createSubscriptionPortalSession({
    accountId,
    returnUrl: "https://app.example.test/billing",
  });
  expect(calls).toEqual([
    { path: `/v1/billing/subscription/plans?accountId=${accountId}`, method: "GET", body: null },
    { path: "/v1/billing/subscription/checkout", method: "POST", body: change },
    { path: "/v1/billing/subscription/upgrade", method: "POST", body: change },
    { path: "/v1/billing/subscription/change", method: "POST", body: change },
    {
      path: "/v1/billing/subscription/cancel",
      method: "POST",
      body: { accountId, idempotencyKey },
    },
    {
      path: "/v1/billing/subscription/portal",
      method: "POST",
      body: { accountId, returnUrl: "https://app.example.test/billing" },
    },
  ]);
});

test("write contracts require stable UUID request keys, and accept no client price/amount override", () => {
  expect(() => CreateSubscriptionCheckoutRequest.parse({ accountId, planKey: "pro" })).toThrow();
  expect(() =>
    ChangeBillingSubscriptionRequest.parse({ accountId, planKey: "pro", idempotencyKey: "random" }),
  ).toThrow();
  expect(() =>
    CreateSubscriptionCheckoutRequest.parse({
      accountId,
      planKey: "pro",
      idempotencyKey,
      priceId: "price_attacker",
    }),
  ).toThrow();
  expect(() =>
    CancelBillingSubscriptionRequest.parse({ accountId: "wrong-org", idempotencyKey }),
  ).toThrow();
});

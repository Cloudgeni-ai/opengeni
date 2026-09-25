import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";
import {
  stripeCheckoutCreditDecision,
  stripeCheckoutSessionCreateParams,
} from "../src/routes/billing";
import {
  checkoutSessionEvent,
  foreignPaymentCheckoutSession,
  foreignSubscriptionCheckoutSession,
  openGeniCheckoutMetadata,
  openGeniCheckoutSession,
  type CheckoutSessionFixture,
} from "./fixtures/stripe-checkout-events";

const accountId = "7d6c2b1e-4a5f-4e3d-9c8b-1a2b3c4d5e6f";

function decide(session: CheckoutSessionFixture) {
  return stripeCheckoutCreditDecision(session as unknown as Stripe.Checkout.Session);
}

/** Metadata exactly as the checkout route stamps it on the Stripe session. */
function createdCheckoutMetadata(): Record<string, string> {
  const params = stripeCheckoutSessionCreateParams({
    accountId,
    customerId: "cus_TkQ3bVn8wXyZ12",
    amountCents: 2500,
    amountMicros: 25_000_000,
    publicBaseUrl: "https://app.opengeni.ai",
    idempotencyKey: `checkout:${accountId}:25000000:1f0e2d3c-4b5a-4968-8776-a5b4c3d2e1f0`,
  });
  return params.metadata as Record<string, string>;
}

describe("Stripe checkout credit decision", () => {
  test("grants credits for a paid OpenGeni checkout created by the checkout route", () => {
    const metadata = createdCheckoutMetadata();
    const event = checkoutSessionEvent(
      "checkout.session.completed",
      openGeniCheckoutSession({ metadata, paymentStatus: "paid" }),
    );

    expect(decide(event.data.object as CheckoutSessionFixture)).toEqual({
      action: "grant",
      credit: {
        accountId,
        amountMicros: 25_000_000,
        amountUsd: "25.00",
        idempotencyKey: metadata.opengeni_credit_idempotency_key!,
      },
    });
  });

  test("acknowledges checkouts created by other products on the same Stripe account", () => {
    expect(decide(foreignPaymentCheckoutSession())).toEqual({
      action: "ignore",
      reason: "foreign_checkout",
    });
    expect(decide(foreignSubscriptionCheckoutSession())).toEqual({
      action: "ignore",
      reason: "foreign_checkout",
    });
    expect(decide({ ...foreignPaymentCheckoutSession(), metadata: null } as never)).toEqual({
      action: "ignore",
      reason: "foreign_checkout",
    });
  });

  test("grants a delayed payment only when Stripe reports it paid", () => {
    const metadata = openGeniCheckoutMetadata({ accountId });
    const sessionId = "cs_test_a1delayedbankdebit";
    const completed = openGeniCheckoutSession({
      metadata,
      paymentStatus: "unpaid",
      delayed: true,
      sessionId,
    });
    const succeeded = openGeniCheckoutSession({
      metadata,
      paymentStatus: "paid",
      delayed: true,
      sessionId,
    });
    const failed = openGeniCheckoutSession({
      metadata,
      paymentStatus: "unpaid",
      delayed: true,
      sessionId,
    });

    expect(decide(completed)).toEqual({ action: "ignore", reason: "payment_not_paid" });
    const granted = decide(succeeded);
    expect(granted.action).toBe("grant");
    expect(granted.action === "grant" && granted.credit.idempotencyKey).toBe(
      metadata.opengeni_credit_idempotency_key!,
    );
    expect(decide(failed)).toEqual({ action: "ignore", reason: "payment_not_paid" });
  });

  test("keeps malformed OpenGeni checkout metadata a visible failure", () => {
    const metadata = openGeniCheckoutMetadata({ accountId });
    delete metadata.opengeni_credit_micros;

    expect(() => decide(openGeniCheckoutSession({ metadata, paymentStatus: "paid" }))).toThrow(
      "is missing OpenGeni credit metadata",
    );
  });
});

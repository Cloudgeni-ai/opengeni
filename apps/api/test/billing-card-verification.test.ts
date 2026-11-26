import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";
import type { ApiRouteDeps } from "@opengeni/core";
import { SandboxOrganizationBoxLimitError } from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { ApiHttpError, apiErrorRetryAfterSeconds } from "../src/http/api-error";
import {
  CardVerificationRejectedError,
  completeCardVerificationSession,
  handleCardVerificationWebhookSession,
} from "../src/routes/billing-card-verification";
import {
  sandboxComputeRefusal,
  sandboxComputeRetryAfterSeconds,
} from "../src/sandbox/compute-bounds";

const accountId = "6f0b3f0e-2b9a-4c1e-9d3f-1a2b3c4d5e6f";

function deps(): ApiRouteDeps {
  return {
    settings: testSettings({ billingMode: "stripe", stripeSecretKey: "sk_test_x" }),
  } as ApiRouteDeps;
}

function session(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_test_1",
    mode: "setup",
    status: "complete",
    livemode: false,
    customer: "cus_1",
    setup_intent: "seti_1",
    metadata: {
      opengeni_card_verification: "1",
      opengeni_account_id: accountId,
      opengeni_setup_subject: "user:owner",
    },
    ...overrides,
  } as Stripe.Checkout.Session;
}

function stripe(setup: Partial<Stripe.SetupIntent>, method: Partial<Stripe.PaymentMethod>) {
  return {
    setupIntents: {
      retrieve: async () => ({
        id: "seti_1",
        created: 1_763_000_000,
        status: "succeeded",
        livemode: false,
        customer: "cus_1",
        payment_method: "pm_1",
        metadata: { opengeni_account_id: accountId },
        ...setup,
      }),
    },
    paymentMethods: {
      retrieve: async () => ({
        id: "pm_1",
        type: "card",
        livemode: false,
        card: {
          fingerprint: "fp_1",
          brand: "visa",
          last4: "4242",
          funding: "credit",
          checks: { cvc_check: "pass" },
        },
        ...method,
      }),
    },
  } as unknown as Stripe;
}

describe("card verification", () => {
  test("a missing card is a 403 naming sandbox_card_required", () => {
    const refusal = sandboxComputeRefusal(
      new SandboxOrganizationBoxLimitError("w", "g", 0, "card_required"),
    );
    expect(refusal).toBeInstanceOf(ApiHttpError);
    expect(refusal!.status).toBe(403);
    expect((refusal as ApiHttpError).details).toEqual({ code: "sandbox_card_required" });
    expect(refusal!.message).toContain("Add a card");
    expect(
      sandboxComputeRefusal(new SandboxOrganizationBoxLimitError("w", "g", 0, "closed"))!.status,
    ).toBe(403);
  });

  test("a running-box or daily limit is a retryable 429 that says when to retry", () => {
    const running = sandboxComputeRefusal(
      new SandboxOrganizationBoxLimitError("w", "g", 1, "running"),
    );
    expect(running).toBeInstanceOf(ApiHttpError);
    expect(running!.status).toBe(429);
    expect((running as ApiHttpError).retryable).toBe(true);
    expect((running as ApiHttpError).details).toEqual({
      code: "sandbox_compute_unavailable",
      retryAfterSeconds: 60,
    });
    expect(apiErrorRetryAfterSeconds(running)).toBe(60);
    expect(running!.message).toContain("already runs 1 sandboxes");
    // A daily allowance resets at midnight UTC: retry no sooner than that.
    expect(sandboxComputeRetryAfterSeconds("daily_budget", new Date("2026-11-26T23:00:00Z"))).toBe(
      3600,
    );
    expect(
      sandboxComputeRetryAfterSeconds("fleet_daily_budget", new Date("2026-11-26T23:59:30Z")),
    ).toBe(60);
    expect(sandboxComputeRetryAfterSeconds("fleet_busy")).toBe(60);
    expect(apiErrorRetryAfterSeconds(new Error("plain"))).toBeNull();
  });

  test("other checkout sessions are left to the other handlers", async () => {
    expect(
      await completeCardVerificationSession(deps(), stripe({}, {}), session({ metadata: {} })),
    ).toBe(false);
  });

  test("a session Stripe does not confirm is never recorded", async () => {
    const cases: Array<
      [Partial<Stripe.Checkout.Session>, Partial<Stripe.SetupIntent>, Partial<Stripe.PaymentMethod>]
    > = [
      [{ mode: "payment" }, {}, {}],
      [{ status: "open" }, {}, {}],
      [{ livemode: true }, {}, {}],
      [{}, { status: "requires_payment_method" }, {}],
      [{}, { customer: "cus_other" }, {}],
      [{}, { metadata: { opengeni_account_id: "another" } }, {}],
      [{}, {}, { type: "us_bank_account" } as Partial<Stripe.PaymentMethod>],
      [{}, {}, { card: undefined }],
      // One Free trial per card: no prepaid cards, no failed security code.
      [
        {},
        {},
        {
          card: { fingerprint: "fp_1", brand: "visa", last4: "4242", funding: "prepaid" },
        } as Partial<Stripe.PaymentMethod>,
      ],
      [
        {},
        {},
        {
          card: {
            fingerprint: "fp_1",
            brand: "visa",
            last4: "4242",
            funding: "debit",
            checks: { cvc_check: "fail" },
          },
        } as Partial<Stripe.PaymentMethod>,
      ],
    ];
    for (const [sessionOverrides, setup, method] of cases) {
      await expect(
        completeCardVerificationSession(deps(), stripe(setup, method), session(sessionOverrides)),
      ).rejects.toBeInstanceOf(CardVerificationRejectedError);
    }
    // A session for another organization than the one confirming it.
    await expect(
      completeCardVerificationSession(
        deps(),
        stripe({}, {}),
        session(),
        "00000000-0000-4000-8000-000000000000",
      ),
    ).rejects.toThrow("Invalid card verification session");
  });

  test("the webhook acknowledges a rejected card and lets Stripe retry other failures", async () => {
    const prepaid = stripe({}, {
      card: { fingerprint: "fp_1", brand: "visa", last4: "4242", funding: "prepaid" },
    } as Partial<Stripe.PaymentMethod>);
    expect(await handleCardVerificationWebhookSession(deps(), prepaid, session())).toBe(true);
    const down = {
      setupIntents: {
        retrieve: async () => {
          throw new Error("Stripe is unavailable");
        },
      },
    } as unknown as Stripe;
    await expect(handleCardVerificationWebhookSession(deps(), down, session())).rejects.toThrow(
      "Stripe is unavailable",
    );
    expect(
      await handleCardVerificationWebhookSession(deps(), prepaid, session({ metadata: {} })),
    ).toBe(false);
  });
});

// Realistic Stripe Checkout Session webhook payloads, shaped like the events
// Stripe delivers (API version 2025-08-27.basil). Shared by the route unit
// tests and the Postgres-backed webhook integration tests.

export type StripeCheckoutEventType =
  | "checkout.session.completed"
  | "checkout.session.async_payment_succeeded"
  | "checkout.session.async_payment_failed";

export type CheckoutSessionFixture = Record<string, unknown> & {
  id: string;
  metadata: Record<string, string>;
};

/** The metadata OpenGeni stamps on every credit Checkout Session it creates. */
export function openGeniCheckoutMetadata(input: {
  accountId: string;
  amountCents?: number;
  idempotencyKey?: string;
}): Record<string, string> {
  const amountCents = input.amountCents ?? 2500;
  return {
    opengeni_account_id: input.accountId,
    opengeni_credit_amount_usd: (amountCents / 100).toFixed(2),
    opengeni_credit_micros: String(amountCents * 10_000),
    opengeni_credit_idempotency_key:
      input.idempotencyKey ??
      `checkout:${input.accountId}:${amountCents * 10_000}:${crypto.randomUUID()}`,
  };
}

/**
 * A Checkout Session OpenGeni created for a credit top-up. `delayed` models a
 * delayed-notification payment method (US bank account): Stripe completes the
 * session `unpaid` and reports the outcome later through the async events.
 */
export function openGeniCheckoutSession(input: {
  metadata: Record<string, string>;
  paymentStatus: "paid" | "unpaid";
  delayed?: boolean;
  sessionId?: string;
}): CheckoutSessionFixture {
  const amountCents = Number(input.metadata.opengeni_credit_micros) / 10_000;
  const paymentMethodTypes = input.delayed ? ["card", "us_bank_account"] : ["card", "link"];
  return {
    ...baseCheckoutSession({
      sessionId: input.sessionId,
      amountCents,
      paymentStatus: input.paymentStatus,
      paymentMethodTypes,
    }),
    customer: "cus_TkQ3bVn8wXyZ12",
    customer_creation: null,
    customer_email: null,
    invoice: input.paymentStatus === "paid" ? "in_1SxYz2Lk9Ab3Cd4EfGhIjKl" : null,
    invoice_creation: {
      enabled: true,
      invoice_data: {
        account_tax_ids: null,
        custom_fields: null,
        description: null,
        footer: null,
        issuer: null,
        metadata: input.metadata,
        rendering_options: null,
      },
    },
    metadata: input.metadata,
    success_url: "https://app.opengeni.ai/billing?checkout=success",
    cancel_url: "https://app.opengeni.ai/billing?checkout=cancelled",
  };
}

/**
 * A paid one-off Checkout Session created by a different product that shares
 * the Stripe account. It carries only that product's own metadata.
 */
export function foreignPaymentCheckoutSession(): CheckoutSessionFixture {
  return {
    ...baseCheckoutSession({
      amountCents: 4900,
      paymentStatus: "paid",
      paymentMethodTypes: ["card"],
    }),
    customer: null,
    customer_creation: "if_required",
    customer_email: "buyer@example.com",
    invoice: null,
    invoice_creation: {
      enabled: false,
      invoice_data: {
        account_tax_ids: null,
        custom_fields: null,
        description: null,
        footer: null,
        issuer: null,
        metadata: {},
        rendering_options: null,
      },
    },
    metadata: { order_reference: "ord_1042", storefront: "workshop-tickets" },
    success_url: "https://shop.example.com/thanks",
    cancel_url: "https://shop.example.com/cart",
  };
}

/** A subscription Checkout Session created by a different product. */
export function foreignSubscriptionCheckoutSession(): CheckoutSessionFixture {
  return {
    ...baseCheckoutSession({
      amountCents: 1900,
      paymentStatus: "paid",
      paymentMethodTypes: ["card"],
    }),
    mode: "subscription",
    payment_intent: null,
    subscription: "sub_1SxYz2Lk9Ab3Cd4EfGhIjKl",
    customer: "cus_Rq8mNb2VcX4wZ9",
    customer_creation: "always",
    customer_email: "subscriber@example.com",
    invoice: "in_1SxYz2Lk9Ab3Cd4EfGhIjKm",
    invoice_creation: null,
    metadata: { plan: "team-monthly" },
    success_url: "https://other-product.example.com/welcome",
    cancel_url: "https://other-product.example.com/pricing",
  };
}

export function checkoutSessionEvent(
  type: StripeCheckoutEventType,
  session: CheckoutSessionFixture,
  eventId = `evt_1Sx${crypto.randomUUID().replaceAll("-", "").slice(0, 21)}`,
): Record<string, unknown> & { id: string; type: StripeCheckoutEventType } {
  return {
    id: eventId,
    object: "event",
    api_version: "2025-08-27.basil",
    created: Math.floor(Date.now() / 1000),
    data: { object: session },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  };
}

function baseCheckoutSession(input: {
  sessionId?: string | undefined;
  amountCents: number;
  paymentStatus: "paid" | "unpaid";
  paymentMethodTypes: string[];
}): Record<string, unknown> & { id: string } {
  const created = Math.floor(Date.now() / 1000) - 120;
  return {
    id: input.sessionId ?? `cs_test_a1${crypto.randomUUID().replaceAll("-", "")}`,
    object: "checkout.session",
    adaptive_pricing: { enabled: true },
    after_expiration: null,
    allow_promotion_codes: null,
    amount_subtotal: input.amountCents,
    amount_total: input.amountCents,
    automatic_tax: {
      enabled: true,
      liability: { type: "self" },
      provider: "stripe",
      status: "complete",
    },
    billing_address_collection: "auto",
    client_reference_id: null,
    client_secret: null,
    collected_information: { shipping_details: null },
    consent: null,
    consent_collection: null,
    created,
    currency: "usd",
    currency_conversion: null,
    custom_fields: [],
    custom_text: {
      after_submit: null,
      shipping_address: null,
      submit: null,
      terms_of_service_acceptance: null,
    },
    customer_details: {
      address: {
        city: null,
        country: "US",
        line1: null,
        line2: null,
        postal_code: "94107",
        state: null,
      },
      email: "billing@example.com",
      name: "Example Buyer",
      phone: null,
      tax_exempt: "none",
      tax_ids: [],
    },
    discounts: [],
    expires_at: created + 86_400,
    livemode: false,
    locale: null,
    mode: "payment",
    origin_context: null,
    payment_intent: `pi_3Sx${crypto.randomUUID().replaceAll("-", "").slice(0, 21)}`,
    payment_link: null,
    payment_method_collection: "if_required",
    payment_method_configuration_details: {
      id: "pmc_1Rq8mNb2VcX4wZ9aBcDeFgHi",
      parent: null,
    },
    payment_method_options: { card: { request_three_d_secure: "automatic" } },
    payment_method_types: input.paymentMethodTypes,
    payment_status: input.paymentStatus,
    permissions: null,
    phone_number_collection: { enabled: false },
    recovered_from: null,
    saved_payment_method_options: null,
    setup_intent: null,
    shipping_address_collection: null,
    shipping_cost: null,
    shipping_options: [],
    status: "complete",
    submit_type: null,
    subscription: null,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    ui_mode: "hosted",
    url: null,
    wallet_options: null,
  };
}

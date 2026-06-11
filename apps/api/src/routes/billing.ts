import {
  CreateCheckoutRequest,
  CreateCheckoutResponse,
  type AccessContext,
  type Permission,
} from "@opengeni/contracts";
import { configuredEntitlements } from "@opengeni/config";
import {
  applyCreditLedgerEntry,
  getBillingBalance,
  getBillingCustomer,
  hasCreditLedgerEntry,
  isStripeWebhookProcessed,
  listUsageEvents,
  getManagedAccount,
  markStripeWebhookProcessed,
  recordStripeWebhookEvent,
  upsertBillingCustomer,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";
import { requireAccessContext } from "../access";
import type { ApiRouteDeps } from "../dependencies";

export function registerBillingRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/billing", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = requireSelectedAccount(context, c.req.query("accountId"), "billing:read");
    return c.json({ mode: deps.settings.billingMode, balance: await getBillingBalance(deps.db, accountId) });
  });

  app.get("/v1/billing/usage", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = requireSelectedAccount(context, c.req.query("accountId"), "billing:read");
    const workspaceId = c.req.query("workspaceId");
    if (workspaceId && !context.workspaceGrants.some((grant) => grant.accountId === accountId && grant.workspaceId === workspaceId)) {
      throw new HTTPException(403, { message: "missing workspace access for usage query" });
    }
    return c.json({
      balance: await getBillingBalance(deps.db, accountId),
      usage: await listUsageEvents(deps.db, {
        accountId,
        ...(workspaceId ? { workspaceId } : {}),
        limit: 100,
      }),
    });
  });

  app.get("/v1/billing/entitlements", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = requireSelectedAccount(context, c.req.query("accountId"), "billing:read");
    return c.json({ accountId, mode: deps.settings.entitlementsMode, entitlements: configuredEntitlements(deps.settings) });
  });

  app.post("/v1/billing/checkout", async (c) => {
    if (deps.settings.billingMode !== "stripe") {
      throw new HTTPException(404, { message: "stripe billing is not enabled" });
    }
    const context = await requireAccessContext(c, deps);
    const body = CreateCheckoutRequest.parse(await c.req.json());
    const accountId = requireSelectedAccount(context, body.accountId, "billing:manage");
    const amountCents = usdToCents(body.amountUsd);
    const amountMicros = centsToMicros(amountCents);
    const stripe = stripeClient(deps);
    const customerId = await getOrCreateStripeCustomer(deps, stripe, context, accountId);
    const idempotencyKey = `checkout:${accountId}:${amountMicros}:${crypto.randomUUID()}`;
    const session = await stripe.checkout.sessions.create(stripeCheckoutSessionCreateParams({
      accountId,
      customerId,
      amountCents,
      amountMicros,
      creditsProductId: deps.settings.stripeCreditsProductId,
      publicBaseUrl: deps.settings.publicBaseUrl,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      idempotencyKey,
    }), { idempotencyKey });
    if (!session.url) {
      throw new HTTPException(502, { message: "Stripe did not return a checkout URL" });
    }
    return c.json(CreateCheckoutResponse.parse({
      checkoutSessionId: session.id,
      url: session.url,
    }));
  });

  app.post("/v1/webhooks/stripe", async (c) => {
    if (deps.settings.billingMode !== "stripe") {
      throw new HTTPException(404, { message: "stripe billing is not enabled" });
    }
    const signature = c.req.header("stripe-signature");
    if (!signature) {
      throw new HTTPException(400, { message: "missing stripe-signature" });
    }
    const payload = await c.req.text();
    let event: Stripe.Event;
    try {
      event = await stripeClient(deps).webhooks.constructEventAsync(payload, signature, deps.settings.stripeWebhookSecret!);
    } catch (error) {
      throw new HTTPException(400, { message: error instanceof Error ? error.message : "invalid stripe signature" });
    }
    const firstSeen = await recordStripeWebhookEvent(deps.db, {
      id: event.id,
      type: event.type,
      livemode: event.livemode,
      payload: event,
    });
    if (!firstSeen) {
      if (await isStripeWebhookProcessed(deps.db, event.id)) {
        return c.json({ received: true, duplicate: true });
      }
    }
    try {
      await handleStripeWebhookEvent(deps, stripeClient(deps), event);
      await markStripeWebhookProcessed(deps.db, event.id);
      return c.json({ received: true });
    } catch (error) {
      throw new HTTPException(500, { message: error instanceof Error ? error.message : String(error) });
    }
  });
}

export function stripeCheckoutSessionCreateParams(input: {
  accountId: string;
  customerId: string;
  amountCents: number;
  amountMicros: number;
  creditsProductId?: string | undefined;
  publicBaseUrl?: string | undefined;
  successUrl?: string | undefined;
  cancelUrl?: string | undefined;
  idempotencyKey: string;
}): Stripe.Checkout.SessionCreateParams {
  const successUrl = checkoutReturnUrl(input.publicBaseUrl, input.successUrl, "/billing?checkout=success", "successUrl");
  const cancelUrl = checkoutReturnUrl(input.publicBaseUrl, input.cancelUrl, "/billing?checkout=cancelled", "cancelUrl");
  return {
    mode: "payment",
    customer: input.customerId,
    customer_update: {
      address: "auto",
      name: "auto",
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
    automatic_tax: { enabled: true },
    billing_address_collection: "auto",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: input.amountCents,
        ...(input.creditsProductId
          ? { product: input.creditsProductId }
          : {
            product_data: {
              name: "OpenGeni credits",
              metadata: {
                app: "opengeni",
                billing_model: "prepaid_credits",
              },
            },
          }),
      },
    }],
    metadata: {
      opengeni_account_id: input.accountId,
      opengeni_credit_amount_usd: (input.amountCents / 100).toFixed(2),
      opengeni_credit_micros: String(input.amountMicros),
      opengeni_credit_idempotency_key: input.idempotencyKey,
    },
    payment_intent_data: {
      metadata: {
        opengeni_account_id: input.accountId,
        opengeni_credit_amount_usd: (input.amountCents / 100).toFixed(2),
        opengeni_credit_micros: String(input.amountMicros),
        opengeni_credit_idempotency_key: input.idempotencyKey,
      },
    },
  };
}

function checkoutReturnUrl(publicBaseUrl: string | undefined, candidate: string | undefined, fallbackPath: string, field: string): string {
  if (!publicBaseUrl) {
    throw new HTTPException(500, { message: "OPENGENI_PUBLIC_BASE_URL is required for Stripe checkout" });
  }
  const base = new URL(publicBaseUrl);
  const fallback = new URL(fallbackPath, base).toString();
  if (!candidate) {
    return fallback;
  }
  const parsed = new URL(candidate);
  if (parsed.origin !== base.origin) {
    throw new HTTPException(400, { message: `${field} must use the OpenGeni public origin` });
  }
  return parsed.toString();
}

async function handleStripeWebhookEvent(deps: ApiRouteDeps, stripe: Stripe, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutSessionCompleted(deps, event);
      return;
    case "checkout.session.expired":
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled":
      await mirrorPaymentIntentCustomer(deps, event);
      return;
    case "charge.refunded":
      await handleChargeRefunded(deps, stripe, event);
      return;
    case "refund.created":
    case "refund.updated":
      await handleRefundEvent(deps, stripe, event);
      return;
    case "refund.failed":
      return;
    case "charge.dispute.created":
    case "charge.dispute.funds_withdrawn":
      await holdDisputedCredits(deps, stripe, event);
      return;
    case "charge.dispute.closed":
    case "charge.dispute.funds_reinstated":
      await releaseDisputedCredits(deps, stripe, event);
      return;
    case "charge.dispute.updated":
      return;
    case "customer.created":
    case "customer.updated":
      await mirrorCustomer(deps, event.data.object as Stripe.Customer);
      return;
    default:
      return;
  }
}

async function handleCheckoutSessionCompleted(deps: ApiRouteDeps, event: Stripe.Event): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.mode !== "payment" || session.payment_status !== "paid") {
    return;
  }
  const credit = creditMetadata(session.metadata, `Stripe checkout session ${session.id}`);
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (customerId) {
    await upsertBillingCustomer(deps.db, {
      accountId: credit.accountId,
      providerCustomerId: customerId,
      email: session.customer_details?.email ?? session.customer_email ?? null,
    });
  }
  await applyCreditLedgerEntry(deps.db, {
    accountId: credit.accountId,
    type: "credit_topup",
    amountMicros: credit.amountMicros,
    sourceType: "stripe_checkout_session",
    sourceId: session.id,
    idempotencyKey: credit.idempotencyKey,
    metadata: {
      stripeEventId: event.id,
      stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null,
      stripePackageId: credit.packageId,
      stripeCreditAmountUsd: credit.amountUsd,
    },
  });
}

async function mirrorPaymentIntentCustomer(deps: ApiRouteDeps, event: Stripe.Event): Promise<void> {
  const intent = event.data.object as Stripe.PaymentIntent;
  const accountId = intent.metadata?.opengeni_account_id;
  const customerId = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
  if (accountId && customerId) {
    await upsertBillingCustomer(deps.db, { accountId, providerCustomerId: customerId, email: null });
  }
}

async function handleChargeRefunded(deps: ApiRouteDeps, stripe: Stripe, event: Stripe.Event): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  for (const refund of charge.refunds?.data ?? []) {
    await applyRefundDebit(deps, stripe, refund);
  }
}

async function handleRefundEvent(deps: ApiRouteDeps, stripe: Stripe, event: Stripe.Event): Promise<void> {
  await applyRefundDebit(deps, stripe, event.data.object as Stripe.Refund);
}

async function applyRefundDebit(deps: ApiRouteDeps, stripe: Stripe, refund: Stripe.Refund): Promise<void> {
  if (refund.status && refund.status !== "succeeded") {
    return;
  }
  const metadata = await metadataForRefund(stripe, refund);
  const accountId = metadata?.opengeni_account_id;
  if (!accountId) {
    return;
  }
  await applyCreditLedgerEntry(deps.db, {
    accountId,
    type: "credit_refund",
    amountMicros: -centsToMicros(refund.amount),
    sourceType: "stripe_refund",
    sourceId: refund.id,
    idempotencyKey: `stripe:refund:${refund.id}`,
    metadata: {
      stripeRefundId: refund.id,
      stripePaymentIntentId: paymentIntentId(refund.payment_intent),
    },
  });
}

async function holdDisputedCredits(deps: ApiRouteDeps, stripe: Stripe, event: Stripe.Event): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  const metadata = await metadataForDispute(stripe, dispute);
  const accountId = metadata?.opengeni_account_id;
  if (!accountId) {
    return;
  }
  await applyCreditLedgerEntry(deps.db, {
    accountId,
    type: "credit_dispute_hold",
    amountMicros: -centsToMicros(dispute.amount),
    sourceType: "stripe_dispute",
    sourceId: dispute.id,
    idempotencyKey: `stripe:dispute_hold:${dispute.id}`,
    metadata: { stripeDisputeId: dispute.id, stripeEventType: event.type },
  });
}

async function releaseDisputedCredits(deps: ApiRouteDeps, stripe: Stripe, event: Stripe.Event): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  if (event.type === "charge.dispute.closed" && dispute.status !== "won") {
    return;
  }
  const metadata = await metadataForDispute(stripe, dispute);
  const accountId = metadata?.opengeni_account_id;
  if (!accountId) {
    return;
  }
  const holdIdempotencyKey = `stripe:dispute_hold:${dispute.id}`;
  if (!await hasCreditLedgerEntry(deps.db, accountId, holdIdempotencyKey)) {
    return;
  }
  await applyCreditLedgerEntry(deps.db, {
    accountId,
    type: "credit_dispute_release",
    amountMicros: centsToMicros(dispute.amount),
    sourceType: "stripe_dispute",
    sourceId: dispute.id,
    idempotencyKey: `stripe:dispute_release:${dispute.id}`,
    metadata: { stripeDisputeId: dispute.id, stripeEventType: event.type },
  });
}

async function mirrorCustomer(deps: ApiRouteDeps, customer: Stripe.Customer): Promise<void> {
  const accountId = customer.metadata?.opengeni_account_id;
  if (!accountId || customer.deleted) {
    return;
  }
  await upsertBillingCustomer(deps.db, {
    accountId,
    providerCustomerId: customer.id,
    email: typeof customer.email === "string" ? customer.email : null,
  });
}

async function metadataForRefund(stripe: Stripe, refund: Stripe.Refund): Promise<Stripe.Metadata | null> {
  if (Object.keys(refund.metadata ?? {}).length > 0) {
    return refund.metadata;
  }
  const paymentIntent = paymentIntentId(refund.payment_intent);
  return paymentIntent ? (await stripe.paymentIntents.retrieve(paymentIntent)).metadata : null;
}

async function metadataForDispute(stripe: Stripe, dispute: Stripe.Dispute): Promise<Stripe.Metadata | null> {
  if (Object.keys(dispute.metadata ?? {}).length > 0) {
    return dispute.metadata;
  }
  const paymentIntent = paymentIntentId((dispute as unknown as { payment_intent?: string | Stripe.PaymentIntent | null }).payment_intent);
  if (paymentIntent) {
    return (await stripe.paymentIntents.retrieve(paymentIntent)).metadata;
  }
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  if (!chargeId) {
    return null;
  }
  const charge = await stripe.charges.retrieve(chargeId);
  const chargePaymentIntent = paymentIntentId(charge.payment_intent);
  return chargePaymentIntent ? (await stripe.paymentIntents.retrieve(chargePaymentIntent)).metadata : charge.metadata;
}

function creditMetadata(metadata: Stripe.Metadata | null | undefined, label: string): {
  accountId: string;
  amountMicros: number;
  idempotencyKey: string;
  amountUsd?: string;
  packageId?: string;
} {
  const accountId = metadata?.opengeni_account_id;
  const amountMicros = Number(metadata?.opengeni_credit_micros);
  const idempotencyKey = metadata?.opengeni_credit_idempotency_key;
  if (!accountId || !Number.isSafeInteger(amountMicros) || amountMicros <= 0 || !idempotencyKey) {
    throw new Error(`${label} is missing OpenGeni credit metadata`);
  }
  return {
    accountId,
    amountMicros,
    idempotencyKey,
    ...(metadata?.opengeni_credit_amount_usd ? { amountUsd: metadata.opengeni_credit_amount_usd } : {}),
    ...(metadata?.opengeni_package_id ? { packageId: metadata.opengeni_package_id } : {}),
  };
}

async function getOrCreateStripeCustomer(deps: ApiRouteDeps, stripe: Stripe, context: AccessContext, accountId: string): Promise<string> {
  const existing = await getBillingCustomer(deps.db, accountId);
  if (existing) {
    return existing.providerCustomerId;
  }
  const account = await getManagedAccount(deps.db, accountId);
  if (!account) {
    throw new HTTPException(404, { message: "account not found" });
  }
  const customer = await stripe.customers.create({
    name: account.name,
    ...(looksLikeEmail(context.subjectLabel) ? { email: context.subjectLabel } : {}),
    metadata: {
      opengeni_account_id: accountId,
    },
  });
  await upsertBillingCustomer(deps.db, {
    accountId,
    providerCustomerId: customer.id,
    email: customer.email,
  });
  return customer.id;
}

function requireSelectedAccount(context: AccessContext, requested: string | undefined, permission: Permission): string {
  const accountId = requested ?? context.defaultAccountId ?? undefined;
  if (!accountId) {
    throw new HTTPException(409, { message: "account selection is required" });
  }
  const grant = context.accountGrants.find((candidate) => candidate.accountId === accountId);
  if (!grant || (!grant.permissions.includes(permission) && !grant.permissions.includes("account:admin"))) {
    throw new HTTPException(403, { message: `missing permission: ${permission}` });
  }
  return accountId;
}

function stripeClient(deps: ApiRouteDeps): Stripe {
  if (!deps.settings.stripeSecretKey) {
    throw new HTTPException(500, { message: "Stripe secret key is not configured" });
  }
  return new Stripe(deps.settings.stripeSecretKey);
}

function centsToMicros(cents: number): number {
  return cents * 10_000;
}

function usdToCents(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}

function paymentIntentId(value: string | Stripe.PaymentIntent | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return typeof value === "string" ? value : value.id;
}

function looksLikeEmail(value: string | undefined): value is string {
  return Boolean(value && value.includes("@"));
}

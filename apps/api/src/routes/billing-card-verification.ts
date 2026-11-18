import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type Stripe from "stripe";
import {
  BillingCardVerificationStatus,
  ConfirmBillingCardVerificationRequest,
  CreateBillingCardVerificationSessionRequest,
  CreateBillingCardVerificationSessionResponse,
} from "@opengeni/contracts";
import { sandboxPlanLimits } from "@opengeni/config";
import { requireAccessContext, type ApiRouteDeps } from "@opengeni/core";
import {
  listSelfOrganizationMemberships,
  readCardVerification,
  recordCardVerification,
  resolveSandboxComputeStanding,
} from "@opengeni/db";
import { parseRequestBody } from "../http/request-body";
import { managedCookieHuman } from "./codex";
import {
  billingReturnOrigins,
  checkoutReturnUrl,
  getOrCreateStripeCustomer,
  requireSelectedAccount,
  stripeClient,
  stripeCustomerProvider,
} from "./billing";

/**
 * Card verification (docs/signup-abuse-protection.md, "Card verification"):
 * the organization's owner saves a card through a Stripe Checkout session in
 * setup mode (a SetupIntent, no charge). The card is recorded from the
 * completed session, by the webhook or by the page the checkout returns to,
 * whichever comes first; both verify it with Stripe.
 */
const CARD_VERIFICATION_METADATA = "opengeni_card_verification";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * A card verification Stripe completed but this deployment does not accept
 * (a prepaid card, a failed CVC check, a session that does not match, an
 * owner who left). Retrying never changes the answer, so the webhook logs it
 * and acknowledges the event.
 */
export class CardVerificationRejectedError extends Error {
  override readonly name = "CardVerificationRejectedError";
}

function enabled(deps: ApiRouteDeps): void {
  if (deps.settings.billingMode !== "stripe") {
    throw new HTTPException(404, {
      message: "Card verification is not enabled on this deployment.",
    });
  }
}

function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

async function ownsOrganization(
  deps: ApiRouteDeps,
  subjectId: string,
  accountId: string,
): Promise<boolean> {
  const memberships = await listSelfOrganizationMemberships(deps.db, subjectId);
  return memberships.some(
    (membership) =>
      membership.organizationId === accountId &&
      membership.role === "owner" &&
      membership.status === "active",
  );
}

async function requireOwner(c: Context, deps: ApiRouteDeps, accountId: string): Promise<string> {
  const human = await managedCookieHuman(c, deps);
  if (!human || !(await ownsOrganization(deps, human.subjectId, accountId))) {
    throw new HTTPException(403, {
      message: "Only the organization owner can add its card.",
    });
  }
  return human.subjectId;
}

/**
 * Records the card of a completed card verification checkout session.
 * Returns false for any other session. Throws when the session claims to be a
 * card verification but Stripe does not confirm it, or the card is not
 * accepted ({@link CardVerificationRejectedError}).
 */
export async function completeCardVerificationSession(
  deps: ApiRouteDeps,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  expectedAccountId?: string,
): Promise<boolean> {
  if (session.metadata?.[CARD_VERIFICATION_METADATA] !== "1") return false;
  const provider = stripeCustomerProvider(deps);
  const accountId = session.metadata.opengeni_account_id;
  const subjectId = session.metadata.opengeni_setup_subject;
  if (
    session.mode !== "setup" ||
    session.status !== "complete" ||
    session.livemode !== (provider === "stripe:live") ||
    !accountId ||
    !uuid.test(accountId) ||
    (expectedAccountId !== undefined && accountId !== expectedAccountId) ||
    !subjectId?.startsWith("user:") ||
    !stripeId(session.setup_intent) ||
    !stripeId(session.customer)
  ) {
    throw new CardVerificationRejectedError("Invalid card verification session");
  }
  const setup = await stripe.setupIntents.retrieve(stripeId(session.setup_intent)!);
  const methodId = stripeId(setup.payment_method);
  if (!methodId) throw new CardVerificationRejectedError("Card verification has no payment method");
  const method = await stripe.paymentMethods.retrieve(methodId);
  if (
    setup.status !== "succeeded" ||
    setup.livemode !== session.livemode ||
    stripeId(setup.customer) !== stripeId(session.customer) ||
    setup.metadata?.opengeni_account_id !== accountId ||
    method.type !== "card" ||
    !method.card?.fingerprint ||
    method.livemode !== session.livemode
  ) {
    throw new CardVerificationRejectedError(
      "Card verification does not match this organization's card",
    );
  }
  // One Free trial per card: prepaid and single-use virtual cards each have
  // their own fingerprint, and a card whose security code failed is not
  // the person's card.
  if (method.card.funding === "prepaid" || method.card.checks?.cvc_check === "fail") {
    throw new CardVerificationRejectedError("Card verification needs a credit or debit card");
  }
  // The person who verified must still own the organization.
  if (!(await ownsOrganization(deps, subjectId, accountId))) {
    throw new CardVerificationRejectedError(
      "Card verification subject no longer owns the organization",
    );
  }
  await recordCardVerification(deps.db, {
    accountId,
    subjectId,
    provider,
    customerId: stripeId(session.customer)!,
    paymentMethodId: method.id,
    setupIntentId: setup.id,
    setupIntentCreatedAt: new Date(setup.created * 1000),
    fingerprint: method.card.fingerprint,
    brand: method.card.brand,
    last4: method.card.last4,
  });
  return true;
}

/** The webhook's card verification step: a rejected card is logged and the
 * event acknowledged; Stripe and database failures still throw, so Stripe
 * retries them. */
export async function handleCardVerificationWebhookSession(
  deps: ApiRouteDeps,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<boolean> {
  try {
    return await completeCardVerificationSession(deps, stripe, session);
  } catch (error) {
    if (!(error instanceof CardVerificationRejectedError)) throw error;
    console.warn("card verification rejected", {
      checkoutSession: session.id.slice(0, 11),
      reason: error.message,
    });
    return true;
  }
}

async function cardVerificationStatus(
  deps: ApiRouteDeps,
  accountId: string,
  subjectId: string,
): Promise<BillingCardVerificationStatus> {
  const [card, standing, owner] = await Promise.all([
    readCardVerification(deps.db, accountId),
    resolveSandboxComputeStanding(deps.db, {
      accountId,
      limits: sandboxPlanLimits(deps.settings),
      actingSubjectId: subjectId,
      subscriptionPlansEnabled: deps.settings.subscriptionPlansEnabled,
    }),
    subjectId.startsWith("user:")
      ? ownsOrganization(deps, subjectId, accountId).catch(() => false)
      : Promise.resolve(false),
  ]);
  return BillingCardVerificationStatus.parse({
    accountId,
    required: standing.cardRequired,
    verified: card !== null,
    canVerify: owner,
    card: card ? { brand: card.brand, last4: card.last4 } : null,
  });
}

export function registerBillingCardVerificationRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/billing/card-verification", async (c) => {
    enabled(deps);
    const context = await requireAccessContext(c, deps);
    const accountId = requireSelectedAccount(context, c.req.query("accountId"), "billing:read");
    return c.json(await cardVerificationStatus(deps, accountId, context.subjectId));
  });

  app.post("/v1/billing/card-verification/setup", async (c) => {
    enabled(deps);
    const context = await requireAccessContext(c, deps);
    const request = parseRequestBody(
      CreateBillingCardVerificationSessionRequest,
      await c.req.json(),
      { status: 400, message: "Invalid card verification request." },
    );
    const accountId = requireSelectedAccount(context, request.accountId, "billing:manage");
    const subjectId = await requireOwner(c, deps, accountId);
    const origins = billingReturnOrigins(deps.settings);
    const successUrl = checkoutReturnUrl(
      deps.settings.publicBaseUrl,
      deps.settings.webBaseUrl,
      request.successUrl,
      "/billing",
      "successUrl",
      origins,
    );
    const cancelUrl = checkoutReturnUrl(
      deps.settings.publicBaseUrl,
      deps.settings.webBaseUrl,
      request.cancelUrl,
      "/billing",
      "cancelUrl",
      origins,
    );
    const stripe = stripeClient(deps);
    const customerId = await getOrCreateStripeCustomer(deps, stripe, context, accountId);
    const metadata = {
      opengeni_account_id: accountId,
      [CARD_VERIFICATION_METADATA]: "1",
      opengeni_setup_key: request.idempotencyKey,
      opengeni_setup_subject: subjectId,
    };
    const session = await stripe.checkout.sessions.create(
      {
        mode: "setup",
        customer: customerId,
        currency: "usd",
        payment_method_types: ["card"],
        // checkoutReturnUrl normalizes the URL, which encodes Stripe's
        // placeholder; restore it so Stripe fills in the session id.
        success_url: successUrl.replaceAll("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}"),
        cancel_url: cancelUrl,
        metadata,
        setup_intent_data: { metadata },
        custom_text: {
          submit: { message: "Verifies your card for the Free plan. You won't be charged." },
        },
      },
      { idempotencyKey: `card-verification:setup:${accountId}:${request.idempotencyKey}` },
    );
    if (!session.url) {
      throw new HTTPException(502, { message: "Stripe did not return a card setup URL." });
    }
    return c.json(CreateBillingCardVerificationSessionResponse.parse({ url: session.url }));
  });

  app.post("/v1/billing/card-verification/confirm", async (c) => {
    enabled(deps);
    const context = await requireAccessContext(c, deps);
    const request = parseRequestBody(ConfirmBillingCardVerificationRequest, await c.req.json(), {
      status: 400,
      message: "Invalid card verification confirmation.",
    });
    const accountId = requireSelectedAccount(context, request.accountId, "billing:read");
    const stripe = stripeClient(deps);
    const session = await stripe.checkout.sessions.retrieve(request.checkoutSessionId);
    if (session.metadata?.opengeni_account_id !== accountId) {
      throw new HTTPException(404, { message: "Card verification not found." });
    }
    if (session.status === "complete") {
      try {
        await completeCardVerificationSession(deps, stripe, session, accountId);
      } catch (error) {
        throw new HTTPException(409, {
          message: "The card couldn't be verified. Try another card.",
          cause: error,
        });
      }
    }
    return c.json(await cardVerificationStatus(deps, accountId, context.subjectId));
  });
}

import type { Hono, Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type Stripe from "stripe";
import {
  BillingAutoTopUpSettings,
  CreateBillingAutoTopUpSetupSessionRequest,
  CreateBillingAutoTopUpSetupSessionResponse,
  UpdateBillingAutoTopUpRequest,
} from "@opengeni/contracts";
import { requireAccessContext, type ApiRouteDeps } from "@opengeni/core";
import {
  AutoTopUpStoreError,
  billingAutoTopUpStore,
  type AutoTopUpNotificationPort,
} from "@opengeni/db";
import { StripeAutoTopUps } from "../billing-auto-top-up";
import { parseRequestBody } from "../http/request-body";
import { managedCookieHuman } from "./codex";
import {
  checkoutReturnUrl,
  getOrCreateStripeCustomer,
  requireSelectedAccount,
  stripeClient,
  stripeCustomerProvider,
} from "./billing";

export function createBillingAutoTopUpService(
  deps: ApiRouteDeps,
  stripe: Stripe = stripeClient(deps),
  notifications?: AutoTopUpNotificationPort,
): StripeAutoTopUps {
  return new StripeAutoTopUps(stripe, billingAutoTopUpStore(deps.db, notifications), {
    enabled: deps.settings.billingMode === "stripe" && deps.settings.billingAutoTopUpEnabled,
    provider: stripeCustomerProvider(deps),
    ...(deps.settings.stripeCreditsProductId
      ? { creditsProductId: deps.settings.stripeCreditsProductId }
      : {}),
  });
}

export async function requireAutoTopUpOwner(c: Context, deps: ApiRouteDeps): Promise<string> {
  const human = await managedCookieHuman(c, deps);
  if (!human)
    throw new HTTPException(403, {
      message: "Sign in as the organization owner to authorize automatic card charges.",
    });
  return human.subjectId;
}
function enabled(deps: ApiRouteDeps) {
  if (deps.settings.billingMode !== "stripe" || !deps.settings.billingAutoTopUpEnabled) {
    throw new HTTPException(404, {
      message: "Automatic top-ups are not enabled on this deployment.",
    });
  }
}
async function actionable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AutoTopUpStoreError)
      throw new HTTPException(error.status, { message: error.message });
    throw error;
  }
}
export function registerBillingAutoTopUpRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/billing/auto-top-up", async (c) => {
    enabled(deps);
    const context = await requireAccessContext(c, deps);
    const accountId = requireSelectedAccount(context, c.req.query("accountId"), "billing:read");
    return c.json(
      BillingAutoTopUpSettings.parse(await createBillingAutoTopUpService(deps).settings(accountId)),
    );
  });
  app.put("/v1/billing/auto-top-up", async (c) => {
    enabled(deps);
    const context = await requireAccessContext(c, deps);
    const subject = await requireAutoTopUpOwner(c, deps);
    const request = parseRequestBody(UpdateBillingAutoTopUpRequest, await c.req.json(), {
      status: 400,
      message: "Invalid automatic top-up settings.",
    });
    const accountId = requireSelectedAccount(context, request.accountId, "billing:manage");
    await actionable(() =>
      billingAutoTopUpStore(deps.db).locked(accountId, (account) =>
        account.update(subject, request),
      ),
    );
    return c.json(
      BillingAutoTopUpSettings.parse(await createBillingAutoTopUpService(deps).settings(accountId)),
    );
  });
  app.post("/v1/billing/auto-top-up/setup", async (c) => {
    enabled(deps);
    const context = await requireAccessContext(c, deps);
    const subject = await requireAutoTopUpOwner(c, deps);
    const request = parseRequestBody(
      CreateBillingAutoTopUpSetupSessionRequest,
      await c.req.json(),
      { status: 400, message: "Invalid card setup request." },
    );
    const accountId = requireSelectedAccount(context, request.accountId, "billing:manage");
    const successUrl = checkoutReturnUrl(
      deps.settings.publicBaseUrl,
      deps.settings.webBaseUrl,
      request.successUrl,
      "/billing?autoTopUp=setup",
      "successUrl",
    );
    const cancelUrl = checkoutReturnUrl(
      deps.settings.publicBaseUrl,
      deps.settings.webBaseUrl,
      request.cancelUrl,
      "/billing",
      "cancelUrl",
    );
    const stripe = stripeClient(deps);
    const store = billingAutoTopUpStore(deps.db);
    await actionable(() => store.locked(accountId, (account) => account.assertOwner(subject)));
    const customerId = await getOrCreateStripeCustomer(deps, stripe, context, accountId);
    await actionable(() =>
      store.locked(accountId, (account) =>
        account.startSetup(
          subject,
          request.idempotencyKey,
          stripeCustomerProvider(deps),
          customerId,
        ),
      ),
    );
    const metadata = {
      opengeni_account_id: accountId,
      opengeni_auto_top_up_setup: "1",
      opengeni_setup_key: request.idempotencyKey,
      opengeni_setup_subject: subject,
    };
    const session = await stripe.checkout.sessions.create(
      {
        mode: "setup",
        customer: customerId,
        currency: "usd",
        payment_method_types: ["card"],
        billing_address_collection: "required",
        customer_update: { address: "auto", name: "auto" },
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata,
        setup_intent_data: { metadata },
        custom_text: {
          submit: {
            message:
              "Save this card for recurring off-session Opengeni credit top-ups when enabled. Your selected amount plus tax is charged below your threshold, up to your UTC monthly cap. Saving a card does not enable top-ups.",
          },
        },
      },
      { idempotencyKey: `auto-top-up:setup:${accountId}:${request.idempotencyKey}` },
    );
    if (!session.url)
      throw new HTTPException(502, { message: "Stripe did not return a card setup URL." });
    return c.json(CreateBillingAutoTopUpSetupSessionResponse.parse({ url: session.url }));
  });
}

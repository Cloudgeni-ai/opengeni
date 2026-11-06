import {
  calculateModelUsageCostBreakdown,
  configuredModelPricingSchedules,
  configuredStaticUsageLimits,
  type Settings,
} from "@opengeni/config";
import {
  API_CREDITS_REQUIRED_MESSAGE,
  SUBSCRIPTION_PLAN_REQUIRED_MESSAGE,
  SUBSCRIPTION_API_UNAVAILABLE_MESSAGE,
  type BillingOrigin,
  type EntitlementsPort,
} from "@opengeni/contracts";
import {
  chargeBillingOrigin,
  checkWorkspaceAllowance,
  getByokFeeSpendableBalance,
  releaseModelCallCredits,
  reserveModelCallCredits,
  sumUsageQuantity,
  type Database,
} from "@opengeni/db";
import type { SingleModelCallRequest } from "@opengeni/runtime";
import {
  byokPaidCreditRefusalMessage,
  byokPlatformFeeActive,
  connectedSubscriptionsRefusedForOrigin,
  ownSubscriptionPlanAllows,
} from "./byok-platform-fee";

export type ModelCallAdmissionDenial =
  | "subscription_api_unavailable"
  | "insufficient_credits"
  | "allowance_exhausted"
  | "monthly_model_cost_limit"
  | "monthly_token_limit";

export type ModelCallAdmission =
  | { allowed: true; creditPolicyRevision: number | undefined }
  | {
      allowed: false;
      denial: ModelCallAdmissionDenial;
      message: string;
      /** API work found no credits: plan credit never pays for it. */
      apiCreditsRequired?: true;
      /** The person's own key needs paid credit for its platform fee. */
      byokPaidCreditRequired?: true;
      /** The person's own subscription needs a paid plan (Pro or higher). */
      subscriptionPlanRequired?: true;
    };

/**
 * Output tokens a credit-reserving call may produce when its request sets no
 * limit. The catalog records no output maximum per model, so without a limit
 * the call's maximum cost (and its hold) could not be sized; such a call is
 * sent with this limit instead of the provider's own default.
 */
export const MODEL_CALL_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * Input tokens counted for each image part when sizing a hold, above what
 * providers usually bill for one image.
 */
const MODEL_CALL_HOLD_IMAGE_INPUT_TOKENS = 8_192;
/** Role and framing tokens counted for each message when sizing a hold. */
const MODEL_CALL_HOLD_MESSAGE_INPUT_TOKENS = 16;

/**
 * Whether admission reserves a credit hold for the call: an Opengeni-credit
 * model on a credit-metered deployment whose balance this deployment keeps
 * (a host entitlements port admits on its own terms).
 */
export function modelCallReservesCredits(
  services: { settings: Settings; entitlements?: EntitlementsPort | null },
  chargesOpenGeniCredits: boolean,
): boolean {
  return (
    chargesOpenGeniCredits &&
    !services.entitlements &&
    (services.settings.billingMode === "stripe" || services.settings.usageLimitsMode === "managed")
  );
}

/** The request with an output limit, so its cost has a maximum. */
export function withModelCallOutputLimit<T extends Pick<SingleModelCallRequest, "maxOutputTokens">>(
  request: T,
): T & { maxOutputTokens: number } {
  return {
    ...request,
    maxOutputTokens: request.maxOutputTokens ?? MODEL_CALL_DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

/**
 * The most Opengeni credit one call can be charged: its input counted at one
 * token per UTF-8 byte of text (byte-level tokenizers produce fewer), a fixed
 * allowance per image, and its full output limit, at the model's credit price
 * and at whichever of the uncached-input and cache-write rates is higher.
 * Settlement still charges actual usage.
 */
export function modelCallMaxCreditCostMicros(
  settings: Settings,
  modelId: string,
  request: Pick<SingleModelCallRequest, "messages" | "outputFormat"> & { maxOutputTokens: number },
): number {
  const schedules = configuredModelPricingSchedules(settings);
  const pricingModel =
    !schedules[modelId] && modelId.startsWith("codex/") && schedules[modelId.slice("codex/".length)]
      ? modelId.slice("codex/".length)
      : modelId;
  let inputTokens = 0;
  for (const message of request.messages) {
    inputTokens += MODEL_CALL_HOLD_MESSAGE_INPUT_TOKENS;
    if (typeof message.content === "string") {
      inputTokens += Buffer.byteLength(message.content, "utf8");
      continue;
    }
    for (const part of message.content) {
      inputTokens +=
        part.type === "text"
          ? Buffer.byteLength(part.text, "utf8")
          : MODEL_CALL_HOLD_IMAGE_INPUT_TOKENS;
    }
  }
  if (request.outputFormat?.type === "json_schema") {
    inputTokens +=
      Buffer.byteLength(request.outputFormat.name, "utf8") +
      Buffer.byteLength(JSON.stringify(request.outputFormat.schema), "utf8");
  }
  const outputTokens = request.maxOutputTokens;
  const uncached = calculateModelUsageCostBreakdown(settings, pricingModel, {
    inputTokens,
    outputTokens,
  }).creditCostMicros;
  const cacheWrite = calculateModelUsageCostBreakdown(settings, pricingModel, {
    inputTokens,
    outputTokens,
    inputTokensDetails: { cache_write_tokens: inputTokens },
  }).creditCostMicros;
  return Math.max(uncached, cacheWrite);
}

/**
 * Admission for one stateless model call, with the same funding rules as an
 * agent turn between model calls: the workspace allowance must not be
 * exhausted and the static monthly caps apply. An Opengeni-credit model on a
 * credit-metered deployment reserves the call's maximum cost (`creditHold`)
 * against the spendable balance net of other calls still in flight; the
 * caller releases the hold once the call settles or fails, and settlement
 * charges actual usage. A refused admission leaves no hold.
 * Externally funded calls (subscriptions, workspace or organization keys)
 * skip the credit gate and the token cap; an own key needs paid credit for
 * its platform fee, and an own subscription needs a paid plan.
 */
export async function admitModelCall(
  services: { db: Database; settings: Settings; entitlements?: EntitlementsPort | null },
  input: {
    accountId: string;
    workspaceId: string;
    /** Canonical product model id; scopes model-specific promotional credits. */
    model: string;
    chargesOpenGeniCredits: boolean;
    countsTowardTokenCap: boolean;
    subjectId: string | null;
    /** Who pays: API work needs credits; plan credit never pays for it. */
    billingOrigin?: BillingOrigin | null;
    /** Served by the person's own API key (pays the platform fee). */
    byok?: boolean;
    /** Served by the person's own subscription (needs a paid plan, no fee). */
    ownSubscription?: boolean;
    /**
     * Required when the call reserves credits (`modelCallReservesCredits`):
     * its server-generated request id and maximum priced cost
     * (`modelCallMaxCreditCostMicros`).
     */
    creditHold?: { requestId: string; maxCostMicros: number };
  },
): Promise<ModelCallAdmission> {
  const { settings, db } = services;
  const metered = settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
  let creditPolicyRevision: number | undefined;
  let heldRequestId: string | null = null;
  if (
    input.ownSubscription &&
    connectedSubscriptionsRefusedForOrigin(settings, chargeBillingOrigin(input.billingOrigin))
  ) {
    return {
      allowed: false,
      denial: "subscription_api_unavailable",
      message: SUBSCRIPTION_API_UNAVAILABLE_MESSAGE,
    };
  }
  if (
    !input.chargesOpenGeniCredits &&
    input.ownSubscription &&
    !(await ownSubscriptionPlanAllows(db, settings, input.accountId))
  ) {
    return {
      allowed: false,
      denial: "insufficient_credits",
      message: SUBSCRIPTION_PLAN_REQUIRED_MESSAGE,
      subscriptionPlanRequired: true,
    };
  }
  if (
    !input.chargesOpenGeniCredits &&
    input.byok &&
    byokPlatformFeeActive(settings, input.accountId)
  ) {
    const balance = await getByokFeeSpendableBalance(db, input.accountId, input.billingOrigin);
    if (balance.balanceMicros <= 0) {
      return {
        allowed: false,
        denial: "insufficient_credits",
        message: byokPaidCreditRefusalMessage(balance, chargeBillingOrigin(input.billingOrigin)),
        byokPaidCreditRequired: true,
      };
    }
  }
  if (input.chargesOpenGeniCredits && metered) {
    if (services.entitlements) {
      const decision = await services.entitlements.admitRun({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        action: "model_call:create",
        quantity: 1,
      });
      if (!decision.allowed) {
        return {
          allowed: false,
          denial: "insufficient_credits",
          message: decision.reason || "Insufficient workspace credits.",
        };
      }
    } else {
      const origin = chargeBillingOrigin(input.billingOrigin);
      const hold = input.creditHold;
      if (!hold) throw new Error("A credit-metered model call is admitted only with a credit hold");
      // At least one micro, so a zero-priced call still needs a positive balance.
      const amountMicros = Math.max(1, hold.maxCostMicros);
      const reservation = Number.isSafeInteger(amountMicros)
        ? await reserveModelCallCredits(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            requestId: hold.requestId,
            usage: input.model,
            origin,
            amountMicros,
          })
        : { reserved: false, creditPolicyRevision: undefined };
      creditPolicyRevision = reservation.creditPolicyRevision;
      if (!reservation.reserved) {
        return {
          allowed: false,
          denial: "insufficient_credits",
          ...(origin === "api"
            ? { message: API_CREDITS_REQUIRED_MESSAGE, apiCreditsRequired: true as const }
            : { message: "Insufficient workspace credits." }),
        };
      }
      heldRequestId = hold.requestId;
    }
  }
  // A later refusal (or failure) gives the hold back: nothing was dispatched.
  let refusal: ModelCallAdmission | null;
  try {
    refusal = await fundingLimitRefusal(services, input);
  } catch (error) {
    if (heldRequestId) await releaseHold(db, input, heldRequestId);
    throw error;
  }
  if (refusal) {
    if (heldRequestId) await releaseHold(db, input, heldRequestId);
    return refusal;
  }
  return { allowed: true, creditPolicyRevision };
}

async function releaseHold(
  db: Database,
  scope: { accountId: string; workspaceId: string },
  requestId: string,
): Promise<void> {
  await releaseModelCallCredits(db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    requestId,
  }).catch(() => {
    // An unreleased hold stops counting when it expires.
  });
}

/** The allowance and static monthly cap checks that follow the credit gate. */
async function fundingLimitRefusal(
  services: { db: Database; settings: Settings },
  input: {
    accountId: string;
    workspaceId: string;
    chargesOpenGeniCredits: boolean;
    countsTowardTokenCap: boolean;
    subjectId: string | null;
  },
): Promise<ModelCallAdmission | null> {
  const { settings, db } = services;
  const refusal = await checkWorkspaceAllowance(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    ...(input.chargesOpenGeniCredits ? {} : { fundedWithoutCredits: true }),
  });
  if (refusal) {
    return { allowed: false, denial: "allowance_exhausted", message: refusal.message };
  }
  if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
    const limits = configuredStaticUsageLimits(settings);
    const since = startOfUtcMonth();
    if (input.chargesOpenGeniCredits && limits.maxMonthlyCostMicrosPerAccount) {
      const used = await sumUsageQuantity(db, {
        accountId: input.accountId,
        eventType: "model.cost",
        since,
      });
      if (used >= limits.maxMonthlyCostMicrosPerAccount) {
        return {
          allowed: false,
          denial: "monthly_model_cost_limit",
          message: "The monthly model cost limit has been reached.",
        };
      }
    }
    if (input.countsTowardTokenCap && limits.maxMonthlyTokensPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId: input.workspaceId,
        eventType: "model.tokens",
        since,
      });
      if (used >= limits.maxMonthlyTokensPerWorkspace) {
        return {
          allowed: false,
          denial: "monthly_token_limit",
          message: "The monthly token limit has been reached.",
        };
      }
    }
  }
  return null;
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

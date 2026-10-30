import { isLegacyBillingAccount, type Settings } from "@opengeni/config";
import {
  BYOK_PAID_CREDIT_REQUIRED_MESSAGE,
  BYOK_UPGRADE_REQUIRED_MESSAGE,
  type BillingBalance,
  type BillingOrigin,
} from "@opengeni/contracts";

/* ----------------------------------------------------------------------------
   Bring-your-own-key platform fee (docs/billing-origin.md).

   A call served by the person's own provider key or their own Claude, Codex
   or SuperGrok subscription costs Opengeni nothing upstream, so it pays a
   platform fee instead: `byokPlatformFeeBps` (default 500 = 5%) of the
   call's list-price equivalent. The fee is payable only from paid credit.
   -------------------------------------------------------------------------- */

/**
 * List rate for a custom endpoint with no reviewed list price, in USD micros
 * per million tokens: a mid-tier frontier rate ($1.25 input, $10 output), so
 * an unpriced model is never free and never priced like the most expensive.
 * Cached and cache-write tokens count as input.
 */
export const BYOK_FALLBACK_LIST_RATE = Object.freeze({
  inputMicrosPerMillionTokens: 1_250_000,
  outputMicrosPerMillionTokens: 10_000_000,
});

/**
 * Is the fee charged for this account? Only with Stripe billing (people can
 * buy the credit it needs) and a positive rate, and never for an account on
 * legacy billing terms (CloudGeni). Hosts that bind their own entitlements
 * are charged like everyone else.
 */
export function byokPlatformFeeActive(
  settings: Pick<Settings, "billingMode" | "byokPlatformFeeBps" | "billingLegacyAccountIds">,
  accountId: string | null | undefined,
): boolean {
  return (
    settings.billingMode === "stripe" &&
    (settings.byokPlatformFeeBps ?? 0) > 0 &&
    !isLegacyBillingAccount(settings, accountId)
  );
}

/**
 * The list-price equivalent of one bring-your-own-key call: the model's
 * reviewed list price when it has one; else a positive provider-reported
 * cost (a gateway can report $0 on the person's own upstream key); else the
 * fallback rate on the tokens the provider reported.
 */
export function byokListEquivalent(input: {
  listPriceMicros: number | null;
  reportedCostMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}): { listMicros: number; source: "list_price" | "reported_cost" | "fallback_rate" } {
  if (input.listPriceMicros !== null && input.listPriceMicros > 0) {
    return { listMicros: input.listPriceMicros, source: "list_price" };
  }
  if (input.reportedCostMicros !== null && input.reportedCostMicros > 0) {
    return { listMicros: input.reportedCostMicros, source: "reported_cost" };
  }
  const inputTokens = Math.max(0, input.inputTokens ?? 0);
  const outputTokens = Math.max(0, input.outputTokens ?? 0);
  return {
    listMicros: Math.ceil(
      (inputTokens * BYOK_FALLBACK_LIST_RATE.inputMicrosPerMillionTokens +
        outputTokens * BYOK_FALLBACK_LIST_RATE.outputMicrosPerMillionTokens) /
        1_000_000,
    ),
    source: "fallback_rate",
  };
}

/** The fee in USD micros, rounded up so a priced call is never fee-free. */
export function byokPlatformFeeMicros(listMicros: number, bps: number): number {
  if (!Number.isFinite(listMicros) || listMicros <= 0 || bps <= 0) return 0;
  return Math.ceil((listMicros * bps) / 10_000);
}

/**
 * What an own-key refusal tells the person: on the Free plan in the app,
 * upgrading is the fix; otherwise (a paid plan, top-ups, any API use) adding
 * credits is.
 */
export function byokPaidCreditRefusalMessage(
  balance: Pick<BillingBalance, "plan">,
  origin: BillingOrigin,
): string {
  return origin === "app" && balance.plan?.key === "free"
    ? BYOK_UPGRADE_REQUIRED_MESSAGE
    : BYOK_PAID_CREDIT_REQUIRED_MESSAGE;
}

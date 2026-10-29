import type { Settings } from "@opengeni/config";

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

/** Is the fee charged at all (credit billing active and a positive rate)? */
export function byokPlatformFeeActive(settings: Settings): boolean {
  return (
    (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed") &&
    (settings.byokPlatformFeeBps ?? 0) > 0
  );
}

/**
 * The list-price equivalent of one bring-your-own-key call: the reviewed
 * list (or provider-reported) cost when settlement priced it, else the
 * fallback rate on the tokens the provider reported.
 */
export function byokListEquivalent(input: {
  estimatedProviderCostMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}): { listMicros: number; source: "list_price" | "fallback_rate" } {
  if (input.estimatedProviderCostMicros !== null && input.estimatedProviderCostMicros >= 0) {
    return { listMicros: input.estimatedProviderCostMicros, source: "list_price" };
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

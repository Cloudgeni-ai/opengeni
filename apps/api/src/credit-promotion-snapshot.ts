import { PromotionalCreditScope } from "@opengeni/contracts";

const prefix = "opengeni_credit_scope_";
const countKey = `${prefix}v1`;

/** Preserve scoped status and fallback eligibility; runtime policy can update coverage.
 * Stripe metadata values are limited to 500 characters. Keep each chunk below that. */
export function creditScopeMetadata(scope?: PromotionalCreditScope): Record<string, string> {
  if (!scope) return {};
  const encoded = JSON.stringify(PromotionalCreditScope.parse(scope));
  const chunks = encoded.match(/[\s\S]{1,400}/g)!;
  if (chunks.length > 24)
    throw new Error("Promotional credit policy exceeds checkout metadata limits");
  return Object.fromEntries([
    [countKey, String(chunks.length)],
    ...chunks.map((chunk, index) => [`${prefix}${index}`, chunk]),
  ]);
}

/** Missing metadata is a legacy checkout; incomplete metadata must never become unrestricted. */
export function creditScopeFromMetadata(
  metadata: Record<string, string> | null | undefined,
): PromotionalCreditScope | undefined {
  if (!metadata || !Object.keys(metadata).some((key) => key.startsWith(prefix))) return undefined;
  const count = Number(metadata[countKey]);
  if (!Number.isInteger(count) || count < 1 || count > 24) {
    throw new Error("Invalid promotional credit snapshot");
  }
  let encoded = "";
  for (let index = 0; index < count; index++) {
    const chunk = metadata[`${prefix}${index}`];
    if (!chunk) throw new Error("Incomplete promotional credit snapshot");
    encoded += chunk;
  }
  return PromotionalCreditScope.parse(JSON.parse(encoded));
}

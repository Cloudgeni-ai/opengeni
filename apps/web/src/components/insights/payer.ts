import type { UsagePayerId } from "./usage-contract";

/** Providers whose calls run on a connected ChatGPT, Claude or SuperGrok plan. */
const SUBSCRIPTION_PROVIDERS = new Set([
  "codex-subscription",
  "workspace-claude-subscription",
  "organization-claude-subscription",
  "supergrok-subscription",
]);

/**
 * Who pays for a model call. Credits are what Opengeni charged; a
 * subscription or the customer's own API key is paid outside Opengeni, so
 * Insights shows its list-price estimate instead of a charge.
 */
export function usagePayer(
  billing: "opengeni_credits" | "external",
  provider: string,
): UsagePayerId {
  if (billing === "opengeni_credits") return "opengeni_credits";
  return SUBSCRIPTION_PROVIDERS.has(provider) ? "subscription" : "own_key";
}

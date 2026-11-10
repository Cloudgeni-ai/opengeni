import { isDirectModelProviderId } from "@opengeni/contracts";

/** Bounded operational attribution, never an authorization or retry decision. */
export type FailureOrigin = "none" | "platform" | "customer_provider";

const CUSTOMER_PROVIDER_CODES = new Set([
  "provider_quota_exhausted",
  "provider_rate_limited",
  "provider_billing_error",
  "codex_usage_limit_reached",
  "codex_plan_entitlement",
]);
const CUSTOMER_CAPACITY_REASONS = new Set([
  "no_eligible_capacity",
  "pinned_account_disabled",
  "pinned_account_unavailable",
  "pinned_account_ineligible",
  "model_not_allowed",
  "compaction_provider_locked",
]);
/**
 * Closed provider-account refusals read from the provider's own response:
 * the customer's provider account itself, not our request, refused to serve.
 * `byok_capacity_restricted`: an OpenRouter account restricted to its own
 * provider keys has no key eligible for the request (HTTP 404).
 * `customer_verification_required`: Vercel AI Gateway requires the account to
 * add a payment method (HTTP 403 with that structured type).
 * `key_limit_exceeded`: the customer's own OpenRouter key reached the credit or
 * budget limit the customer set on it (HTTP 403).
 */
export const PROVIDER_ACCOUNT_REFUSALS = [
  "byok_capacity_restricted",
  "customer_verification_required",
  "key_limit_exceeded",
] as const;
export type ProviderAccountRefusal = (typeof PROVIDER_ACCOUNT_REFUSALS)[number];
export function isProviderAccountRefusal(value: unknown): value is ProviderAccountRefusal {
  return (
    typeof value === "string" && (PROVIDER_ACCOUNT_REFUSALS as readonly string[]).includes(value)
  );
}
const PROVIDER_QUOTA_SCOPES = new Set(["daily", "monthly", "credits", "quota"]);

/** Unknown errors, malformed requests and internal lease failures remain platform failures. */
export function failureOrigin(input: {
  customerManaged: boolean;
  outcome: string;
  code?: unknown;
  waitReason?: unknown;
  refusal?: unknown;
  /** Typed marker set only from the provider's own response (see PROVIDER_ACCOUNT_REFUSALS). */
  providerAccountRefusal?: unknown;
  /** Closed exhausted-quota marker; counts on a failed compaction request. */
  quotaScope?: unknown;
  httpStatus?: number;
}): FailureOrigin {
  if (input.outcome !== "failed") return "none";
  if (!input.customerManaged) return "platform";
  if (typeof input.code === "string" && CUSTOMER_PROVIDER_CODES.has(input.code))
    return "customer_provider";
  if (isProviderAccountRefusal(input.providerAccountRefusal)) return "customer_provider";
  // A compaction request refused for the same exhausted provider quota as an
  // ordinary `provider_quota_exhausted` turn carries the same closed marker.
  if (
    input.code === "context_compaction_failed" &&
    typeof input.quotaScope === "string" &&
    PROVIDER_QUOTA_SCOPES.has(input.quotaScope)
  )
    return "customer_provider";
  if (
    input.code === "subscription_capacity_unavailable" &&
    typeof input.waitReason === "string" &&
    CUSTOMER_CAPACITY_REASONS.has(input.waitReason)
  )
    return "customer_provider";
  if (
    input.code === "subscription_account_refused" &&
    ["sign_in", "forbidden", "entitlement"].includes(String(input.refusal))
  )
    return "customer_provider";
  // HTTP status is supplied only by the model-provider response boundary.
  if (
    input.httpStatus !== undefined &&
    ([401, 402, 403, 429].includes(input.httpStatus) ||
      (input.httpStatus >= 500 && input.httpStatus <= 599))
  )
    return "customer_provider";
  return "platform";
}

/** Reserved runtime provider identities, not arbitrary model slugs or display names. */
const CUSTOMER_PROVIDER_IDS = new Set([
  "workspace-openrouter",
  "organization-openrouter",
  "workspace-gateway",
  "organization-gateway",
  "workspace-opper",
  "organization-opper",
  "organization-openai",
  "organization-azure-openai",
  "workspace-anthropic",
  "organization-anthropic",
  "workspace-claude-subscription",
  "organization-claude-subscription",
  "codex-subscription",
  "supergrok-subscription",
  "claude-subscription",
]);
export function isCustomerManagedMetricProvider(provider: string): boolean {
  // Direct connections (workspace-openai-*, workspace-azure-openai-*,
  // workspace-compatible-*) and organization compatible connections use the
  // customer's own key.
  return (
    CUSTOMER_PROVIDER_IDS.has(provider) ||
    (isDirectModelProviderId(provider) && !provider.endsWith("-")) ||
    /^organization-compatible-.+$/.test(provider)
  );
}

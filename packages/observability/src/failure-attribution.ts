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

/** Unknown errors, malformed requests and internal lease failures remain platform failures. */
export function failureOrigin(input: {
  customerManaged: boolean;
  outcome: string;
  code?: unknown;
  waitReason?: unknown;
  refusal?: unknown;
  httpStatus?: number;
}): FailureOrigin {
  if (input.outcome !== "failed") return "none";
  if (!input.customerManaged) return "platform";
  if (typeof input.code === "string" && CUSTOMER_PROVIDER_CODES.has(input.code))
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
  return CUSTOMER_PROVIDER_IDS.has(provider) || /^workspace-compatible-.+$/.test(provider);
}

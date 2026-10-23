/**
 * What a stopped agent tells the person: one short sentence, and a Retry only
 * when trying again can work. Internal codes and provider text never show.
 */
export type FailureView = {
  kind:
    | "limit"
    | "budget"
    | "reconnect"
    | "declined"
    | "too_long"
    | "plan"
    | "temporary"
    | "unknown";
  message: string;
  /** Trying the same thing again can work. */
  retry: boolean;
  /** Reconnecting ChatGPT is what fixes it. */
  reconnect?: true;
};

const LIMIT_CODES = new Set([
  "codex_usage_limit_reached",
  "codex_included_usage_exhausted",
  "codex_capacity_recovery_exhausted",
  "subscription_capacity_unavailable",
  "subscription_failover_exhausted",
  "provider_quota_exhausted",
]);
const RECONNECT_CODES = new Set([
  "codex_credential_lease_lost",
  "subscription_account_refused",
  "anthropic_authentication_error",
]);
const BUDGET_CODES = new Set([
  "insufficient_credits",
  "allowance_exhausted",
  "monthly_model_cost_limit",
  "monthly_agent_run_limit",
  "session_usage_limit",
  "provider_billing_error",
]);
const PLAN_CODES = new Set([
  "codex_plan_entitlement",
  "codex_request_rejected",
  "model_not_available_on_plan",
  "model_not_entitled",
  "model_not_included_in_plan",
  "model_not_in_plan",
  "model_not_allowed",
  "model_not_allowed_by_connection",
  "model_not_allowed_by_workspace",
]);
const TOO_LONG_CODES = new Set([
  "context_compaction_failed",
  "context_length_exceeded",
  "context_window_exceeded",
]);
const TEMPORARY_CODES = new Set([
  "codex_response_timeout",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_overloaded",
  "upstream_connectivity_unavailable",
  "mcp_transport_timeout",
  "mcp_transport_unavailable",
  "broker_unavailable",
  "db_deadlock",
  "db_serialization_failure",
  "db_failure",
]);

/** Reads a session's recorded failure (`failureDiagnostics.payload`). */
export function failureView(payload: unknown): FailureView {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const code = typeof record.code === "string" ? record.code : "";
  // A known temporary code wins over wording that sounds final.
  const text = TEMPORARY_CODES.has(code)
    ? ""
    : [record.error, record.message, record.detail, record.lastRetryableError]
        .filter((part): part is string => typeof part === "string")
        .join(" ")
        .toLowerCase();

  // Provider wording is matched only where it names ChatGPT, so another
  // service's 401 or a disk quota never reads as a ChatGPT problem.
  const aboutChatGpt = /chatgpt|codex|openai/.test(text);
  if (
    LIMIT_CODES.has(code) ||
    typeof record.quotaScope === "string" ||
    (aboutChatGpt && /usage limit/.test(text))
  ) {
    // The worker names the reset window ("resets in about 2h 5m", "in 2.5 hours").
    const reset = /(?:resets|returns) (in (?:about |under )?(?:\d+(?:\.\d+)?\s*[a-z]+\s*)+)/i.exec(
      typeof record.error === "string" ? record.error : "",
    )?.[1];
    return {
      kind: "limit",
      message: reset
        ? `ChatGPT's usage limit is reached. It resets ${reset.trim()}.`
        : "ChatGPT's usage limit is reached. Try again later.",
      retry: false,
    };
  }
  if (BUDGET_CODES.has(code)) {
    return { kind: "budget", message: "The usage allowance for this is used up.", retry: false };
  }
  if (
    RECONNECT_CODES.has(code) ||
    (aboutChatGpt &&
      /\b401\b|unauthori[sz]ed|credentials? (?:expired|were revoked|rejected)|sign in again|reconnect/.test(
        text,
      ))
  ) {
    return {
      kind: "reconnect",
      message: "ChatGPT needs to be connected again.",
      retry: false,
      reconnect: true,
    };
  }
  if (code === "provider_safety_refusal" || /blocked by our safety systems/.test(text)) {
    return { kind: "declined", message: "ChatGPT declined this request.", retry: false };
  }
  if (PLAN_CODES.has(code)) {
    return {
      kind: "plan",
      message: "Your ChatGPT plan doesn't include what this needs.",
      retry: false,
    };
  }
  if (TOO_LONG_CODES.has(code)) {
    return {
      kind: "too_long",
      message: "This chat got too long to continue. Start a new agent for new work.",
      retry: false,
    };
  }
  if (
    TEMPORARY_CODES.has(code) ||
    /timed? ?out|temporarily|try again in a few minutes/.test(text)
  ) {
    return { kind: "temporary", message: "ChatGPT didn't respond in time.", retry: true };
  }
  // Anything else may well fail the same way, so no Retry button: a new
  // message (maybe worded differently) is the honest next step.
  return {
    kind: "unknown",
    message: "Something went wrong. Send a message to carry on.",
    retry: false,
  };
}

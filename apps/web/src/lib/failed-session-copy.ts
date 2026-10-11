import { providerRecoverySubject } from "@opengeni/react";
import type { SessionFailureSummary } from "./events";

/**
 * Known provider failure classes. Presentation only: the stored event keeps the
 * exact recorded text, which the banner offers behind a details toggle.
 * `suggestModel` points the user at the model picker when another model avoids
 * the failure. `retryUnhelpful` is reserved for rejected credentials: the same
 * request on the same model cannot succeed until the key is fixed, so Retry
 * returns only once another model is selected. Billing, access and limit
 * failures keep Retry because the condition can clear (a top-up, a verified
 * organization, a daily reset).
 */
type KnownFailure = {
  /** Closed analytics class (turn-failure-analytics.ts); never shown to people. */
  kind: KnownFailureKind;
  message: string;
  retryUnhelpful: boolean;
  suggestModel: boolean;
  /**
   * Whole headline when another model can be chosen, for transient refusals
   * whose remedy reads as a choice. Otherwise " Choose another model below."
   * is appended to `message`.
   */
  chooseModelMessage?: string;
};
export type KnownFailureKind =
  | "provider_credentials"
  | "provider_billing"
  | "provider_access"
  | "daily_limit"
  | "monthly_limit"
  | "provider_quota"
  | "rate_limited"
  | "provider_error";

const CREDENTIALS: KnownFailure = {
  kind: "provider_credentials",
  message: "The model provider rejected the credentials for this model.",
  retryUnhelpful: true,
  suggestModel: true,
};
const PROVIDER_BILLING: KnownFailure = {
  kind: "provider_billing",
  message: "The model provider account for this model is out of credits.",
  retryUnhelpful: false,
  suggestModel: true,
};
const PROVIDER_PAYMENT: KnownFailure = {
  kind: "provider_billing",
  message: "The model provider couldn't bill this request. Check the account's payment details.",
  retryUnhelpful: false,
  suggestModel: true,
};
const PROVIDER_ACCESS: KnownFailure = {
  kind: "provider_access",
  message: "The model provider denied access to this model.",
  retryUnhelpful: false,
  suggestModel: true,
};
const DAILY_LIMIT: KnownFailure = {
  kind: "daily_limit",
  message: "This model's daily limit has been reached.",
  retryUnhelpful: false,
  suggestModel: true,
};
const MONTHLY_LIMIT: KnownFailure = {
  kind: "monthly_limit",
  message: "This model's monthly limit has been reached.",
  retryUnhelpful: false,
  suggestModel: true,
};
const QUOTA: KnownFailure = {
  kind: "provider_quota",
  message: "The model provider's usage quota for this model is used up.",
  retryUnhelpful: false,
  suggestModel: true,
};
const RATE_LIMITED: KnownFailure = {
  kind: "rate_limited",
  message: "This model is throttled due to high demand. Try again in a few minutes.",
  chooseModelMessage:
    "This model is throttled due to high demand. Select a different model, or try again in a few minutes.",
  retryUnhelpful: false,
  suggestModel: true,
};
const PROVIDER_ERROR: KnownFailure = {
  kind: "provider_error",
  message: "This model is temporarily unavailable. Try again in a few minutes.",
  chooseModelMessage:
    "This model is temporarily unavailable. Select a different model, or try again in a few minutes.",
  retryUnhelpful: false,
  suggestModel: true,
};

const UNKNOWN_FAILURE = "The session stopped unexpectedly.";
const EXECUTION_CONNECTION_FAILURE = "Opengeni lost contact with the execution environment.";
const CODEX_REQUEST_REJECTED = "Codex rejected this request.";

/** The worker's closed quota marker, on a quota turn failure or a compaction failure. */
function quotaScopeFailure(scope: string | null | undefined): KnownFailure | null {
  switch (scope) {
    case "daily":
      return DAILY_LIMIT;
    case "monthly":
      return MONTHLY_LIMIT;
    case "credits":
      return PROVIDER_BILLING;
    case "quota":
      return QUOTA;
    default:
      return null;
  }
}

// Worker codes whose recorded text is the provider's own (or, for an exhausted
// quota, authored copy plus the provider's text). Every other code already
// carries authored copy (Codex, SuperGrok, sandbox, MCP, ...).
const PROVIDER_TEXT_CODES = new Set([
  "provider_rate_limited",
  "provider_unavailable",
  "provider_quota_exhausted",
]);

/** Classify known provider text; unknown failures use a separate generic headline. */
export function classifyProviderFailure(
  recorded: string,
  failureCode?: string | null,
  quotaScope?: string | null,
): KnownFailure | null {
  if (failureCode === "provider_billing_error") return PROVIDER_PAYMENT;
  if (failureCode === "anthropic_authentication_error") return CREDENTIALS;
  const scoped = quotaScopeFailure(quotaScope);
  if (scoped) return scoped;
  if (failureCode && !PROVIDER_TEXT_CODES.has(failureCode)) return null;
  const text = recorded.toLowerCase();
  // Closed legacy copy authored by the native Claude adapter, whose original
  // worker payload omitted the HTTP status/code. Preserve its credential
  // remedy without granting classification to arbitrary expiry wording.
  if (
    recorded.trim() ===
    "Claude credentials expired or were revoked. Replace the key or setup token in Models."
  )
    return CREDENTIALS;
  // Opengeni's own credit exhaustion has a dedicated billing remedy upstream.
  if (text.includes("opengeni credits")) return null;
  // Provider SDKs prefix the HTTP status ("401 Incorrect API key ..."). A
  // status alone classifies only 401/402/403/429; other statuses do not prove
  // a cause and use the generic headline with recorded diagnostics.
  const status = /^\s*(4\d\d)\b/.exec(recorded)?.[1] ?? null;
  if (
    status === "401" ||
    /\b(?:incorrect|invalid)[ _-]?(?:api[ _-]?key|x-api-key|subscription key)\b/.test(text) ||
    text.includes("authentication_error") ||
    text.includes("platform.openai.com/account/api-keys") ||
    text.includes("rejected this deployment's engine credentials") ||
    (/\b401\b/.test(text) && /\b(?:api key|unauthori[sz]ed|authenticat)/.test(text))
  ) {
    return CREDENTIALS;
  }
  if (/free-models-per-day|daily (?:limit|quota)|requests per day/.test(text)) return DAILY_LIMIT;
  if (
    text.includes("insufficient_quota") ||
    text.includes("exceeded your current quota") ||
    text.includes("provider quota is exhausted")
  ) {
    return QUOTA;
  }
  if (
    status === "402" ||
    /\bpayment required\b|\binsufficient (?:credits|balance|funds)\b|\brequires more credits\b|\bout of credits\b|\bcredit balance is too low\b|\bupgrade to a paid account\b/.test(
      text,
    )
  ) {
    return PROVIDER_BILLING;
  }
  if (
    status === "403" ||
    /organization must be verified|country, region, or territory not supported/.test(text)
  ) {
    return PROVIDER_ACCESS;
  }
  // The worker stopped retrying because the quota cannot clear in minutes.
  if (failureCode === "provider_quota_exhausted") return QUOTA;
  if (failureCode === "provider_rate_limited" || status === "429") return RATE_LIMITED;
  if (failureCode === "provider_unavailable") return PROVIDER_ERROR;
  return null;
}

/** Summarize recorded evidence without guessing a provider, expiry or reset time. */
export function failedSessionCopy(
  failure: SessionFailureSummary,
  creditExhausted = false,
  modelChanged = false,
  canChooseModel = false,
): {
  reason: string;
  unavailableModel: boolean;
  /** Rejected credentials: Retry on the same model cannot help; offer it again once the model changes. */
  retryUnhelpful?: boolean;
  /** Exact recorded text for a details toggle, when the headline replaced it. */
  detail?: string;
  /** A daily allowance is spent; the banner may name the deployment's free model. */
  dailyLimit?: true;
} {
  const recorded = failure.reason?.replace(/\s+/g, " ").trim();
  const diagnostic = failure.recordedDetail || failure.reason;
  // Worker Codex account copy names the account and plan and already offers
  // the remedies (upgrade, another account, another model): keep it whole.
  // Retry stays, because an upgrade or another account clears the condition
  // and admission re-checks the plan without a model request.
  const code = failure.failureCode;
  if (code === "codex_request_rejected") {
    return {
      reason:
        canChooseModel && !modelChanged
          ? `${CODEX_REQUEST_REJECTED} Try again, or choose another model below.`
          : `${CODEX_REQUEST_REJECTED} Try again when you're ready.`,
      unavailableModel: false,
      ...(diagnostic ? { detail: diagnostic } : {}),
    };
  }
  if (recorded && code === "codex_plan_entitlement") {
    const detail = failure.recordedDetail?.trim();
    return {
      reason: recorded,
      unavailableModel: false,
      ...(detail && detail !== recorded ? { detail } : {}),
    };
  }
  // Spent automatic recovery on a recorded model route: name the model and the
  // provider condition. Legacy events without the route keep the classified
  // copy below; the exact recorded text stays behind Details either way.
  const recovery = failure.providerRecovery;
  if (
    recovery?.modelRoute &&
    recovery.modelLabel &&
    !creditExhausted &&
    !failure.safetyRefusal &&
    !failure.quotaScope
  ) {
    const subject = providerRecoverySubject(recovery);
    return {
      reason: modelChanged
        ? `${subject}. Retry to continue with the selected model.`
        : canChooseModel
          ? `${subject}. Select a different model, or try again in a few minutes.`
          : `${subject}. Try again in a few minutes.`,
      unavailableModel: false,
      retryUnhelpful: false,
      ...(diagnostic ? { detail: diagnostic } : {}),
    };
  }
  // Require an explicit claim about the model itself, not e.g. its connection
  // or service being unavailable.
  const unavailableModel =
    /\bmodel(?:\s+[`'"][^`'"]+[`'"])?\s+(?:(?:is|was)\s+)?(?:not supported|not available|unavailable|does not exist)\b/i.test(
      recorded ?? "",
    );
  const known =
    creditExhausted || failure.safetyRefusal || unavailableModel
      ? null
      : (quotaScopeFailure(failure.quotaScope) ??
        // A recorded recovery streak proves the worker paced this transient
        // refusal. Provider quota wording alone must not override that typed
        // decision (e.g. Gemini's per-minute quota); legacy failures with an
        // unknown streak retain their existing text fallback.
        (failure.failureCode === "provider_rate_limited" &&
        failure.consecutiveRecoveryCount !== null
          ? RATE_LIMITED
          : classifyProviderFailure(
              failure.recordedDetail ?? recorded ?? "",
              failure.failureCode,
              failure.quotaScope,
            )));
  if (known) {
    const detail = diagnostic;
    const suggest = known.suggestModel && canChooseModel && !modelChanged;
    return {
      reason: suggest
        ? (known.chooseModelMessage ?? `${known.message} Choose another model below.`)
        : known.message,
      unavailableModel: false,
      retryUnhelpful: known.retryUnhelpful,
      ...(detail && detail !== known.message ? { detail } : {}),
      ...(known === DAILY_LIMIT ? { dailyLimit: true as const } : {}),
    };
  }
  // Unclassified preclaim text can also contain raw infrastructure diagnostics.
  // Presentation only: transport text grants no retry or provider-loss proof.
  // Preserve the complete diagnostic behind the existing Details disclosure.
  if (
    !creditExhausted &&
    !failure.safetyRefusal &&
    !failure.structuralSandboxFailure &&
    !unavailableModel &&
    (!code || code === "pre_claim_failure") &&
    !/opengeni credits/i.test(recorded ?? "")
  ) {
    const detail = diagnostic;
    return {
      reason:
        /\/modal\.task_command_router\.TaskCommandRouter\/\w+\s+(?:UNAVAILABLE|DEADLINE_EXCEEDED)/.test(
          detail ?? "",
        )
          ? EXECUTION_CONNECTION_FAILURE
          : UNKNOWN_FAILURE,
      unavailableModel: false,
      ...(detail ? { detail } : {}),
    };
  }
  const reason = creditExhausted
    ? "This workspace is out of Opengeni credits."
    : failure.safetyRefusal
      ? "The model provider declined this request."
      : unavailableModel
        ? modelChanged
          ? "The previous model isn’t available."
          : canChooseModel
            ? "This model isn’t available. Choose another below."
            : "This model isn’t available."
        : recorded
          ? recorded.length > 160
            ? `${recorded.slice(0, 157)}…`
            : recorded
          : "This session failed.";
  return { reason, unavailableModel };
}

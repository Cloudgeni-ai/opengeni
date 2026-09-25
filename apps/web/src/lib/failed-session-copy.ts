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
type KnownFailure = { message: string; retryUnhelpful: boolean; suggestModel: boolean };

const CREDENTIALS: KnownFailure = {
  message: "The model provider rejected the credentials for this model.",
  retryUnhelpful: true,
  suggestModel: true,
};
const PROVIDER_BILLING: KnownFailure = {
  message: "The model provider account for this model is out of credits.",
  retryUnhelpful: false,
  suggestModel: true,
};
const PROVIDER_ACCESS: KnownFailure = {
  message: "The model provider denied access to this model.",
  retryUnhelpful: false,
  suggestModel: true,
};
const DAILY_LIMIT: KnownFailure = {
  message: "This model's daily limit has been reached.",
  retryUnhelpful: false,
  suggestModel: true,
};
const QUOTA: KnownFailure = {
  message: "The model provider's usage quota for this model is used up.",
  retryUnhelpful: false,
  suggestModel: true,
};
const RATE_LIMITED: KnownFailure = {
  message: "The model provider is rate limiting requests. Try again in a minute.",
  retryUnhelpful: false,
  suggestModel: false,
};
const PROVIDER_ERROR: KnownFailure = {
  message: "The model provider had a temporary error.",
  retryUnhelpful: false,
  suggestModel: false,
};

// Worker codes whose recorded text is the provider's own. Every other code
// already carries authored copy (Codex, SuperGrok, sandbox, MCP, ...).
const PROVIDER_TEXT_CODES = new Set(["provider_rate_limited", "provider_unavailable"]);

/** Classify recorded provider text. Unknown failures return null and keep their wording. */
export function classifyProviderFailure(
  recorded: string,
  failureCode?: string | null,
): KnownFailure | null {
  if (failureCode && !PROVIDER_TEXT_CODES.has(failureCode)) return null;
  const text = recorded.toLowerCase();
  // OpenGeni's own credit exhaustion has a dedicated billing remedy upstream.
  if (text.includes("opengeni credits")) return null;
  // Provider SDKs prefix the HTTP status ("401 Incorrect API key ..."). A
  // status alone classifies only 401/402/403/429; any other leading 4xx keeps
  // its recorded wording because the status says nothing about the cause.
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
    /\bpayment required\b|\binsufficient (?:credits|balance|funds)\b|\brequires more credits\b|\bupgrade to a paid account\b/.test(
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
} {
  const recorded = failure.reason?.replace(/\s+/g, " ").trim();
  // Require an explicit claim about the model itself, not e.g. its connection
  // or service being unavailable. Unknown errors retain their recorded wording.
  const unavailableModel =
    /\bmodel(?:\s+[`'"][^`'"]+[`'"])?\s+(?:(?:is|was)\s+)?(?:not supported|not available|unavailable|does not exist)\b/i.test(
      recorded ?? "",
    );
  const known =
    creditExhausted || failure.safetyRefusal || unavailableModel
      ? null
      : classifyProviderFailure(failure.recordedDetail ?? recorded ?? "", failure.failureCode);
  if (known) {
    const detail = failure.recordedDetail?.trim() || recorded;
    return {
      reason:
        known.suggestModel && canChooseModel && !modelChanged
          ? `${known.message} Choose another model below.`
          : known.message,
      unavailableModel: false,
      retryUnhelpful: known.retryUnhelpful,
      ...(detail && detail !== known.message ? { detail } : {}),
    };
  }
  const reason = creditExhausted
    ? "This workspace is out of OpenGeni credits."
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

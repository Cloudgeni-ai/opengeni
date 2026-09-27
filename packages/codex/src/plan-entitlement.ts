// ChatGPT plan entitlement evidence for Codex model requests.
//
// A ChatGPT account can change plan (for example Pro to Free) while OpenGeni
// keeps its refresh token. The Codex backend then rejects requests for models
// the new plan does not include. It sometimes says so explicitly, and it has
// also been observed to answer with an HTTP 400 and an empty body. Neither is
// quota, authentication, or a content error, so this module classifies them
// separately. The classification is only evidence: the worker re-checks the
// account's current plan before it treats the credential as ineligible.

import {
  classifyCodexEncryptedArtifactRejection,
  classifyCodexUsageLimitError,
  isCodexTransportError,
} from "./fetch";

export type CodexEntitlementRejectionEvidence =
  /** HTTP 400 with no body at all: ambiguous until the plan is re-checked. */
  | "empty_body"
  /** The provider explicitly named the plan, subscription, or model access. */
  | "plan_entitlement";

export type CodexEntitlementRejection = {
  status: 400 | 403 | 429;
  evidence: CodexEntitlementRejectionEvidence;
};

/** Provider error codes/types that name a plan or model-access refusal. */
const CODEX_PLAN_ENTITLEMENT_CODES = new Set([
  "usage_not_included",
  "plan_not_entitled",
  "model_not_available_on_plan",
  "model_not_in_plan",
  "model_not_included_in_plan",
  "subscription_required",
  "upgrade_required",
]);

const PLAN_ENTITLEMENT_MESSAGE =
  /\b(?:not (?:available|included|supported|enabled) (?:on|in|for|with) (?:your|this|the|a) (?:current )?(?:chatgpt )?(?:plan|subscription|tier)|upgrade (?:your (?:chatgpt )?(?:plan|subscription)|to (?:a |the )?(?:paid|plus|pro|team|business|enterprise)\b)|(?:plan|subscription|tier) (?:does not|doesn't) (?:include|support|allow)|requires? (?:a |an )?(?:paid|plus|pro|team|business|enterprise|higher) (?:chatgpt )?(?:plan|subscription|tier))/i;

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Classify a Codex transport refusal that may mean the serving ChatGPT account
 * no longer includes the requested model. Only errors produced by this Codex
 * transport qualify, and the opaque-artifact (encrypted content) 400 family and
 * usage-limit refusals keep their own paths.
 */
export function classifyCodexEntitlementRejection(
  error: unknown,
): CodexEntitlementRejection | null {
  if (!isCodexTransportError(error)) return null;
  if (classifyCodexEncryptedArtifactRejection(error)) return null;
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const value = current as Record<string, unknown>;
    const body =
      value.error && typeof value.error === "object"
        ? (value.error as Record<string, unknown>)
        : null;
    const status = Number(value.status ?? value.statusCode ?? body?.status);
    if (status === 400 || status === 403 || status === 429) {
      const codes = [value.code, value.type, body?.code, body?.type]
        .map((field) => stringField(field).toLowerCase())
        .filter((field) => field.length > 0);
      // An exact plan code outranks the looser usage-limit wording: Codex
      // reports "usage not included in your plan" as a 429 too.
      if (codes.some((code) => CODEX_PLAN_ENTITLEMENT_CODES.has(code))) {
        return { status, evidence: "plan_entitlement" };
      }
      if (classifyCodexUsageLimitError(error)) return null;
      const message = [stringField(value.message), stringField(body?.message)].join(" ");
      if (status !== 429 && PLAN_ENTITLEMENT_MESSAGE.test(message)) {
        return { status, evidence: "plan_entitlement" };
      }
      // The OpenAI SDK reports a response with no body as
      // "400 status code (no body)" and leaves `error` undefined. A JSON or
      // text body, however unhelpful, is a different failure.
      if (
        status === 400 &&
        (value.error === undefined || value.error === null) &&
        /^400(?: status code \(no body\))?\s*$/.test(stringField(value.message).trim())
      ) {
        return { status, evidence: "empty_body" };
      }
      return null;
    }
    current = value.cause;
  }
  return null;
}

/** Stable, comparable plan key. Unknown plans compare as "unknown". */
export function codexPlanKey(planType: string | null | undefined): string {
  const normalized = typeof planType === "string" ? planType.trim().toLowerCase() : "";
  return normalized.length > 0 ? normalized.slice(0, 64) : "unknown";
}

/** Human plan name for product copy ("free" -> "Free", "pro" -> "Pro"). */
export function codexPlanDisplayName(planType: string | null | undefined): string | null {
  const key = codexPlanKey(planType);
  if (key === "unknown") return null;
  switch (key) {
    case "free":
      return "Free";
    case "go":
      return "Go";
    case "plus":
      return "Plus";
    case "pro":
      return "Pro";
    case "team":
      return "Team";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    case "edu":
      return "Edu";
    default:
      return key
        .split(/[_\s-]+/)
        .filter((part) => part.length > 0)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

/**
 * Decide whether a re-checked plan explains an entitlement rejection.
 *
 * Explicit plan evidence from the provider is authoritative for this model.
 * An empty 400 counts only when the re-check shows the Free plan, or a plan
 * that differs from the one OpenGeni last recorded. A paid, unchanged plan
 * leaves the rejection unexplained, so the credential stays eligible.
 */
export function codexPlanEntitlementLost(input: {
  evidence: CodexEntitlementRejectionEvidence;
  previousPlanType: string | null;
  currentPlanType: string | null;
}): boolean {
  if (input.evidence === "plan_entitlement") return true;
  const current = codexPlanKey(input.currentPlanType);
  if (current === "unknown") return false;
  if (current === "free") return true;
  const previous = codexPlanKey(input.previousPlanType);
  return previous !== "unknown" && previous !== current;
}

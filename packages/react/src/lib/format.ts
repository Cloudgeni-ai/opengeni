import { formatErrorMessage, OpenGeniApiError } from "@opengeni/sdk";
import { parseProviderRecovery, providerRecoveryExhaustedText } from "./provider-recovery";
import { type OpenGeniText } from "../messages/runtime";

const clockTimeFormatters = new Map<string, Intl.DateTimeFormat>();
function clockTimeFormatter(locale: string | undefined): Intl.DateTimeFormat {
  const key = locale ?? "";
  let formatter = clockTimeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    clockTimeFormatters.set(key, formatter);
  }
  return formatter;
}

/** Local finished-at stamp for message footers: "Aug 2, 3:42 PM" / locale-equivalent. */
export function formatClockTime(t: OpenGeniText, iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return "";
  }
  return clockTimeFormatter(t.locale).format(then);
}

/** Compact relative time: "now", "42s", "7m", "3h", "2d", then a date. */
export function formatRelativeTime(t: OpenGeniText, iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 10) {
    return t("lib.format.now");
  }
  if (seconds < 60) {
    return t("lib.format.seconds", { count: seconds });
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return t("lib.format.minutes", { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t("lib.format.hours", { count: hours });
  }
  const days = Math.floor(hours / 24);
  if (days < 14) {
    return t("lib.format.days", { count: days });
  }
  return new Date(iso).toLocaleDateString(t.locale);
}

/** Human-readable byte size: "512 B", "8.0 KB", "1.4 MB", "3 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === "GB") {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}

/** Single-line preview of arbitrary text, for tiles and collapsed rows. */
export function truncate(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Render an unknown payload as readable text (pretty JSON when possible). */
export function stringifyPayload(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (parsed !== undefined && typeof parsed === "object") {
      return stringifyPayload(parsed);
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** JSON.parse that returns `undefined` instead of throwing. */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith('"')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The canonical credit-death sentence. Credit exhaustion is the one failure a
 * user can fix themselves — the copy must say what happened (no usable credit for this model),
 * what to do (add credits), and what is safe (nothing was lost). Crucially it
 * must NOT say "send a message to revive": a revive turn burns credits the
 * workspace no longer has.
 */
export const CREDIT_EXHAUSTION_MESSAGE = (t: OpenGeniText) =>
  t("lib.format.outOfCreditsThisWorkspace");

/** A usage ceiling refused the send; the default allowance wording, plus what is safe. */
export const COMPOSER_MEMBER_ALLOWANCE_MESSAGE = (t: OpenGeniText) =>
  t("lib.format.usageLimitReachedAWorkspace");
export const COMPOSER_WORKSPACE_ALLOWANCE_MESSAGE = (t: OpenGeniText) =>
  t("lib.format.workspaceUsageLimitReachedAn");

/**
 * Actionable composer copy for an edge rejection before a turn is accepted.
 * Unlike an in-flight credit exhaustion, this path has not consumed the
 * actor-private draft or any finalized attachment.
 */
export const COMPOSER_PAYMENT_REQUIRED_MESSAGE = (t: OpenGeniText) =>
  t("lib.format.yourOrganizationDoesnTHave");

/** Trusted, composer-owned guidance; unlike remote diagnostic prose, this is UI copy. */
export class ComposerStateError extends Error {}

/** A restored request has omitted credentials and must be reconciled, not replayed. */
export class ComposerReconciliationRequiredError extends ComposerStateError {
  constructor() {
    super(
      "Opengeni cannot safely retry this uncertain request after remount; reconcile the session before sending again.",
    );
  }
}

export class ComposerWorkspaceControlUnavailableError extends Error {
  constructor() {
    super("@opengeni/react: workspace-scoped resume requires setWorkspaceInferenceState.");
  }
}

/**
 * The send named a model that is no longer in the live catalog (retired or
 * removed). Retrying the same send cannot succeed; the person must choose
 * another model, and the typed message stays recoverable via Edit message.
 */
export const COMPOSER_MODEL_UNAVAILABLE_MESSAGE =
  "This chat's model is no longer available. Choose another model to continue. Your message is saved.";

/** `details.code` the API sets on a 422 for a model missing from the live catalog. */
export const MODEL_UNAVAILABLE_DETAIL_CODE = "model_unavailable";

/**
 * A fresh Send or Steer refused because the task's own usage limit is reached.
 * The draft is kept and an unchanged retry is never offered. The one current
 * recovery action (raise or remove the limit, resume a goal) belongs to the
 * composer's `SessionUsageLimitNotice`, so this line only says what happened.
 */
export const COMPOSER_SESSION_USAGE_LIMIT_MESSAGE =
  "This task's usage limit is reached. Your message is saved.";

/** The earlier wording, still recognized in refusals restored from storage. */
const LEGACY_COMPOSER_SESSION_USAGE_LIMIT_MESSAGE =
  "This task's usage limit is reached. Raise or remove the limit to continue. Your message is saved.";

/**
 * Is this send refusal the task's usage limit? Reads the typed SDK error code
 * (`OpenGeniSessionUsageLimitReachedError`), and also the composer's own
 * sentence so a refusal restored from storage after a reload is recognized.
 */
export function isSessionUsageLimitSubmissionError(error: Error): boolean {
  return (
    (error instanceof OpenGeniApiError && error.code === "session_usage_limit_reached") ||
    error.message === COMPOSER_SESSION_USAGE_LIMIT_MESSAGE ||
    error.message === LEGACY_COMPOSER_SESSION_USAGE_LIMIT_MESSAGE
  );
}

/**
 * Is this send refusal "the model is no longer available"? Reads the typed
 * `details.code`, and also the historical message so a refusal persisted
 * before a reload (only its text survives) or from an older API is recognized.
 */
export function isModelUnavailableSubmissionError(error: Error): boolean {
  if (error instanceof OpenGeniApiError && error.details?.code === MODEL_UNAVAILABLE_DETAIL_CODE) {
    return true;
  }
  return (
    error.message === COMPOSER_MODEL_UNAVAILABLE_MESSAGE ||
    /^(?:Opengeni|OpenGeni) API 422: model is not available: /.test(error.message)
  );
}

/**
 * What a published Site's assistant tells a viewer it refused, by the
 * refusal's `details.code`. The draft is kept in every case.
 */
export const COMPOSER_SITE_REFUSAL_MESSAGES = (t: OpenGeniText): Readonly<Record<string, string>> =>
  Object.freeze({
    not_available_for_viewer: t("lib.format.thisSiteSAssistantCan"),
    site_budget_exhausted: t("lib.format.thisSiteSAssistantHas"),
    site_budget_busy: t("lib.format.thisSiteSAssistantIs"),
    site_platform_brake_engaged: t("lib.format.thisSiteSAssistantIs2"),
  });

const SITE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "not_available_for_viewer",
  "site_budget_exhausted",
  "site_budget_busy",
  "site_platform_brake_engaged",
]);

/** The Site refusal code of a send refusal, if it is one. */
export function siteRefusalCode(error: Error): string | null {
  if (!(error instanceof OpenGeniApiError)) return null;
  const code = error.details?.code;
  return typeof code === "string" && SITE_REFUSAL_CODES.has(code) ? code : null;
}

export function composerSubmissionErrorMessage(t: OpenGeniText, error: Error): string {
  if (error instanceof ComposerReconciliationRequiredError) {
    return t("lib.format.reconcileBeforeRetry");
  }
  if (error instanceof ComposerWorkspaceControlUnavailableError) {
    return t("lib.format.thisClientCannotResumeThe");
  }
  if (error instanceof ComposerStateError) return error.message;
  if (error instanceof OpenGeniApiError && error.outcomeUnknown) return formatErrorMessage(error);
  if (isModelUnavailableSubmissionError(error)) return t("lib.format.modelUnavailable");
  if (isSessionUsageLimitSubmissionError(error)) return t("lib.format.sessionUsageLimitReached");
  const siteRefusal = siteRefusalCode(error);
  if (siteRefusal) return COMPOSER_SITE_REFUSAL_MESSAGES(t)[siteRefusal]!;
  if (error instanceof OpenGeniApiError && error.code === "allowance_exhausted") {
    // OpenGeniAllowanceExhaustedError carries the scope; read it structurally
    // so this startup-path helper adds no SDK or wording imports.
    const message =
      (error as { scope?: unknown }).scope === "workspace"
        ? COMPOSER_WORKSPACE_ALLOWANCE_MESSAGE(t)
        : COMPOSER_MEMBER_ALLOWANCE_MESSAGE(t);
    return composerErrorReference(t, error, message);
  }
  return isComposerCreditRefusal(error)
    ? composerErrorReference(t, error, COMPOSER_PAYMENT_REQUIRED_MESSAGE(t))
    : formatErrorMessage(error);
}

function composerErrorReference(t: OpenGeniText, error: Error, message: string): string {
  return error instanceof OpenGeniApiError && error.correlationId
    ? t("lib.format.messageReferenceCorrelationid", { message, correlationId: error.correlationId })
    : message;
}

/** These definitive refusals need a payment, allowance or model change, not an unchanged retry. */
export function composerSubmissionCanRetry(error: Error): boolean {
  return !(
    isComposerCreditRefusal(error) ||
    isModelUnavailableSubmissionError(error) ||
    isSessionUsageLimitSubmissionError(error) ||
    (error instanceof OpenGeniApiError && error.code === "allowance_exhausted") ||
    // Only a busy Site assistant is worth an unchanged retry.
    (siteRefusalCode(error) !== null && siteRefusalCode(error) !== "site_budget_busy")
  );
}

function isComposerCreditRefusal(error: Error): boolean {
  // A 402 for the task's own usage limit is not a credit or payment problem.
  if (isSessionUsageLimitSubmissionError(error)) return false;
  return (
    (error instanceof OpenGeniApiError &&
      error.status === 402 &&
      (error.code === "payment_required" || error.code === "insufficient_credits")) ||
    isCreditExhaustion(error.message)
  );
}

/**
 * Does this failure/completion payload (or raw error string) mean the
 * workspace ran out of Opengeni credits? Matches the engine's
 * "insufficient Opengeni credits" text (case-insensitive, substring — it
 * arrives both bare and wrapped in "Activity task failed: …") and the
 * budget-exhausted segment limit the engine stamps on a turn it ended early.
 */
export function isCreditExhaustion(
  input: { error?: string | null; detail?: string | null; segmentLimit?: string | null } | string,
): boolean {
  if (typeof input === "string") {
    return input.toLowerCase().includes("insufficient opengeni credits");
  }
  if (input.segmentLimit === "budget_exhausted") {
    return true;
  }
  for (const text of [input.error, input.detail]) {
    if (typeof text === "string" && text.toLowerCase().includes("insufficient opengeni credits")) {
      return true;
    }
  }
  return false;
}

/**
 * Humanize engine/provider failure text before it reaches the timeline or a
 * failure banner. Raw provider errors leak the wrong audience's instructions —
 * "Incorrect API key … find your API key at platform.openai.com" tells a
 * managed-deployment USER to fix credentials only an OPERATOR controls (and is
 * flatly wrong for Azure or subscription-backed engines). Auth, quota, and
 * credit-exhaustion failures collapse to one neutral, honest sentence; every
 * other reason passes through untouched. Raw payloads stay available in the
 * debug surfaces.
 */
export function humanizeFailureReason(t: OpenGeniText, reason: string | null): string | null {
  if (!reason) {
    return reason;
  }
  if (isCreditExhaustion(reason)) {
    return CREDIT_EXHAUSTION_MESSAGE(t);
  }
  // A turn refused because the chat's model was retired or removed.
  if (
    /^Turn execution policy model is (?:retired from new selection|not present in the configured catalog|no longer configured)$/.test(
      reason.trim(),
    )
  ) {
    return t("lib.format.modelUnavailable");
  }
  const normalized = reason.toLowerCase();
  const authFailure =
    normalized.includes("incorrect api key") ||
    normalized.includes("invalid api key") ||
    normalized.includes("invalid_api_key") ||
    normalized.includes("platform.openai.com/account/api-keys") ||
    (normalized.includes("401") &&
      (normalized.includes("api key") || normalized.includes("unauthorized")));
  if (authFailure) {
    return t("lib.format.theModelProviderRejectedThis");
  }
  const quotaFailure =
    normalized.includes("insufficient_quota") || normalized.includes("exceeded your current quota");
  if (quotaFailure) {
    return t("lib.format.theModelProviderRefusedThe");
  }
  return reason;
}

/** Project failure diagnostics without changing the stored event, including legacy retry wrappers. */
export function presentFailure(
  t: OpenGeniText,
  payload: Record<string, unknown>,
): {
  reason: string | null;
  safetyRefusal: boolean;
} {
  const databaseFailure =
    payload.code === "db_deadlock" ||
    payload.code === "db_serialization_failure" ||
    payload.code === "db_failure" ||
    (typeof payload.sqlState === "string" &&
      /^[0-9A-Z]{5}$/.test(payload.sqlState) &&
      payload.database !== null &&
      typeof payload.database === "object" &&
      !Array.isArray(payload.database));
  if (databaseFailure) {
    return { reason: t("lib.format.theServiceEncounteredADatabase"), safetyRefusal: false };
  }
  const text = (key: string): string | null => {
    const value = payload[key];
    return typeof value === "string" && value.trim() ? value : null;
  };
  const message = text("error") ?? text("message");
  const detail = text("lastRetryableError") ?? text("detail");
  const safetyRefusal =
    payload.code === "provider_safety_refusal" ||
    [message, detail].some(
      (value) =>
        value !== null && /\bthis request was blocked by our safety systems\b/i.test(value),
    );
  if (safetyRefusal) {
    return {
      reason:
        detail || message
          ? t("lib.format.providerBlockedRequestDetail", { detail: detail ?? message })
          : t("lib.format.providerBlockedRequest"),
      safetyRefusal: true,
    };
  }
  // Spent automatic retries: name the model and the remedy instead of the
  // recorded wrapper plus raw provider text (still in the stored event).
  const recovery = parseProviderRecovery(payload);
  if (recovery && payload.recoveryExhausted === true) {
    return { reason: providerRecoveryExhaustedText(t, recovery), safetyRefusal: false };
  }
  return {
    reason:
      detail && detail !== message
        ? [humanizeFailureReason(t, message), humanizeFailureReason(t, detail)]
            .filter(Boolean)
            .join(" ")
        : humanizeFailureReason(t, message),
    safetyRefusal: false,
  };
}

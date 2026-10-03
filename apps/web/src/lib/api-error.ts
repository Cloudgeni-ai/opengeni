import { modelDisplayName } from "@opengeni/sdk/model-display";
import type { ErrorDetail } from "@/components/ui/error-message";

/*
 * Errors from the Opengeni API arrive as "OpenGeni API 403: missing permission:
 * workspace:admin Reference: <uuid>." That string is for logs and support, not
 * for people (DESIGN.md section 6): the UI says what happened, then what to
 * do, and keeps the status, server message and reference behind "Technical
 * details". These helpers split an error into those parts.
 */

export interface ApiErrorFacts {
  /** HTTP status, when the error came from an API response. */
  status: number | undefined;
  /** Stable machine code from the response body, if any. */
  code: string | undefined;
  /** The request reference for support. */
  reference: string | undefined;
  /** The server's own sentence, without the status prefix or the reference. */
  serverMessage: string | undefined;
}

const API_PREFIX = /^(?:OpenGeni|Opengeni) API \d{3}:\s*/u;
const REFERENCE_SUFFIX = /\s*Reference:\s*([\w.:-]+?)\.?\s*$/u;

/** Splits an error into the facts it carries. Never throws. */
export function apiErrorFacts(error: unknown): ApiErrorFacts {
  const record =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const status = typeof record?.status === "number" ? record.status : undefined;
  const code = typeof record?.code === "string" && record.code ? record.code : undefined;
  let reference =
    typeof record?.correlationId === "string" && record.correlationId
      ? record.correlationId
      : undefined;
  let message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = REFERENCE_SUFFIX.exec(message);
  if (match) {
    reference ??= match[1];
    message = message.slice(0, match.index);
  }
  message = message.replace(API_PREFIX, "").trim();
  return { status, code, reference, serverMessage: message || undefined };
}

/** True for an error that came from an API response (or reads like one). */
export function isApiError(error: unknown): boolean {
  if (apiErrorFacts(error).status !== undefined) return true;
  return error instanceof Error && /^(?:OpenGeni|Opengeni) API\b/u.test(error.message);
}

/**
 * The viewer lacks a permission. Retrying can't help: say who can grant it
 * instead of showing an error.
 */
export function isPermissionDenied(error: unknown): boolean {
  const { status, serverMessage } = apiErrorFacts(error);
  if (status === 403) return true;
  return isApiError(error) && /\bmissing permission\b/iu.test(serverMessage ?? "");
}

const NETWORK_FAILURE =
  /failed to fetch|fetch failed|networkerror|load failed|network request failed/iu;

/**
 * A request that never got a response (offline, DNS, CORS). `fetch` rejects
 * with a TypeError for these, but so do input checks and plain bugs, so the
 * message decides.
 */
function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && NETWORK_FAILURE.test(error.message);
}

/** "model is not selectable: codex/gpt-6.1-sol" names the model, never its routing id. */
const MODEL_REFUSAL = /^model is not (?:selectable|available): (\S+)$/iu;

/** A server sentence that is safe to show: short, and not a JSON or schema dump. */
function readableServerSentence(message: string | undefined): string | undefined {
  const refusedModel = message ? MODEL_REFUSAL.exec(message.trim())?.[1] : undefined;
  if (refusedModel) {
    return `${modelDisplayName(refusedModel)} isn't available here. Choose another model.`;
  }
  if (!message || message.length > 160 || /^[[{]/u.test(message)) return undefined;
  // A bare code ("invalid_transaction") is not a sentence.
  if (!/\s/u.test(message.trim())) return undefined;
  if (/\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/u.test(message)) return undefined; // env vars, enums
  if (/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/u.test(message)) return undefined; // snake_case codes, fields
  const sentence = message.charAt(0).toLocaleUpperCase() + message.slice(1);
  return /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * What to do next, in one sentence. Pair it with a title that says what
 * happened ("Couldn't add the webhook").
 */
export function apiErrorAdvice(error: unknown): string {
  const { status, serverMessage } = apiErrorFacts(error);
  if (isPermissionDenied(error)) {
    return "You don't have permission to do this. Ask an admin for access.";
  }
  if (status === undefined) {
    if (isNetworkFailure(error) || !(error instanceof Error)) {
      return "Check your connection and try again.";
    }
    return "Try again. If it keeps happening, reload the page.";
  }
  if (status === 401) return "Your session ended. Sign in again, then try again.";
  if (status === 404) return "It may have been removed. Reload the page and try again.";
  if (status === 409 || status === 412) {
    // A 409 is often a real conflict ("name is already in use"): say which.
    return (
      readableServerSentence(serverMessage) ??
      "It changed since this page loaded. Reload the page and try again."
    );
  }
  if (status === 400 || status === 422) {
    return readableServerSentence(serverMessage) ?? "Check what you entered and try again.";
  }
  if (status === 429) return "Too many requests right now. Wait a moment and try again.";
  if (status >= 500) return "Opengeni couldn't finish the request. Try again in a moment.";
  return "Try again. If it keeps happening, reload the page.";
}

/**
 * The text to show for a failed action where only one line fits (a toast
 * description, a form error). API errors become advice, followed by the
 * request reference for support; an error the app wrote itself keeps its own
 * message. Next to Technical details (which already show the reference), use
 * `userErrorTextWithoutReference`.
 */
export function userErrorText(error: unknown, fallback?: string): string {
  const text = userErrorTextWithoutReference(error, fallback);
  if (!isApiError(error)) return text;
  const { reference } = apiErrorFacts(error);
  return reference ? `${text} Reference: ${reference}.` : text;
}

/**
 * `userErrorText` without the request reference, for places that show the
 * reference behind Technical details already (`apiErrorDetails`,
 * `apiErrorTechnicalFacts`).
 */
export function userErrorTextWithoutReference(error: unknown, fallback?: string): string {
  if (isApiError(error) || isNetworkFailure(error)) return apiErrorAdvice(error);
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback ?? "Something went wrong. Try again.";
}

/**
 * Props for `ErrorMessage`'s Technical details: the reference (with Copy),
 * then the status, code and the server's own message.
 */
export function apiErrorDetails(error: unknown): { reference?: string; details: ErrorDetail[] } {
  const { status, code, reference, serverMessage } = apiErrorFacts(error);
  const details: ErrorDetail[] = [];
  if (status !== undefined) details.push({ label: "Status", value: `HTTP ${status}` });
  if (code) details.push({ label: "Code", value: code });
  if (serverMessage) details.push({ label: "Message", value: serverMessage });
  return reference ? { reference, details } : { details };
}

/** Every Technical details fact of an error, the reference last with Copy. Empty for app errors. */
export function apiErrorTechnicalFacts(error: unknown): ErrorDetail[] {
  if (!isApiError(error)) return [];
  const { reference, details } = apiErrorDetails(error);
  return reference
    ? [...details, { label: "Reference", value: reference, copyable: true }]
    : details;
}

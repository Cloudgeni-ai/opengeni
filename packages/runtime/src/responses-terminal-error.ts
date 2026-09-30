const DIAGNOSTIC_MAX_BYTES = 4 * 1024;
const FIELD_MAX_BYTES = 256;
const TRUNCATION_MARKER = "… [truncated]";

function boundedField(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes - new TextEncoder().encode(TRUNCATION_MARKER).byteLength;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${new TextDecoder().decode(bytes.subarray(0, end))}${TRUNCATION_MARKER}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const SAFETY_CODES = new Set([
  "content_policy_violation",
  "content_filter",
  "contentpolicyviolation",
  "contentfilter",
  "responsibleaipolicyviolation",
  "safety_violation",
  "bio_policy",
  "cyber_policy",
]);
const REQUEST_CODES = new Set([
  "invalid_request",
  "invalid_request_error",
  "invalidrequest",
  "invalid_prompt",
  "context_length_exceeded",
  "invalid_argument",
]);
const RATE_CODES = new Set([
  "rate_limit_exceeded",
  "rate_limit_error",
  "rate_limited",
  "ratelimitexceeded",
  "too_many_requests",
  "429",
]);
const UNAVAILABLE_CODES = new Set([
  "server_error",
  "internal_server_error",
  "service_unavailable",
  "overloaded",
  "overloaded_error",
  "model_overloaded",
  "engine_overloaded",
  "server_overloaded",
]);

/**
 * An unsuccessful Responses terminal, intercepted before the Agents SDK
 * replaces its provider code/diagnostic with a generic ModelBehaviorError.
 * Only closed provider codes grant recovery; diagnostic wording does not.
 * The exception message is structural so SDK logs/traces cannot expose detail.
 */
export class ResponsesStreamingTerminalError extends Error {
  readonly code: string | undefined;
  readonly type: string | undefined;
  readonly detail: string;
  readonly headers: Headers;
  readonly retryAfterSeconds: number | undefined;
  readonly category: "safety" | "request" | "rate_limit" | "unavailable" | "unknown";

  constructor(
    readonly eventType: "response.failed" | "response.error" | "error",
    source: unknown,
    headers?: Headers,
  ) {
    super(`Responses request terminated unsuccessfully (${eventType}).`);
    this.name = "ResponsesStreamingTerminalError";
    const error = record(source);
    this.code = boundedField(error?.code, FIELD_MAX_BYTES);
    this.type = boundedField(error?.type, FIELD_MAX_BYTES);
    this.detail = boundedField(error?.message ?? source, DIAGNOSTIC_MAX_BYTES) ?? this.message;
    // Retain only the bounded retry header, never cookies or arbitrary provider
    // headers. Classification and durable recovery can use the same evidence.
    this.headers = new Headers();
    const retryAfter = boundedField(headers?.get("retry-after"), FIELD_MAX_BYTES);
    if (retryAfter !== undefined) this.headers.set("retry-after", retryAfter);
    const directSeconds = Number(error?.retry_after_seconds ?? error?.retryAfterSeconds);
    const header = this.headers.get("retry-after");
    const headerSeconds = header ? Number(header) : Number.NaN;
    const headerDate = header && !Number.isFinite(headerSeconds) ? Date.parse(header) : Number.NaN;
    const seconds = Number.isFinite(directSeconds)
      ? directSeconds
      : Number.isFinite(headerSeconds)
        ? headerSeconds
        : Number.isFinite(headerDate)
          ? Math.max(0, (headerDate - Date.now()) / 1_000)
          : Number.NaN;
    this.retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
    const codes = [this.code, this.type].map((value) => value?.toLowerCase());
    const matches = (allowed: Set<string>) =>
      codes.some((value) => value !== undefined && allowed.has(value));
    // Type-only envelopes may classify, but an explicit unknown code must not
    // gain retry authority from a broad server_error type. Refusal types veto.
    const recoveryCode = codes[0] || codes[1];
    this.category =
      matches(SAFETY_CODES) ||
      /\bthis request was blocked by our safety systems\b/i.test(this.detail)
        ? "safety"
        : matches(REQUEST_CODES)
          ? "request"
          : recoveryCode !== undefined && RATE_CODES.has(recoveryCode)
            ? "rate_limit"
            : recoveryCode !== undefined && UNAVAILABLE_CODES.has(recoveryCode)
              ? "unavailable"
              : "unknown";
  }
}

export function responsesStreamingTerminalError(
  event: unknown,
  headers?: Headers,
): ResponsesStreamingTerminalError | undefined {
  const value = record(event);
  if (
    value?.type !== "response.failed" &&
    value?.type !== "response.error" &&
    value?.type !== "error"
  ) {
    return undefined;
  }
  return new ResponsesStreamingTerminalError(
    value.type,
    value.error ?? record(value.response)?.error ?? value,
    headers,
  );
}

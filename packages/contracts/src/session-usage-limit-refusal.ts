/**
 * Browser/React Native-safe session usage limit helpers. Deliberately free of
 * the zod runtime so synchronous timeline projection can use it; contract
 * parity tests keep it aligned with `session-usage-limits.ts`.
 */

/** `turn.completed.segmentLimit` for a stop caused by a task usage limit. */
export const SESSION_USAGE_LIMIT_SEGMENT = "session_usage_limit" as const;
/** `SessionGoal.pausedReason` for a goal paused by a task usage limit. */
export const SESSION_USAGE_LIMIT_GOAL_PAUSED_REASON = "session_usage_limit" as const;

const BASIS = "model_api_equivalent_v1";
const MAX_LIMIT_MICROS = 10_000_000 * 1_000_000;
const MESSAGE_MAX_UTF8_BYTES = 1_024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedSessionUsageLimitReachedRefusal = {
  code: "session_usage_limit_reached";
  basis: "model_api_equivalent_v1";
  rootSessionId: string;
  limitMicros: number;
  usedMicros: number;
  message: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function micros(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function boundedMessage(value: string): string {
  const normalized = value
    .slice(0, MESSAGE_MAX_UTF8_BYTES * 2)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  const bytes = new TextEncoder().encode(normalized);
  let end = Math.min(bytes.length, MESSAGE_MAX_UTF8_BYTES);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end)).trim();
}

/**
 * Select only the public refusal fields from an API error body (fields may sit
 * in `details`), a `turn.completed` payload's `sessionUsageLimit` record, or a
 * refusal object. Anything malformed returns null instead of a guessed amount.
 */
export function parseSessionUsageLimitReachedRefusal(
  value: unknown,
): ParsedSessionUsageLimitReachedRefusal | null {
  const outer = record(value);
  if (!outer) return null;
  const source = record(outer.sessionUsageLimit) ?? outer;
  if (source.code !== "session_usage_limit_reached") return null;
  const fields = record(source.details) ?? source;
  if (
    fields.basis !== BASIS ||
    typeof fields.rootSessionId !== "string" ||
    !UUID.test(fields.rootSessionId) ||
    !micros(fields.limitMicros, MAX_LIMIT_MICROS) ||
    !micros(fields.usedMicros)
  ) {
    return null;
  }
  const refusal = {
    code: "session_usage_limit_reached" as const,
    basis: BASIS as "model_api_equivalent_v1",
    rootSessionId: fields.rootSessionId.toLowerCase(),
    limitMicros: fields.limitMicros,
    usedMicros: fields.usedMicros,
    message: "",
  };
  const message = typeof source.message === "string" ? boundedMessage(source.message) : "";
  return { ...refusal, message: message || sessionUsageLimitReachedMessage(refusal) };
}

/**
 * "$12.34" for known amounts, "<$0.01" for a positive amount under a cent.
 * Callers must not pass unknown usage: render "Preparing usage" or
 * "Usage unavailable" instead of a dollar figure.
 */
export function formatSessionUsageMicros(value: number): string {
  if (value > 0 && value < 10_000) return "<$0.01";
  const dollars = value / 1_000_000;
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Fixed, bounded wording: no reset date, purchase remedy or invoice claim. */
export function sessionUsageLimitReachedMessage(refusal: {
  limitMicros: number;
  usedMicros: number;
}): string {
  return `This task's usage limit is reached (${formatSessionUsageMicros(refusal.usedMicros)} of ${formatSessionUsageMicros(refusal.limitMicros)} API-equivalent model usage). A person can raise or remove the limit to continue.`;
}

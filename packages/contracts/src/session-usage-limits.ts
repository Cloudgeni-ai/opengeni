import { z } from "zod";

/**
 * Per-task (root session) usage limits.
 *
 * One optional limit belongs to a root session and is shared by every
 * descendant. It is measured in integer USD micros ($1 = 1,000,000) of the
 * canonical pre-margin API-equivalent model cost (`estimatedProviderCostMicros`)
 * recorded when a model response settles, whatever funds the call (Opengeni
 * credits, a connected subscription or a workspace-owned key).
 *
 * The limit is checked before each new model request; it is not a reservation.
 * Requests already admitted may finish and take recorded usage above the
 * limit, and concurrently admitted requests may overshoot together. Usage
 * without a known price is excluded from the total and disclosed as partial
 * coverage instead of being valued at zero. It is not an invoice cap.
 */

/** Versioned measurement basis, exposed so a future basis cannot be confused with this one. */
export const SESSION_USAGE_LIMIT_BASIS = "model_api_equivalent_v1" as const;
export const SessionUsageLimitBasis = z.literal(SESSION_USAGE_LIMIT_BASIS);
export type SessionUsageLimitBasis = z.infer<typeof SessionUsageLimitBasis>;

export const SESSION_USAGE_LIMIT_MICROS_PER_DOLLAR = 1_000_000;
/** $10M: the largest configurable limit, far inside safe integers. Usage itself is never clamped. */
export const SESSION_USAGE_LIMIT_MAX_MICROS = 10_000_000 * SESSION_USAGE_LIMIT_MICROS_PER_DOLLAR;

/** A configured limit. Zero is a valid immediate stop; `null` (not this schema) means no limit. */
export const SessionUsageLimitMicros = z
  .number()
  .int()
  .nonnegative()
  .safe()
  .max(SESSION_USAGE_LIMIT_MAX_MICROS);
export type SessionUsageLimitMicros = z.infer<typeof SessionUsageLimitMicros>;

/** Recorded usage is a non-negative safe integer and may exceed the configured maximum. */
const UsageMicros = z.number().int().nonnegative().safe();
const Count = z.number().int().nonnegative().safe();
const Version = z.number().int().nonnegative().safe();

const OperationId = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      !value.includes("\0") &&
      !/[\uD800-\uDFFF]/u.test(value) &&
      new TextEncoder().encode(value).byteLength <= 256,
  );

/**
 * - `unlimited`: no limit is configured; usage is still recorded.
 * - `within`: a limit is configured and recorded usage is below it.
 * - `reached`: recorded usage is at or above the limit; new model requests are refused.
 * - `preparing`: historical usage for a task created before this feature is
 *   still being imported; the total is not yet meaningful and a new limit
 *   cannot be set until it finishes.
 * - `unavailable`: the usage state could not be read. Never treat it as zero or unlimited.
 */
export const SessionUsageLimitStatus = z.enum([
  "unlimited",
  "within",
  "reached",
  "preparing",
  "unavailable",
]);
export type SessionUsageLimitStatus = z.infer<typeof SessionUsageLimitStatus>;

/**
 * `complete`: every recorded model response of this task was metered live.
 * `legacy_partial`: the task predates usage limits; available historical cost
 * snapshots were imported, but older usage may be missing. This never upgrades
 * to complete, because a missing old record is not proof of no usage.
 * `preparing`: the historical import has not finished.
 */
export const SessionUsageLimitHistory = z.enum(["complete", "legacy_partial", "preparing"]);
export type SessionUsageLimitHistory = z.infer<typeof SessionUsageLimitHistory>;

export const SessionUsageLimit = z
  .object({
    basis: SessionUsageLimitBasis,
    /** The task root whose limit applies. Equal to the session id for a root. */
    rootSessionId: z.string().uuid(),
    /** True when this projection was read through a descendant: edit the root's limit instead. */
    inherited: z.boolean(),
    status: SessionUsageLimitStatus,
    /** Configured limit; null means no limit. Meaningless while `status` is `unavailable`. */
    limitMicros: SessionUsageLimitMicros.nullable(),
    /**
     * Recorded known (priced or known-free) usage of the whole task tree, in USD
     * micros. Null while `preparing` or `unavailable`: never render it as $0.
     * May exceed `limitMicros`.
     */
    usedMicros: UsageMicros.nullable(),
    /** Configuration version for compare-and-set writes. Survives clearing. */
    version: Version,
    /** Monotonic usage revision; increases whenever a usage receipt changes the total or coverage. */
    usageRevision: Version,
    history: SessionUsageLimitHistory,
    /** `partial` when any usage has unknown cost or history is legacy/preparing: show "at least". */
    coverage: z.enum(["complete", "partial"]),
    pricedCalls: Count,
    /** Responses with a known price of zero; they count as zero, unlike unpriced usage. */
    freeCalls: Count,
    /** Responses whose cost is unknown; they are excluded from `usedMicros`. */
    unpricedCalls: Count,
    updatedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type SessionUsageLimit = z.infer<typeof SessionUsageLimit>;

/**
 * Compare-and-set write of a root task's limit. `expectedVersion` is the
 * `version` the caller last read; a stale version returns 409. A replay of the
 * same `operationId` with the same request returns the committed result.
 */
export const SetSessionUsageLimitRequest = z
  .object({
    limitMicros: SessionUsageLimitMicros.nullable(),
    expectedVersion: Version,
    operationId: OperationId,
  })
  .strict();
export type SetSessionUsageLimitRequest = z.infer<typeof SetSessionUsageLimitRequest>;

/** Typed refusal for a fresh model request, message or goal resume after the limit is reached. */
export const SessionUsageLimitReachedRefusal = z
  .object({
    code: z.literal("session_usage_limit_reached"),
    basis: SessionUsageLimitBasis,
    rootSessionId: z.string().uuid(),
    limitMicros: SessionUsageLimitMicros,
    usedMicros: UsageMicros,
    message: z.string().max(1_024),
  })
  .strict();
export type SessionUsageLimitReachedRefusal = z.infer<typeof SessionUsageLimitReachedRefusal>;

/** Typed error codes for the usage-limit routes. */
export const SessionUsageLimitErrorCode = z.enum([
  "session_usage_limit_reached",
  "session_usage_limit_conflict",
  "session_usage_limit_not_root",
  "session_usage_limit_preparing",
  "session_usage_limit_unavailable",
  "session_usage_limit_disabled",
  "session_usage_limit_forbidden",
]);
export type SessionUsageLimitErrorCode = z.infer<typeof SessionUsageLimitErrorCode>;

/** The durable event appended to a root's stream when an authorized person changes its limit. */
export const SessionUsageLimitUpdatedPayload = z
  .object({
    basis: SessionUsageLimitBasis,
    limitMicros: SessionUsageLimitMicros.nullable(),
    previousLimitMicros: SessionUsageLimitMicros.nullable(),
    version: Version,
  })
  .strict();
export type SessionUsageLimitUpdatedPayload = z.infer<typeof SessionUsageLimitUpdatedPayload>;

export {
  formatSessionUsageMicros,
  parseSessionUsageLimitReachedRefusal,
  SESSION_USAGE_LIMIT_SEGMENT,
  SESSION_USAGE_LIMIT_GOAL_PAUSED_REASON,
  sessionUsageLimitReachedMessage,
} from "./session-usage-limit-refusal";

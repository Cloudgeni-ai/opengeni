import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const ClaudeUsageWindowId = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "five_hour",
    "seven_day",
    "seven_day_opus",
    "seven_day_sonnet",
    // The separate weekly Fable limit (Claude Max and Ultra, Oct 2026).
    "seven_day_fable",
    "seven_day_overage_included",
    "overage",
  ]),
);
export const ClaudeUsageWindow = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: ClaudeUsageWindowId,
      usedPercent: z.number().finite().nonnegative().nullable(),
      resetsAt: z.string().datetime().nullable(),
      status: z.enum(["allowed", "allowed_warning", "rejected"]).nullable(),
      observedAt: primitives.dateTime,
      source: z.enum(["response_headers", "provider"]).optional(),
    })
    .strict(),
);
export type ClaudeUsageWindow = z.infer<typeof ClaudeUsageWindow>;

/** One response's dispatch authority; never combine statuses from different responses. */
export const ClaudeUsageRequestStatus = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      status: z.enum(["allowed", "allowed_warning", "rejected"]).nullable(),
      resetsAt: z.string().datetime().nullable(),
      representativeClaim: ClaudeUsageWindowId.nullable(),
      overageStatus: z.enum(["allowed", "allowed_warning", "rejected"]).nullable(),
      overageResetsAt: z.string().datetime().nullable(),
      upstreamModelId: z.string().min(1).max(256).nullable(),
      observedAt: primitives.dateTime,
      source: z.enum(["response_headers", "provider"]).optional(),
    })
    .strict(),
);
export type ClaudeUsageRequestStatus = z.infer<typeof ClaudeUsageRequestStatus>;

const ProviderToken = /* @__PURE__ */ defineSchema(() => z.string().min(1).max(64));
const ProviderTokens = /* @__PURE__ */ defineSchema(() => z.array(ProviderToken).max(16));

/**
 * One limit reset grant Claude offers the account (the provider's
 * `cedar_ember` program, as Claude Code reads it). Claiming one clears the
 * limits in `clears` (`givesBackWeekly` also gives back what it spent of
 * the weekly limit). `usableNow` false comes with `unavailableReason` and
 * the limits in `blocking` that keep it from being used now.
 */
export const ClaudeLimitResetGrant = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
      label: z.string().max(300).nullable(),
      /** `session`, `weekly` or `full`, as the provider reports it; null when absent. */
      type: ProviderToken.nullable(),
      /** What the grant gives back, the way Claude Code names it. */
      kind: z.enum(["session", "weekly", "full", "fable"]),
      resetsTotal: z.number().int().nonnegative().nullable(),
      resetsLeft: z.number().int().nonnegative().nullable(),
      startsAt: z.string().datetime().nullable(),
      endsAt: z.string().datetime().nullable(),
      clears: ProviderTokens,
      paused: primitives.boolean,
      usableNow: primitives.boolean,
      useRequiresLimit: primitives.boolean,
      givesBackWeekly: primitives.boolean,
      percentUsed: z.record(ProviderToken, z.number().finite().nonnegative()),
      blocking: ProviderTokens,
      unavailableReason: ProviderToken.nullable(),
    })
    .strict(),
);
export type ClaudeLimitResetGrant = z.infer<typeof ClaudeLimitResetGrant>;

/** The account's limit reset status (the provider's `cedar_ember` block). */
export const ClaudeLimitResets = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      eligible: primitives.boolean,
      /** Why not eligible (`surface`, `tier`, `no_grant`, ...); null when eligible. */
      ineligibleReason: ProviderToken.nullable(),
      atLimit: primitives.boolean,
      exhausted: ProviderTokens,
      grants: z.array(ClaudeLimitResetGrant).max(32),
      nextGrantId: z.string().max(40).nullable(),
      weeklyResetsAt: z.string().datetime().nullable(),
      cooldownUntil: z.string().datetime().nullable(),
      observedAt: primitives.dateTime,
    })
    .strict(),
);
export type ClaudeLimitResets = z.infer<typeof ClaudeLimitResets>;

/** The at-the-limit reset program (the provider's `juniper_tide` block). */
export const ClaudeWallReset = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      eligible: primitives.boolean,
      ineligibleReason: ProviderToken.nullable(),
      inExperiment: primitives.boolean,
      available: primitives.boolean,
      nextAvailableAt: z.string().datetime().nullable(),
      weeklyResetsAt: z.string().datetime().nullable(),
      resetsPerWeek: z.number().int().nonnegative().nullable(),
      observedAt: primitives.dateTime,
    })
    .strict(),
);
export type ClaudeWallReset = z.infer<typeof ClaudeWallReset>;

/** One entry of the usage endpoint's `limits` list. */
export const ClaudeUsageLimit = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** `session`, `weekly_all`, `weekly_scoped`, ... */
      kind: ProviderToken,
      group: ProviderToken.nullable(),
      percent: z.number().finite().nonnegative().nullable(),
      severity: ProviderToken.nullable(),
      resetsAt: z.string().datetime().nullable(),
      /** The model a scoped limit applies to, by its display name (for example `Fable`). */
      modelName: z.string().max(100).nullable(),
      modelId: z.string().max(200).nullable(),
      surface: ProviderToken.nullable(),
      isActive: primitives.boolean,
      /** A scoped limit's allowance and use as shares of the weekly limit (`weekly_scoped_shares`). */
      allowancePercentOfWeekly: z.number().finite().nonnegative().nullable(),
      usedPercentOfWeekly: z.number().finite().nonnegative().nullable(),
    })
    .strict(),
);
export type ClaudeUsageLimit = z.infer<typeof ClaudeUsageLimit>;

/** The account's paid extra usage, when the provider reports it. */
export const ClaudeExtraUsage = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      isEnabled: primitives.boolean.nullable(),
      monthlyLimit: z.number().finite().nullable(),
      usedCredits: z.number().finite().nullable(),
      utilization: z.number().finite().nonnegative().nullable(),
      currency: z.string().max(16).nullable(),
      disabledReason: ProviderToken.nullable(),
    })
    .strict(),
);
export type ClaudeExtraUsage = z.infer<typeof ClaudeExtraUsage>;

/**
 * Weekly limits of other Claude surfaces (cowork, apps). Shown for
 * information; they never decide whether Opengeni's requests may run.
 */
export const ClaudeSurfaceUsageWindow = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: z.enum(["seven_day_cowork", "seven_day_omelette", "seven_day_oauth_apps"]),
      usedPercent: z.number().finite().nonnegative().nullable(),
      resetsAt: z.string().datetime().nullable(),
    })
    .strict(),
);
export type ClaudeSurfaceUsageWindow = z.infer<typeof ClaudeSurfaceUsageWindow>;

/**
 * Service state from the newest model response's rate-limit headers: what
 * the provider offers past the plan limits. The slow tier and grace keep a
 * connection serving at reduced service: neither is exhaustion, neither is
 * plain availability.
 */
export const ClaudeServiceState = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      observedAt: primitives.dateTime,
      fallbackAvailable: primitives.boolean.nullable(),
      fallbackPercentage: z.number().finite().nonnegative().nullable(),
      overageDisabledReason: ProviderToken.nullable(),
      overageInUse: primitives.boolean.nullable(),
      overageDailyCapPaused: primitives.boolean.nullable(),
      overageScope: ProviderToken.nullable(),
      upgradePaths: ProviderTokens,
      /** The warning threshold each window passed (0-1, for example 0.75). */
      surpassedThresholds: z
        .array(
          z
            .object({
              windowId: z.enum(["five_hour", "seven_day", "seven_day_overage_included", "overage"]),
              threshold: z.number().finite().nonnegative(),
            })
            .strict(),
        )
        .max(4),
      retryAfterSeconds: z.number().finite().nonnegative().nullable(),
      slow: z
        .object({
          /** `active`, `not_needed`, `slot_busy`, `weekly_limit`, `budget_exhausted`, `ineligible`, `off` or `unrecognized`. */
          status: ProviderToken.nullable(),
          offer: ProviderToken.nullable(),
          retryAfterSeconds: z.number().finite().nonnegative().nullable(),
          maxWaitSeconds: z.number().finite().nonnegative().nullable(),
          budgetUtilization: z.number().finite().nonnegative().nullable(),
          budgetResetsAt: z.string().datetime().nullable(),
        })
        .strict()
        .nullable(),
      grace: z
        .object({
          fiveHourUtilization: z.number().finite().nonnegative().nullable(),
          sevenDayUtilization: z.number().finite().nonnegative().nullable(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
);
export type ClaudeServiceState = z.infer<typeof ClaudeServiceState>;

/** Provider observations, never an estimate based on Opengeni token counts. */
export const ClaudeSubscriptionUsage = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      connected: primitives.boolean,
      credentialVersion: z.number().int().positive().nullable(),
      windows: z.array(ClaudeUsageWindow).max(7),
      observedAt: z.string().datetime().nullable(),
      source: z.enum(["response_headers", "provider"]).nullable(),
      refreshStatus: z.enum([
        "not_checked",
        "available",
        "scope_required",
        "unavailable",
        "reconnect",
      ]),
      refreshCheckedAt: z.string().datetime().nullable(),
      requestStatus: ClaudeUsageRequestStatus.nullable().optional(),
      // Model-scoped dispatch evidence; allowances retain an ordering watermark.
      requestRestrictions: z.array(ClaudeUsageRequestStatus).max(64).optional(),
      /** Limit reset grants (absent: not read yet). */
      limitResets: ClaudeLimitResets.nullable().optional(),
      /** The at-the-limit reset program, read only while the account is at a limit. */
      wallReset: ClaudeWallReset.nullable().optional(),
      /** The usage endpoint's limit list, with each scoped limit's share of the weekly limit. */
      limits: z.array(ClaudeUsageLimit).max(16).optional(),
      /** Paid extra usage; null when the provider reports none. */
      extraUsage: ClaudeExtraUsage.nullable().optional(),
      surfaceWindows: z.array(ClaudeSurfaceUsageWindow).max(3).optional(),
      serviceState: ClaudeServiceState.nullable().optional(),
    })
    .strict(),
);
export type ClaudeSubscriptionUsage = z.infer<typeof ClaudeSubscriptionUsage>;

/**
 * The provider's answer to a limit reset claim. `reset` cleared the limits
 * in `cleared`; `already_used`, `not_limited`, `cooldown`, `ineligible` and
 * `unavailable` used nothing new (`reason` says why). `rate_limited`,
 * `auth_error` and `error` mean the provider settled nothing. Whenever
 * `retryable` is true, retry with the same request id: the provider settles
 * each request id once, so a retry can never use a second reset.
 */
export const ClaudeLimitResetClaimResult = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "reset",
    "already_used",
    "not_limited",
    "cooldown",
    "ineligible",
    "unavailable",
    "rate_limited",
    "auth_error",
    "error",
  ]),
);
export type ClaudeLimitResetClaimResult = z.infer<typeof ClaudeLimitResetClaimResult>;

/** One claim's provider answer, without the refreshed usage. */
export const ClaudeLimitResetClaim = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      result: ClaudeLimitResetClaimResult,
      reason: ProviderToken.nullable(),
      resetsLeft: z.number().int().nonnegative().nullable(),
      cleared: ProviderTokens,
      weeklyResetsAt: z.string().datetime().nullable(),
      cooldownUntil: z.string().datetime().nullable(),
      /** True when the claim was not settled: retry with the same request id. */
      retryable: primitives.boolean,
    })
    .strict(),
);
export type ClaudeLimitResetClaim = z.infer<typeof ClaudeLimitResetClaim>;

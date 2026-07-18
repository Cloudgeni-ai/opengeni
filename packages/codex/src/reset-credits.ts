// Exact Codex rust-v0.144.6 rate-limit-reset-credit protocol normalization.
// Provenance: stable commit 5d1fbf26c43abc65a203928b2e31561cb039e06d;
// protocol-bearing files are byte-identical from rust-v0.144.1 through v0.144.6.
//
// Upstream sources (stable tag target 5d1fbf26c43abc65a203928b2e31561cb039e06d):
// - codex-rs/backend-client/src/types.rs
// - codex-rs/backend-client/src/client/rate_limit_resets.rs
// - codex-rs/app-server-protocol/src/protocol/v2/account.rs
//
// The backend wire is snake_case. Public OpenGeni callers only receive the
// normalized camelCase types below. Unknown reset types/statuses remain visible
// but fail closed as `unknown`; they are never made actionable by this parser.

import * as z from "zod/v4";

export const CODEX_RATE_LIMIT_RESET_OUTCOMES = [
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
] as const;

export type CodexRateLimitResetOutcome = (typeof CODEX_RATE_LIMIT_RESET_OUTCOMES)[number];
export type CodexRateLimitResetType = "codexRateLimits" | "unknown";
export type CodexRateLimitResetCreditStatus = "available" | "redeeming" | "redeemed" | "unknown";

export type CodexRateLimitResetCredit = {
  id: string;
  resetType: CodexRateLimitResetType;
  status: CodexRateLimitResetCreditStatus;
  /** Unix seconds, matching account/rateLimits/read in Codex v0.144.6. */
  grantedAt: number;
  /** Unix seconds, or null when the provider says the credit does not expire. */
  expiresAt: number | null;
  title: string | null;
  description: string | null;
};

export type CodexRateLimitResetCreditsDetails = {
  availableCount: number;
  credits: CodexRateLimitResetCredit[];
};

export type CodexRateLimitResetCreditsSummary = {
  availableCount: number;
  /** null means the provider supplied an authoritative count but no detail rows. */
  credits: null;
};

export type CodexRateLimitResetConsumeResponse = {
  outcome: CodexRateLimitResetOutcome;
};

const nonNegativeInteger = z.number().int().nonnegative();
const backendTimestamp = z.string().datetime({ offset: true });

const backendCreditSchema = z
  .object({
    id: z.string().min(1),
    reset_type: z.string().min(1),
    status: z.string().min(1),
    granted_at: backendTimestamp,
    expires_at: backendTimestamp.nullish(),
    title: z.string().nullish(),
    description: z.string().nullish(),
  })
  .passthrough();

const backendDetailsSchema = z
  .object({
    credits: z.array(backendCreditSchema),
    available_count: nonNegativeInteger,
  })
  .passthrough();

const backendUsageSummarySchema = z
  .object({
    rate_limit_reset_credits: z
      .object({ available_count: nonNegativeInteger })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const backendConsumeOutcomes = [
  "reset",
  "nothing_to_reset",
  "no_credit",
  "already_redeemed",
] as const;

const backendConsumeSchema = z
  .object({
    code: z.enum(backendConsumeOutcomes),
    // The app-server intentionally discards this field. OpenGeni also refetches
    // rather than inferring post-redemption state from it.
    windows_reset: nonNegativeInteger.default(0),
  })
  .passthrough();

function normalizedResetType(value: string): CodexRateLimitResetType {
  return value === "codex_rate_limits" ? "codexRateLimits" : "unknown";
}

function normalizedCreditStatus(value: string): CodexRateLimitResetCreditStatus {
  if (value === "available" || value === "redeeming" || value === "redeemed") {
    return value;
  }
  return "unknown";
}

/** Parse the exact detailed-credit backend response. Unknown rows stay view-only. */
export function parseCodexRateLimitResetCreditsDetails(
  payload: unknown,
): CodexRateLimitResetCreditsDetails | null {
  const parsed = backendDetailsSchema.safeParse(payload);
  if (!parsed.success) return null;
  return {
    availableCount: parsed.data.available_count,
    credits: parsed.data.credits.map((credit) => ({
      id: credit.id,
      resetType: normalizedResetType(credit.reset_type),
      status: normalizedCreditStatus(credit.status),
      grantedAt: Math.floor(Date.parse(credit.granted_at) / 1000),
      expiresAt:
        credit.expires_at == null ? null : Math.floor(Date.parse(credit.expires_at) / 1000),
      title: credit.title ?? null,
      description: credit.description ?? null,
    })),
  };
}

/** Parse the count-only summary carried by GET /wham/usage. */
export function parseCodexRateLimitResetCreditsSummary(
  payload: unknown,
): CodexRateLimitResetCreditsSummary | null {
  const parsed = backendUsageSummarySchema.safeParse(payload);
  const availableCount = parsed.success
    ? parsed.data.rate_limit_reset_credits?.available_count
    : undefined;
  return availableCount === undefined ? null : { availableCount, credits: null };
}

/** Parse one of the exact four v0.144.6 consume outcomes. Unknowns fail closed. */
export function parseCodexRateLimitResetConsumeResponse(
  payload: unknown,
): CodexRateLimitResetConsumeResponse | null {
  const parsed = backendConsumeSchema.safeParse(payload);
  if (!parsed.success) return null;
  const outcomes: Record<(typeof backendConsumeOutcomes)[number], CodexRateLimitResetOutcome> = {
    reset: "reset",
    nothing_to_reset: "nothingToReset",
    no_credit: "noCredit",
    already_redeemed: "alreadyRedeemed",
  };
  return { outcome: outcomes[parsed.data.code] };
}

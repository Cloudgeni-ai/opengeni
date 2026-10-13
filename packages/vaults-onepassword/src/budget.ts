import { type ProviderCallBudget, VaultProviderError } from "./contract";

export type OnePasswordPlanTier = "family" | "teams" | "business";
export type ProviderCallOp = Parameters<ProviderCallBudget["take"]>[0];

/**
 * HTTP requests each SDK operation makes against 1Password, measured live with
 * @1password/sdk 0.5.0 (evidence/w5/README.md). The daily account quota counts
 * requests, not SDK calls, so the connection quota is charged these weights.
 */
export const ONEPASSWORD_REQUEST_COST = {
  signIn: 4,
  vaultsList: 1,
  itemsList: 1,
  itemsGetAll: 1,
  itemsGet: 1,
  filesRead: 1,
  itemsCreate: 2,
  itemsPut: 4,
  itemsArchive: 3,
  itemsDelete: 3,
  vaultsCreate: 9,
  grantGroupPermissions: 2,
  vaultsDelete: 2,
} as const;
export type OnePasswordOperation = keyof typeof ONEPASSWORD_REQUEST_COST;

/**
 * Service-account limits by plan (developer.1password.com/docs/service-accounts/rate-limits):
 * the daily request cap is shared by every service account in the 1Password
 * account; the hourly read/write caps apply per token.
 */
export const ONEPASSWORD_PLAN_LIMITS: Record<
  OnePasswordPlanTier,
  { dailyRequests: number; hourlyReads: number; hourlyWrites: number }
> = {
  family: { dailyRequests: 1_000, hourlyReads: 1_000, hourlyWrites: 100 },
  teams: { dailyRequests: 5_000, hourlyReads: 1_000, hourlyWrites: 100 },
  business: { dailyRequests: 50_000, hourlyReads: 10_000, hourlyWrites: 1_000 },
};

/** Fraction of the daily account quota OpenGeni may burst through at once. */
const DAILY_BURST_FRACTION = 0.25;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type Clock = () => number;

class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  constructor(
    readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: Clock,
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }
  private refill() {
    const at = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (at - this.updatedAt) * this.refillPerMs);
    this.updatedAt = at;
  }
  /** Milliseconds until `cost` tokens are available (0 when available now). */
  waitMs(cost: number): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    return Math.ceil((cost - this.tokens) / this.refillPerMs);
  }
  take(cost: number) {
    this.refill();
    this.tokens -= cost;
  }
  get available() {
    this.refill();
    return this.tokens;
  }
}

/**
 * Per-connection quota guard. One instance per (connection, plan) lives for the
 * process; it fails fast instead of spending the customer's shared daily quota,
 * and stays closed until `blockedUntil` after a real 429 from 1Password.
 */
export class OnePasswordQuota {
  private readonly daily: TokenBucket;
  private readonly reads: TokenBucket;
  private readonly writes: TokenBucket;
  private blockedUntilMs = 0;
  constructor(
    readonly planTier: OnePasswordPlanTier,
    private readonly now: Clock = Date.now,
  ) {
    const limits = ONEPASSWORD_PLAN_LIMITS[planTier];
    this.daily = new TokenBucket(
      Math.max(1, Math.floor(limits.dailyRequests * DAILY_BURST_FRACTION)),
      limits.dailyRequests / DAY_MS,
      now,
    );
    this.reads = new TokenBucket(limits.hourlyReads, limits.hourlyReads / HOUR_MS, now);
    this.writes = new TokenBucket(limits.hourlyWrites, limits.hourlyWrites / HOUR_MS, now);
  }

  get blockedUntil(): Date | null {
    return this.blockedUntilMs > this.now() ? new Date(this.blockedUntilMs) : null;
  }

  /** Record a real 429 so every later call in this process fails fast. */
  block(retryAfterMs: number) {
    this.blockedUntilMs = Math.max(this.blockedUntilMs, this.now() + retryAfterMs);
  }

  take(op: ProviderCallOp, cost = 1) {
    const now = this.now();
    if (this.blockedUntilMs > now) {
      throw new VaultProviderError(
        "provider_rate_limited",
        "1Password is rate limiting this connection; try again later",
        this.blockedUntilMs - now,
      );
    }
    const lane = op === "write" ? this.writes : this.reads;
    const waitMs = Math.max(this.daily.waitMs(cost), lane.waitMs(cost));
    if (waitMs > 0) {
      throw new VaultProviderError(
        "provider_rate_limited",
        `OpenGeni paused 1Password calls to stay inside the ${this.planTier} plan quota`,
        waitMs,
      );
    }
    this.daily.take(cost);
    lane.take(cost);
  }

  /** Remaining daily burst, for diagnostics and tests. */
  get remainingDaily(): number {
    return Math.floor(this.daily.available);
  }
}

const quotas = new Map<string, OnePasswordQuota>();

/** Process-wide quota for one connection (or token fingerprint). */
export function onePasswordQuotaFor(
  key: string,
  planTier: OnePasswordPlanTier,
  now?: Clock,
): OnePasswordQuota {
  const existing = quotas.get(key);
  if (existing && existing.planTier === planTier) return existing;
  const quota = new OnePasswordQuota(planTier, now);
  const blockedUntil = existing?.blockedUntil;
  if (blockedUntil) quota.block(blockedUntil.getTime() - Date.now());
  quotas.set(key, quota);
  return quota;
}

export function resetOnePasswordQuotasForTests() {
  quotas.clear();
}

/** design §10.9 / VAULT_LIMITS.providerReadsPerAttempt */
export const PROVIDER_READS_PER_ATTEMPT = 50;

/**
 * Attempt-scoped budget: at most `reads` provider reads (list + read) per agent
 * attempt. Writes and admin calls are explicit user/agent actions and are only
 * bounded by the connection quota.
 */
export function createAttemptProviderBudget(
  options: { reads?: number } = {},
): ProviderCallBudget & { readonly used: number } {
  const limit = options.reads ?? PROVIDER_READS_PER_ATTEMPT;
  let used = 0;
  return {
    get used() {
      return used;
    },
    take(op) {
      if (op === "write" || op === "admin") return;
      if (used >= limit) {
        throw new VaultProviderError(
          "provider_rate_limited",
          `This task already made ${limit} password-manager reads; reuse values already fetched or continue in a new turn`,
        );
      }
      used += 1;
    },
  };
}

/** Budget that never refuses (human-initiated install/link/sync routes). */
export const unlimitedProviderBudget: ProviderCallBudget = { take() {} };

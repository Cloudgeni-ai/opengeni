import { CODEX_CREDENTIAL_LEASE_TTL_MS } from "@opengeni/db";
import type { WaitReason } from "@opengeni/subscriptions";

/*
 * Failures of a chat turn on the shared subscription core, for any provider.
 * The codes are provider-neutral; the copy names the provider, and every
 * builder defaults to Codex, so Codex callers and texts are unchanged (M3
 * shipped these as Codex failures). Other providers pass their display name.
 */

/** The provider name in failure copy when a caller passes none (M3's Codex texts). */
const DEFAULT_DISPLAY_NAME = "Codex";

/** Typed, user-readable failure for a turn on the shared subscription core. */
export type SubscriptionCoreCodexFailurePayload = {
  error: string;
  code:
    | "subscription_capacity_unavailable"
    | "subscription_lease_busy"
    | "subscription_core_unsupported"
    | "subscription_core_cutover_disabled"
    | "subscription_account_refused"
    | "subscription_failover_exhausted";
  retryable: boolean;
  detail?: string;
  /** Placement wait reason when `code` is `subscription_capacity_unavailable`. */
  waitReason?: WaitReason;
  /** Refusal class when `code` is `subscription_account_refused`. */
  refusal?: SubscriptionCoreAccountRefusal;
  /** ISO time the earliest known capacity returns, when placement knows it. */
  resetsAt?: string;
  /**
   * Refusals this turn took, and the per-turn refusal bound, when `code` is
   * `subscription_failover_exhausted` (refusals, not switches: the turn
   * switched accounts `maxRefusals - 1` times before the last refusal).
   */
  refusals?: number;
  maxRefusals?: number;
  /** Combined model/provider changes and refusals, not a refusal count. */
  failoverSteps?: number;
  maxFailoverSteps?: number;
};

/** The provider-neutral name of the core turn failure payload. */
export type SubscriptionCoreFailurePayload = SubscriptionCoreCodexFailurePayload;

/** A typed core turn failure (the class keeps its M3 name; it serves every provider). */
export class SubscriptionCoreCodexTurnError extends Error {
  readonly code: SubscriptionCoreCodexFailurePayload["code"];
  /**
   * The provider name its copy used. In-process only, never part of the
   * payload, so a follow-up failure for the same turn (an exhausted lease-busy
   * chain) names the same provider without the settlement naming providers.
   */
  readonly displayName: string;
  constructor(
    readonly payload: SubscriptionCoreCodexFailurePayload,
    displayName: string = DEFAULT_DISPLAY_NAME,
  ) {
    super(payload.error);
    this.name = "SubscriptionCoreCodexTurnError";
    this.code = payload.code;
    this.displayName = displayName;
  }
}

const WAIT_COPY = (name: string): Record<WaitReason, string> => ({
  pinned_account_unavailable: `The ${name} account chosen for this session is unavailable right now. Send a new message once it is available again, or switch the session back to automatic.`,
  pinned_account_ineligible: `The ${name} account chosen for this session can no longer serve this work. Choose another account or switch the session back to automatic.`,
  no_eligible_capacity: `No ${name} subscription has capacity for this turn right now. Send a new message once an account is available again.`,
  model_not_allowed: `This model is not allowed for the ${name} subscriptions available here.`,
  compaction_provider_locked:
    "This session is tied to a provider that has no capacity right now. Send a new message once an account is available again.",
  accepted_authority_unavailable:
    "This work was accepted before the account move and its account access could not be carried. Send it again.",
});

const WAITING_COPY = (name: string): Record<WaitReason, string> => ({
  pinned_account_unavailable: `The ${name} account chosen for this session is unavailable right now. This turn continues automatically once it is available again.`,
  pinned_account_ineligible: `The ${name} account chosen for this session can no longer serve this work. This turn continues once another account is chosen or the session is switched back to automatic.`,
  no_eligible_capacity: `No ${name} subscription has capacity for this turn right now. It continues automatically when an account is available.`,
  model_not_allowed: `This model is not allowed for the ${name} subscriptions available here. This turn continues if that changes.`,
  compaction_provider_locked:
    "This session is tied to a provider that has no capacity right now. It continues automatically when an account is available.",
  accepted_authority_unavailable:
    "This work was accepted before the account move and its account access could not be carried. Send it again to continue.",
});

/**
 * The `codex.capacity.waiting` payload for a turn parked on a core waiter
 * (M3 PR 2a): the legacy event shape with the core wait reason and the
 * earliest known reset.
 */
export function subscriptionCoreCapacityWaitPayload(
  reason: WaitReason,
  earliestResetAt: Date | null,
  displayName: string = DEFAULT_DISPLAY_NAME,
): Record<string, unknown> {
  return {
    error: WAITING_COPY(displayName)[reason],
    code: "subscription_capacity_unavailable",
    waitReason: reason,
    ...(earliestResetAt ? { resetsAt: earliestResetAt.toISOString() } : {}),
  };
}

/** The per-turn failover bound was reached; the session stays usable. */
export function subscriptionCoreFailoverExhaustedFailure(
  refusals: number,
  maxRefusals: number,
  displayName: string = DEFAULT_DISPLAY_NAME,
): SubscriptionCoreCodexTurnError {
  return new SubscriptionCoreCodexTurnError(
    {
      error: `${displayName} accounts refused this turn too many times in a row. Send a new message after checking the accounts' health or capacity.`,
      code: "subscription_failover_exhausted",
      retryable: false,
      refusals,
      maxRefusals,
    },
    displayName,
  );
}

export function subscriptionCoreServingFailoverExhaustedFailure(
  steps: number,
  limit: number,
): SubscriptionCoreCodexTurnError {
  return new SubscriptionCoreCodexTurnError(
    {
      error:
        "Model accounts reached this turn's failover limit. Send a new message after checking the accounts' health or capacity.",
      code: "subscription_failover_exhausted",
      retryable: false,
      failoverSteps: steps,
      maxFailoverSteps: limit,
    },
    "Model account",
  );
}

/**
 * The capacity wait the core decided, as a typed terminal failure. PR 2a
 * parks waits on a durable core waiter instead; this remains for callers that
 * cannot wait.
 */
export function subscriptionCoreCapacityFailure(
  reason: WaitReason,
  earliestResetAt: Date | null,
  displayName: string = DEFAULT_DISPLAY_NAME,
): SubscriptionCoreCodexTurnError {
  return new SubscriptionCoreCodexTurnError(
    {
      error: WAIT_COPY(displayName)[reason],
      code: "subscription_capacity_unavailable",
      retryable: false,
      waitReason: reason,
      ...(earliestResetAt ? { resetsAt: earliestResetAt.toISOString() } : {}),
    },
    displayName,
  );
}

/**
 * An older attempt of this same turn still holds its lease until expiry, or
 * (`binding_conflict`) the session's account changed while this placement
 * was deciding. Both retry the same way; only the copy differs.
 */
export function subscriptionCoreLeaseBusyFailure(
  leasedUntil: Date | null,
  cause?: "binding_conflict",
  displayName: string = DEFAULT_DISPLAY_NAME,
): SubscriptionCoreCodexTurnError {
  return new SubscriptionCoreCodexTurnError(
    {
      error:
        cause === "binding_conflict"
          ? `The session's ${displayName} account changed while this turn was starting. The turn will retry.`
          : `A previous attempt of this turn still holds its ${displayName} account. The turn will retry once that hold ends.`,
      code: "subscription_lease_busy",
      retryable: true,
      ...(leasedUntil ? { resetsAt: leasedUntil.toISOString() } : {}),
    },
    displayName,
  );
}

/** Most extra delay added after the older lease's expiry, so retries spread out. */
export const SUBSCRIPTION_CORE_LEASE_BUSY_JITTER_MS = 5_000;

/**
 * When a redispatched attempt should retry after finding an older attempt's
 * live lease: just after that lease expires (plus jitter), never later than
 * one lease TTL, and never sooner than one second.
 */
export function subscriptionCoreLeaseBusyDelayMs(
  resetsAt: string | undefined,
  now: number,
  jitterSample: number,
  ttlMs: number = CODEX_CREDENTIAL_LEASE_TTL_MS,
): number {
  const until = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  const remaining = Number.isFinite(until) ? Math.min(Math.max(until - now, 0), ttlMs) : ttlMs;
  const jitter = Math.min(Math.max(jitterSample, 0), 1) * SUBSCRIPTION_CORE_LEASE_BUSY_JITTER_MS;
  return Math.max(1_000, Math.ceil(remaining + jitter));
}

/**
 * How long one turn may keep finding an older attempt's live lease: about
 * three lease TTLs of wall-clock time since the first such recovery. Lease
 * renewal is not fenced on the turn's current attempt, so a superseded attempt
 * that keeps heartbeating would otherwise hold the turn forever.
 */
export const SUBSCRIPTION_CORE_LEASE_BUSY_MAX_MS = 3 * CODEX_CREDENTIAL_LEASE_TTL_MS;

/**
 * The consecutive lease-busy chain after this attempt: it continues only when
 * the immediately previous execution generation recorded it. A stored start
 * in the future (clock skew or a bad write) is clamped to now so it can never
 * disable the bound.
 */
export function subscriptionCoreLeaseBusyChain(
  stored: { startedAt: number; executionGeneration: number } | undefined,
  executionGeneration: number,
  now: number,
): { startedAt: number; executionGeneration: number; exhausted: boolean } {
  const startedAt =
    stored && stored.executionGeneration === executionGeneration - 1
      ? Math.min(stored.startedAt, now)
      : now;
  return {
    startedAt,
    executionGeneration,
    exhausted: now - startedAt >= SUBSCRIPTION_CORE_LEASE_BUSY_MAX_MS,
  };
}

/** The lease-busy chain lasted too long: stop with readable copy. */
export function subscriptionCoreLeaseBusyExhaustedFailure(
  displayName: string = DEFAULT_DISPLAY_NAME,
): SubscriptionCoreCodexTurnError {
  return new SubscriptionCoreCodexTurnError(
    {
      error: `A previous attempt of this turn kept holding its ${displayName} account, so the turn stopped. Send a new message to try again.`,
      code: "subscription_lease_busy",
      retryable: false,
    },
    displayName,
  );
}

export type SubscriptionCoreAccountRefusal =
  | "sign_in"
  | "forbidden"
  | "entitlement"
  | "access_lost";

const REFUSAL_COPY = (name: string): Record<SubscriptionCoreAccountRefusal, string> => ({
  sign_in: `The ${name} account serving this session needs a new sign-in. Reconnect it or choose another account, then send a new message.`,
  forbidden: `The ${name} account serving this session refused this request. Check the account's access or choose another account, then send a new message.`,
  entitlement: `The ${name} account serving this session cannot use this model on its current plan. Choose another model or account, then send a new message.`,
  access_lost: `This session lost access to the ${name} account it was running on. Send a new message to continue on an account it can use.`,
});

/**
 * A definitive refusal from the leased account (revoked sign-in, 403, or a
 * plan that does not include the model). Health and quarantine of the
 * connection arrive with PR 2; until then the turn stops with readable copy
 * and the session stays usable.
 */
export function subscriptionCoreAccountRefusedFailure(
  refusal: SubscriptionCoreAccountRefusal,
  displayName: string = DEFAULT_DISPLAY_NAME,
): SubscriptionCoreCodexTurnError {
  return new SubscriptionCoreCodexTurnError(
    {
      error: REFUSAL_COPY(displayName)[refusal],
      code: "subscription_account_refused",
      retryable: false,
      refusal,
    },
    displayName,
  );
}

/** A Codex consumer that has not moved to the core yet (PR 2) must not read legacy tables. */
export function subscriptionCoreUnsupportedFailure(
  consumer: string,
  displayName: string = DEFAULT_DISPLAY_NAME,
): SubscriptionCoreCodexTurnError {
  return new SubscriptionCoreCodexTurnError(
    {
      error: `${consumer} is not available for ${displayName} subscriptions on this deployment yet.`,
      code: "subscription_core_unsupported",
      retryable: false,
    },
    displayName,
  );
}

/** The organization's cutover row for the provider exists but is switched off. */
export function subscriptionCoreCutoverDisabledFailure(
  displayName: string = DEFAULT_DISPLAY_NAME,
): SubscriptionCoreCodexTurnError {
  return new SubscriptionCoreCodexTurnError(
    {
      error: `${displayName} subscriptions are paused for this organization during maintenance.`,
      code: "subscription_core_cutover_disabled",
      retryable: false,
    },
    displayName,
  );
}

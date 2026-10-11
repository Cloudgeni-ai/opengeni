import type { ModelId, SubscriptionConnection, SubscriptionQuota } from "./types";

/**
 * What the shared quota model says about a connection's capacity now
 * (design 2.2). `unknown` is never treated as available or exhausted
 * (SUB-ELIG-06): it participates in ordinary rotation without a ranking penalty (D-14).
 */
export type QuotaCapacity =
  | { kind: "available" }
  | { kind: "unknown" }
  /** `resetsAt` is null when the provider did not say when it resets. */
  | { kind: "exhausted"; resetsAt: number | null };

const UNKNOWN: QuotaCapacity = Object.freeze({ kind: "unknown" });
const AVAILABLE: QuotaCapacity = Object.freeze({ kind: "available" });

/**
 * Capacity of a quota observation at `now`.
 *
 * - An exhaustion deadline (`exhaustedUntil`) in the future is authoritative.
 * - A quota exhaustion whose deadline has passed is an observed reset, so it
 *   counts as known capacity; a passed rate-limit deadline says nothing about
 *   quota.
 * - A window reported exhausted stays exhausted until its reset; an exhausted
 *   window whose reset has passed counts as reset (known capacity).
 * - With nothing exhausted, any window with a known status is known capacity.
 * - No observation, only windows of unknown status, or an observation older
 *   than `staleAfterMs` (or undated, when a bound is given), is unknown.
 */
export function quotaCapacity(
  quota: SubscriptionQuota | null,
  now: number,
  staleAfterMs?: number,
): QuotaCapacity {
  if (!quota) return UNKNOWN;
  // A stale or undated observation no longer says the account has capacity
  // (SUB-ELIG-06); observed exhaustion still stands until its reset.
  const stale =
    staleAfterMs !== undefined &&
    (quota.observedAt === null || now - quota.observedAt > staleAfterMs);
  let exhausted = false;
  let resetsAt: number | null = null;
  let resetUnknown = false;
  const extend = (at: number | null) => {
    exhausted = true;
    if (at === null) resetUnknown = true;
    else resetsAt = resetsAt === null ? at : Math.max(resetsAt, at);
  };
  let known = false;
  if (quota.exhaustedUntil !== null) {
    if (quota.exhaustedUntil > now) extend(quota.exhaustedUntil);
    else if (quota.exhaustedKind === "quota" && !stale) known = true;
  }
  for (const window of quota.windows) {
    if (window.status === "exhausted") {
      if (window.resetsAt === null || window.resetsAt > now) extend(window.resetsAt);
      else if (!stale) known = true;
    } else if (window.status !== "unknown" && !stale) {
      known = true;
    }
  }
  if (exhausted) return { kind: "exhausted", resetsAt: resetUnknown ? null : resetsAt };
  return known ? AVAILABLE : UNKNOWN;
}

/** End of a model-specific cooldown that is still running, else null. */
export function modelCooldownUntil(
  quota: SubscriptionQuota | null,
  modelId: ModelId,
  now: number,
): number | null {
  const until = quota?.modelCooldowns[modelId];
  return until !== undefined && until > now ? until : null;
}

/**
 * A quota observation applies only to the credential generation it was made
 * with, so a refusal seen before a refresh cannot quarantine the renewed
 * credential (design 2.2).
 */
export function quotaObservationApplies(
  connection: Pick<SubscriptionConnection, "refreshGeneration">,
  observation: Pick<SubscriptionQuota, "observedRefreshGeneration">,
): boolean {
  return observation.observedRefreshGeneration === connection.refreshGeneration;
}

/**
 * Apply an observation to the stored quota (design 2.2). It applies only to
 * the current credential generation, never replaces a newer or dated reading
 * with an older or undated one, and never shortens a running exhaustion
 * deadline or model cooldown: a later usage reading without them does not
 * clear them. Clearing a cooldown early is an explicit, revision-fenced store
 * operation, not an observation. Revision numbers are assigned by the store.
 */
export function applyQuotaObservation(
  connection: Pick<SubscriptionConnection, "refreshGeneration" | "quota">,
  observation: SubscriptionQuota,
): SubscriptionQuota | null {
  if (!quotaObservationApplies(connection, observation)) return connection.quota;
  const current = connection.quota;
  if (!current || current.observedRefreshGeneration !== connection.refreshGeneration) {
    return observation;
  }
  if (
    current.observedAt !== null &&
    (observation.observedAt === null || observation.observedAt < current.observedAt)
  ) {
    return current;
  }
  // Keep only what still runs after this observation was made: later values
  // win, and deadlines and cooldowns that ended before it are dropped.
  const observedAt = observation.observedAt ?? -Infinity;
  const modelCooldowns: Record<string, number> = {};
  for (const source of [current.modelCooldowns, observation.modelCooldowns]) {
    for (const [modelId, until] of Object.entries(source)) {
      if (until <= observedAt) continue;
      modelCooldowns[modelId] = Math.max(modelCooldowns[modelId] ?? until, until);
    }
  }
  const keepCurrentDeadline =
    current.exhaustedUntil !== null &&
    current.exhaustedUntil > observedAt &&
    (observation.exhaustedUntil === null || observation.exhaustedUntil < current.exhaustedUntil);
  return {
    ...observation,
    modelCooldowns,
    exhaustedUntil: keepCurrentDeadline ? current.exhaustedUntil : observation.exhaustedUntil,
    exhaustedKind: keepCurrentDeadline ? current.exhaustedKind : observation.exhaustedKind,
  };
}

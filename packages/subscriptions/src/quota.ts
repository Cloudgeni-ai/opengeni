import type { ModelId, QuotaBlockClaim, SubscriptionConnection, SubscriptionQuota } from "./types";

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

/** One stored block a usage reading may end: a model cooldown, or (model null) the exhaustion deadline. */
export type SubscriptionQuotaBlock = {
  modelId: ModelId | null;
  until: number;
  /** Its claim, only while it still explains this exact deadline. */
  claim: QuotaBlockClaim | null;
};

/**
 * The claim of a stored block (a model's cooldown, or with `modelId` null
 * the exhaustion deadline), only while it is tied to the block's current
 * deadline; null otherwise (fail closed).
 */
export function quotaBlockClaim(
  quota: Pick<
    SubscriptionQuota,
    "modelCooldowns" | "modelCooldownClaims" | "exhaustedUntil" | "exhaustedClaim"
  >,
  modelId: ModelId | null,
): QuotaBlockClaim | null {
  const until = modelId === null ? quota.exhaustedUntil : quota.modelCooldowns[modelId];
  const claim = modelId === null ? quota.exhaustedClaim : quota.modelCooldownClaims?.[modelId];
  return until !== null &&
    until !== undefined &&
    claim !== null &&
    claim !== undefined &&
    claim.until === until &&
    claim.windowIds.length > 0
    ? claim
    : null;
}

/** The quota document a store writes: claims only while they explain a block. */
export type StoredQuotaDocument = Pick<
  SubscriptionQuota,
  | "windows"
  | "modelCooldowns"
  | "modelCooldownClaims"
  | "exhaustedUntil"
  | "exhaustedKind"
  | "exhaustedClaim"
  | "source"
>;

/** The stored document of one quota (a claim that no longer explains its block is dropped). */
export function storedQuotaDocument(quota: SubscriptionQuota): StoredQuotaDocument {
  const modelCooldownClaims: Record<string, QuotaBlockClaim> = {};
  for (const modelId of Object.keys(quota.modelCooldowns)) {
    const claim = quotaBlockClaim(quota, modelId);
    if (claim) modelCooldownClaims[modelId] = claim;
  }
  const exhaustedClaim = quotaBlockClaim(quota, null);
  return {
    windows: quota.windows,
    modelCooldowns: quota.modelCooldowns,
    ...(Object.keys(modelCooldownClaims).length > 0 ? { modelCooldownClaims } : {}),
    exhaustedUntil: quota.exhaustedUntil,
    exhaustedKind: quota.exhaustedKind,
    ...(exhaustedClaim ? { exhaustedClaim } : {}),
    source: quota.source,
  };
}

/**
 * The claim of a block merged from several observations at `until`: every
 * source whose own block has that exact deadline must carry a claim tied to
 * it (their window ids are joined); otherwise none (an unexplained limit
 * with the same deadline keeps the block).
 */
function mergedClaim(
  until: number,
  sources: readonly { until: number | null | undefined; claim: QuotaBlockClaim | null }[],
): QuotaBlockClaim | null {
  const deciding = sources.filter((source) => source.until === until);
  if (deciding.length === 0 || deciding.some((source) => source.claim === null)) return null;
  const claims = deciding.map((source) => source.claim!);
  return {
    until,
    observedAt: Math.max(...claims.map((claim) => claim.observedAt)),
    windowIds: [...new Set(claims.flatMap((claim) => claim.windowIds))],
  };
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
 * clear them. A stored exhausted window with a known reset that an
 * observation does not report at all stays until that reset (one that
 * reports the window again replaces it), unless the observation is a
 * usage-endpoint reading of an adapter that declares its usage readings
 * complete (`options.usageReadingsComplete`, from the adapter's
 * `usageReadingsComplete`): such a reading replaces the stored windows, so
 * it can show an early reset (also of a refusal's fallback window).
 * Response headers and refusals, and the usage readings of every other
 * adapter, report only some windows (fail closed: absent means partial).
 * So a window that only refusals report (a policy hold the caller records
 * itself, for example) ends at its reset or with a complete usage reading,
 * never with a header reading. A caller's own refusal must be tagged
 * `refusal`, not `usage_endpoint`, or a complete adapter's reading would
 * erase the stored windows.
 * Clearing a cooldown early is an explicit, revision-fenced store operation,
 * not an observation. Revision numbers are assigned by the store.
 */
export function applyQuotaObservation(
  connection: Pick<SubscriptionConnection, "refreshGeneration" | "quota">,
  observation: SubscriptionQuota,
  options: {
    /** The observing adapter declares its usage-endpoint readings complete. */
    usageReadingsComplete?: boolean;
  } = {},
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
  const exhaustedUntil = keepCurrentDeadline ? current.exhaustedUntil : observation.exhaustedUntil;
  // A block keeps its evidence only where every observation that set its
  // merged deadline explained it (`QuotaBlockClaim`).
  const sources = [current, observation];
  const modelCooldownClaims: Record<string, QuotaBlockClaim> = {};
  for (const [modelId, until] of Object.entries(modelCooldowns)) {
    const claim = mergedClaim(
      until,
      sources.map((source) => ({
        until: source.modelCooldowns[modelId],
        claim: quotaBlockClaim(source, modelId),
      })),
    );
    if (claim) modelCooldownClaims[modelId] = claim;
  }
  const exhaustedClaim =
    exhaustedUntil === null
      ? null
      : mergedClaim(
          exhaustedUntil,
          sources.map((source) => ({
            until: source.exhaustedUntil,
            claim: quotaBlockClaim(source, null),
          })),
        );
  const reported = new Set(observation.windows.map((window) => window.id));
  const omittedExhausted =
    observation.source === "usage_endpoint" && options.usageReadingsComplete === true
      ? []
      : current.windows.filter(
          (window) =>
            !reported.has(window.id) &&
            window.status === "exhausted" &&
            window.resetsAt !== null &&
            window.resetsAt > observedAt,
        );
  const merged: SubscriptionQuota = {
    ...observation,
    windows: omittedExhausted.length
      ? [...observation.windows, ...omittedExhausted]
      : observation.windows,
    modelCooldowns,
    exhaustedUntil,
    exhaustedKind: keepCurrentDeadline ? current.exhaustedKind : observation.exhaustedKind,
  };
  delete merged.modelCooldownClaims;
  delete merged.exhaustedClaim;
  if (Object.keys(modelCooldownClaims).length > 0) merged.modelCooldownClaims = modelCooldownClaims;
  if (exhaustedClaim) merged.exhaustedClaim = exhaustedClaim;
  return merged;
}

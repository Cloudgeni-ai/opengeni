import type { CacheFacts, SessionBinding } from "./types";

/**
 * Idle cut-off used for providers whose cut-off has not been measured yet
 * (design 6.1). Erring towards "warm" avoids paying a cache miss for a switch
 * that was not needed.
 */
export const DEFAULT_IDLE_CUTOFF_MS = 60 * 60 * 1000;

/** How long the provider prompt cache stays warm after a model call. */
export function cacheLifetimeMs(facts: CacheFacts | undefined): number {
  if (!facts) return DEFAULT_IDLE_CUTOFF_MS;
  if (facts.kind === "exact_ttl") return Math.max(0, facts.ttlMs);
  return facts.cutoffMs === null ? DEFAULT_IDLE_CUTOFF_MS : Math.max(0, facts.cutoffMs);
}

/**
 * The cache is warm while the session has been idle no longer than the
 * provider's cache lifetime (SUB-STICK-04). Idle time is measured from the
 * latest completed model call, not the turn start, so a long turn is not
 * mistaken for a cold cache. An exact lifetime sent with the latest request
 * (Claude) takes precedence over the provider's facts.
 */
export function isCacheWarm(
  binding: Pick<SessionBinding, "lastModelCallAt" | "cacheTtlMs">,
  facts: CacheFacts | undefined,
  now: number,
): boolean {
  const lifetime =
    binding.cacheTtlMs !== undefined && binding.cacheTtlMs !== null
      ? Math.max(0, binding.cacheTtlMs)
      : cacheLifetimeMs(facts);
  return now - binding.lastModelCallAt <= lifetime;
}

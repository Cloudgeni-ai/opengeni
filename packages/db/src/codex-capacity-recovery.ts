/**
 * Durable logical-turn state: how many resumes of this turn landed straight
 * back on unavailable capacity, and the persisted backoff before the next.
 * The count only grows the backoff; it never ends the turn.
 */
export const CODEX_CAPACITY_RECOVERY_KEY = "codexCapacityRecoveryV1";

/**
 * The terminal code each core waiter's former false-resumption breaker gave
 * a turn (one per provider wait vocabulary). Waits no longer stop, but turns
 * that failed with these codes remain: a human Retry of one clears the shared
 * recovery state (`CODEX_CAPACITY_RECOVERY_KEY`).
 */
export const SUBSCRIPTION_CORE_WAIT_EXHAUSTED_CODES = {
  codex: "codex_capacity_recovery_exhausted",
  xai: "xai_capacity_recovery_exhausted",
  claude: "claude_capacity_recovery_exhausted",
} as const;

export function isSubscriptionCoreWaitExhaustedCode(code: unknown): boolean {
  return (Object.values(SUBSCRIPTION_CORE_WAIT_EXHAUSTED_CODES) as unknown[]).includes(code);
}

export type CodexCapacityRecovery = {
  falseResumptions: number;
  resumeGeneration: number | null;
  retryNotBefore: string | null;
};

export function readCodexCapacityRecovery(
  metadata: Record<string, unknown> | null | undefined,
): CodexCapacityRecovery {
  const value = metadata?.[CODEX_CAPACITY_RECOVERY_KEY];
  if (value === undefined) {
    return { falseResumptions: 0, resumeGeneration: null, retryNotBefore: null };
  }
  const state = value as CodexCapacityRecovery | null;
  if (
    !state ||
    !Number.isSafeInteger(state.falseResumptions) ||
    state.falseResumptions < 0 ||
    (state.resumeGeneration !== null &&
      (!Number.isSafeInteger(state.resumeGeneration) || state.resumeGeneration < 1)) ||
    (state.retryNotBefore !== null &&
      (typeof state.retryNotBefore !== "string" ||
        !Number.isFinite(Date.parse(state.retryNotBefore))))
  ) {
    throw new Error("Invalid persisted Codex capacity recovery state");
  }
  return state;
}

/** Equal jitter, 30–60 seconds initially, capped at 15 minutes. Persist the chosen deadline. */
export function codexFalseResumptionBackoffMs(count: number, random = Math.random()): number {
  const cap = Math.min(60_000 * 2 ** Math.max(0, Math.min(count - 1, 4)), 900_000);
  return Math.floor(cap * (0.5 + Math.max(0, Math.min(random, 1)) / 2));
}

export function clearCodexCapacityRecovery(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next[CODEX_CAPACITY_RECOVERY_KEY];
  return next;
}

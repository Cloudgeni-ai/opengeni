/** Durable logical-turn state; checks and quota/account signals never spend this budget. */
export const CODEX_CAPACITY_RECOVERY_KEY = "codexCapacityRecoveryV1";
export const CODEX_CAPACITY_FALSE_RESUMPTION_LIMIT = 10;

/**
 * The terminal code of each core waiter's false-resumption breaker (one per
 * provider wait vocabulary). The breaker state is shared
 * (`CODEX_CAPACITY_RECOVERY_KEY`), so a human Retry of a turn that failed
 * with any of these codes replenishes it.
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
    state.falseResumptions > CODEX_CAPACITY_FALSE_RESUMPTION_LIMIT ||
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

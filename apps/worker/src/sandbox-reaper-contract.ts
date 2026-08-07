export const SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS = 65 * 60_000;
export const SANDBOX_REAPER_ACTIVITY_PRELUDE_RESERVE_MS = 5 * 60_000;
export const SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS = 5 * 60_000;
export const SANDBOX_REAPER_PER_DRAIN_OVERHEAD_MS = 2 * 60_000;

export function sandboxReaperDrainSlotMs(captureTimeoutMs: number): number {
  return captureTimeoutMs + SANDBOX_REAPER_PER_DRAIN_OVERHEAD_MS;
}

export function sandboxReaperDrainCapacity(captureTimeoutMs: number): number {
  const drainBudgetMs =
    SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS -
    SANDBOX_REAPER_ACTIVITY_PRELUDE_RESERVE_MS -
    SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS;
  // Keep the total strictly below the Temporal deadline rather than admitting a
  // slot whose final millisecond lands exactly on startToCloseTimeout.
  return Math.max(0, Math.floor((drainBudgetMs - 1) / sandboxReaperDrainSlotMs(captureTimeoutMs)));
}

export function sandboxReaperDrainableBatch<T>(
  rows: readonly T[],
  captureTimeoutMs: number,
  preludeElapsedMs: number,
): T[] {
  // The static capacity reserves the whole prelude window. Once real elapsed
  // time consumes that reserve, beginning a non-cancellable provider capture
  // would invalidate the timeout proof; leave every row for the next Schedule.
  if (preludeElapsedMs >= SANDBOX_REAPER_ACTIVITY_PRELUDE_RESERVE_MS) return [];
  return rows.slice(0, sandboxReaperDrainCapacity(captureTimeoutMs));
}

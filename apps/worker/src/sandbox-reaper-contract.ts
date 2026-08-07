export const SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS = 65 * 60_000;
export const SANDBOX_REAPER_ACTIVITY_PRELUDE_BUDGET_MS = 5 * 60_000;
export const SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS = 5 * 60_000;
export const SANDBOX_REAPER_PER_DRAIN_OVERHEAD_MS = 60_000;

export function sandboxReaperDrainableBatch<T>(rows: readonly T[], capacity: number): T[] {
  return rows.slice(0, Math.max(0, Math.floor(capacity)));
}

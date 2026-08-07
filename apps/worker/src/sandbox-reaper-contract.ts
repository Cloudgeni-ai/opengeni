export const SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS = 65 * 60_000;
export const SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS = 5 * 60_000;
export const SANDBOX_REAPER_MAX_DRAINABLE_BOXES_PER_ACTIVITY = 1;

export function sandboxReaperDrainableBatch<T>(rows: readonly T[]): T[] {
  return rows.slice(0, SANDBOX_REAPER_MAX_DRAINABLE_BOXES_PER_ACTIVITY);
}

import { sandboxArchiveCaptureTimeoutMs, type Settings } from "@opengeni/config";
import {
  SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS,
  SANDBOX_REAPER_ACTIVITY_PRELUDE_BUDGET_MS,
  SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS,
  SANDBOX_REAPER_PER_DRAIN_OVERHEAD_MS,
} from "./sandbox-reaper-contract";

const STRICT_TIMEOUT_FENCE_MS = 1;

export function sandboxReaperDrainCapacity(
  settings: Pick<Settings, "sandboxSnapshotTimeoutMs">,
): number {
  const availableMs =
    SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS -
    SANDBOX_REAPER_ACTIVITY_PRELUDE_BUDGET_MS -
    SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS -
    STRICT_TIMEOUT_FENCE_MS;
  const perDrainMs =
    sandboxArchiveCaptureTimeoutMs(settings) + SANDBOX_REAPER_PER_DRAIN_OVERHEAD_MS;
  return Math.max(0, Math.floor(availableMs / perDrainMs));
}

export function sandboxReaperPreludeAllowsCapture(
  activityStartedAtMs: number,
  nowMs: number,
): boolean {
  const elapsedMs = Math.max(0, nowMs - activityStartedAtMs);
  return elapsedMs < SANDBOX_REAPER_ACTIVITY_PRELUDE_BUDGET_MS;
}

export function assertSandboxReaperActivityTimeout(
  settings: Pick<Settings, "sandboxSnapshotTimeoutMs">,
): void {
  const captureTimeoutMs = sandboxArchiveCaptureTimeoutMs(settings);
  const capacity = sandboxReaperDrainCapacity(settings);
  if (capacity < 1) {
    throw new Error(
      `Sandbox reaper activity timeout (${SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS}) must strictly exceed ` +
        `the prelude budget, one durable archive capture fence, per-drain settlement, and cleanup ` +
        `margin (${captureTimeoutMs} capture milliseconds). Lower ` +
        `OPENGENI_SANDBOX_SNAPSHOT_TIMEOUT_MS or raise the reaper activity timeout.`,
    );
  }
}

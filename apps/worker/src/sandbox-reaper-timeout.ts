import { sandboxArchiveCaptureTimeoutMs, type Settings } from "@opengeni/config";
import {
  SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS,
  SANDBOX_REAPER_ACTIVITY_PRELUDE_RESERVE_MS,
  SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS,
  SANDBOX_REAPER_PER_DRAIN_OVERHEAD_MS,
  sandboxReaperDrainCapacity,
  sandboxReaperDrainSlotMs,
} from "./sandbox-reaper-contract";

export function assertSandboxReaperActivityTimeout(
  settings: Pick<Settings, "sandboxSnapshotTimeoutMs">,
): void {
  const captureTimeoutMs = sandboxArchiveCaptureTimeoutMs(settings);
  const capacity = sandboxReaperDrainCapacity(captureTimeoutMs);
  if (capacity < 1) {
    const requiredMs =
      SANDBOX_REAPER_ACTIVITY_PRELUDE_RESERVE_MS +
      sandboxReaperDrainSlotMs(captureTimeoutMs) +
      SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS;
    throw new Error(
      `Sandbox reaper activity timeout (${SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS}) must strictly exceed ` +
        `the prelude reserve, one durable archive capture fence, per-drain overhead, and cleanup ` +
        `margin (${requiredMs}; per-drain overhead ${SANDBOX_REAPER_PER_DRAIN_OVERHEAD_MS}). Lower ` +
        `OPENGENI_SANDBOX_SNAPSHOT_TIMEOUT_MS or raise the reaper activity timeout.`,
    );
  }
}

export function assertSandboxReaperWorkerConfiguration(
  role: "control" | "turn",
  settings: Pick<Settings, "sandboxSnapshotTimeoutMs">,
): void {
  if (role === "control") assertSandboxReaperActivityTimeout(settings);
}

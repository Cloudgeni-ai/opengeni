import { sandboxArchiveCaptureTimeoutMs, type Settings } from "@opengeni/config";
import {
  SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS,
  SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS,
} from "./workflows/sandbox-reaper-contract";

export function assertSandboxReaperActivityTimeout(
  settings: Pick<Settings, "sandboxSnapshotTimeoutMs">,
): void {
  const requiredMs =
    sandboxArchiveCaptureTimeoutMs(settings) + SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS;
  if (!(SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS > requiredMs)) {
    throw new Error(
      `Sandbox reaper activity timeout (${SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS}) must strictly exceed ` +
        `the durable archive capture fence plus cleanup margin (${requiredMs}). Lower ` +
        `OPENGENI_SANDBOX_SNAPSHOT_TIMEOUT_MS or raise the reaper activity timeout.`,
    );
  }
}

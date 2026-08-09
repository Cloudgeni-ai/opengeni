import {
  SANDBOX_ARCHIVE_CAPTURE_MAX_TIMEOUT_MS,
  SANDBOX_SNAPSHOT_MAX_TIMEOUT_MS,
  sandboxArchiveCaptureTimeoutMs,
  type Settings,
} from "@opengeni/config";
import {
  SANDBOX_DRAIN_SETTLEMENT_MARGIN_MS,
  sandboxDrainActivityTimeoutMs,
  sandboxDrainTimeoutClass,
  type SandboxDrainTimeoutClass,
} from "./sandbox-reaper-contract";

const STRICT_TIMEOUT_FENCE_MS = 1;

export function sandboxDrainTiming(settings: Pick<Settings, "sandboxSnapshotTimeoutMs">): {
  snapshotTimeoutMs: number;
  captureTimeoutMs: number;
  timeoutClass: SandboxDrainTimeoutClass;
  activityTimeoutMs: number;
} {
  const captureTimeoutMs = sandboxArchiveCaptureTimeoutMs(settings);
  const timeoutClass = sandboxDrainTimeoutClass(captureTimeoutMs);
  return {
    snapshotTimeoutMs: settings.sandboxSnapshotTimeoutMs,
    captureTimeoutMs,
    timeoutClass,
    activityTimeoutMs: sandboxDrainActivityTimeoutMs(timeoutClass),
  };
}

export function assertSandboxReaperActivityTimeout(
  settings: Pick<Settings, "sandboxSnapshotTimeoutMs">,
): void {
  const timing = sandboxDrainTiming(settings);
  if (timing.snapshotTimeoutMs >= timing.captureTimeoutMs) {
    throw new Error(
      `Sandbox provider snapshot timeout (${timing.snapshotTimeoutMs}) must be strictly less than ` +
        `its durable capture claim (${timing.captureTimeoutMs}).`,
    );
  }
  if (
    timing.captureTimeoutMs + SANDBOX_DRAIN_SETTLEMENT_MARGIN_MS + STRICT_TIMEOUT_FENCE_MS >=
    timing.activityTimeoutMs
  ) {
    throw new Error(
      `Sandbox ${timing.timeoutClass} drain activity timeout (${timing.activityTimeoutMs}) must ` +
        `strictly exceed one durable archive capture and settlement margin ` +
        `(${timing.captureTimeoutMs} + ${SANDBOX_DRAIN_SETTLEMENT_MARGIN_MS} milliseconds).`,
    );
  }
}

export function assertSandboxDrainInputTiming(input: {
  timeoutClass: SandboxDrainTimeoutClass;
  snapshotTimeoutMs: number;
  captureTimeoutMs: number;
}): void {
  if (
    !Number.isSafeInteger(input.snapshotTimeoutMs) ||
    input.snapshotTimeoutMs <= 0 ||
    input.snapshotTimeoutMs > SANDBOX_SNAPSHOT_MAX_TIMEOUT_MS ||
    !Number.isSafeInteger(input.captureTimeoutMs) ||
    input.captureTimeoutMs <= 0 ||
    input.captureTimeoutMs > SANDBOX_ARCHIVE_CAPTURE_MAX_TIMEOUT_MS
  ) {
    throw new Error("Sandbox drain timeout values are invalid");
  }
  const inputActivityTimeoutMs = sandboxDrainActivityTimeoutMs(input.timeoutClass);
  if (
    sandboxDrainTimeoutClass(input.captureTimeoutMs) !== input.timeoutClass ||
    input.snapshotTimeoutMs >= input.captureTimeoutMs ||
    input.captureTimeoutMs + SANDBOX_DRAIN_SETTLEMENT_MARGIN_MS >= inputActivityTimeoutMs
  ) {
    throw new Error(
      `Sandbox drain timing is inconsistent with the ${input.timeoutClass} activity budget`,
    );
  }
}

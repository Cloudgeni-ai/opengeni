/**
 * What the recorder's state word means for starting and keeping a recording.
 * Pure, so the app's action registry can read it without the recorder's
 * React context.
 */
import type { RecorderState } from "@opengeni/sdk/recordings";

/** States in which the recorder holds a capture that unmounting its host would end. */
export function capturing(state: RecorderState | null | undefined): boolean {
  return (
    state === "starting" || state === "recording" || state === "paused" || state === "stopping"
  );
}

/**
 * States in which Start recording starts a new recording: nothing recorded
 * yet, the last one stopped, or the last start failed. Null is a recorder
 * whose capture code hasn't loaded yet.
 */
export function canStartRecording(state: RecorderState | null | undefined): boolean {
  return !capturing(state);
}

/**
 * Runs the recorder for the whole workspace and publishes it to the store.
 * Loaded lazily by MeetingRecorderProvider; renders nothing.
 */
import { useEffect, useLayoutEffect } from "react";
import { desktopCapability } from "@opengeni/react/app/lib/desktop";
import { useRecorder } from "@opengeni/react/recordings";

import type { MeetingRecorderStore } from "./recorder-context";

export default function RecorderHost({ store }: { store: MeetingRecorderStore }) {
  const recorder = useRecorder({ onFinished: (recordingId) => store.markFinished(recordingId) });
  useLayoutEffect(() => {
    store.set(recorder);
  });
  useEffect(() => () => store.set(null), [store]);

  // Closing the tab ends a recording in progress. Chunks already cut are safe
  // on this device and upload next time, so only live capture asks first.
  const capturing = recorder.state === "recording" || recorder.state === "paused";
  useEffect(() => {
    if (!capturing) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [capturing]);

  // The desktop app doesn't offer to record a call while this page records
  // one, and offers to stop when the recorded call ends.
  useEffect(() => {
    const detection = desktopCapability("meetingDetection")?.meetingDetection;
    if (!detection) return;
    detection.setRecording(capturing);
    return () => detection.setRecording(false);
  }, [capturing]);
  return null;
}

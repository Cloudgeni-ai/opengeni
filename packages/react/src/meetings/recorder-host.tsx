/**
 * Runs the recorder for the whole workspace and publishes it to the store.
 * Loaded lazily by MeetingRecorderProvider; renders nothing.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { desktopCapability } from "../app/lib/desktop";
import { useRecorder } from "../recordings";

import type { MeetingRecorderStore } from "./recorder-context";

export default function RecorderHost({
  store,
  workspaceId,
  client,
}: {
  store: MeetingRecorderStore;
  workspaceId: string;
  client?: object | undefined;
}) {
  const recorder = useRecorder({
    workspaceId,
    ...(client ? { client } : {}),
    onFinished: (recordingId) => store.markFinished(recordingId),
  });
  const published = useRef(recorder);
  useLayoutEffect(() => {
    published.current = recorder;
    store.set(recorder, workspaceId);
  });
  // The host for the next workspace may already have published its recorder.
  useEffect(
    () => () => {
      if (store.get() === published.current) store.set(null);
    },
    [store],
  );

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

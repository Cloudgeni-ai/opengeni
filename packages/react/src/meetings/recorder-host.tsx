/**
 * Runs the recorder for the whole workspace and publishes it to the store.
 * Loaded lazily by MeetingRecorderProvider; renders nothing.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { getDesktopMeetingDetection } from "@opengeni/sdk/desktop-bridge";
import { useRecorder } from "../recordings";

import type { MeetingRecorderStore } from "./recorder-context";
import { registerLiveRecordingCapture } from "./sign-out-recordings";

export default function RecorderHost({
  store,
  workspaceId,
  ownerId = null,
  client,
}: {
  store: MeetingRecorderStore;
  workspaceId: string;
  ownerId?: string | null;
  client?: object | undefined;
}) {
  const recorder = useRecorder({
    workspaceId,
    ...(ownerId ? { ownerId } : {}),
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
  // Signing this person out while they record stops and discards the capture
  // when they choose to discard, so no audio is written after it is gone.
  const discardCapture = useRef(recorder.discard);
  discardCapture.current = recorder.discard;
  useEffect(() => {
    if (!capturing) return;
    return registerLiveRecordingCapture({ ownerId, discard: () => discardCapture.current() });
  }, [capturing, ownerId]);
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
  // one, and offers to stop when the recorded call ends. Its menu bar shows
  // the meeting, so it hears again when the title or a pause changes.
  const recordedRef = useRef(recorder.elapsedMilliseconds);
  recordedRef.current = recorder.elapsedMilliseconds;
  const title = recorder.title ?? null;
  const paused = recorder.state === "paused";
  useEffect(() => {
    const detection = getDesktopMeetingDetection();
    if (!detection || !capturing) return;
    return () => detection.setRecording(false);
  }, [capturing]);
  useEffect(() => {
    const detection = getDesktopMeetingDetection();
    if (!detection) return;
    if (capturing) {
      detection.setRecording(true, { title, elapsedMilliseconds: recordedRef.current, paused });
    } else {
      detection.setRecording(false);
    }
  }, [capturing, title, paused]);
  return null;
}

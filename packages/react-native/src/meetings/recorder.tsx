/**
 * The app's one meeting recorder, held above the screens so a recording keeps
 * going while the person moves around the app (and, with the native module,
 * while the phone is locked or another app is in front).
 *
 * Audio is written to the phone's storage as it is captured and uploaded in the
 * background. Unsent audio is kept per `storeScope` (the signed-in account) and
 * only ever uploaded with that account's client; recordings the app could not
 * finish (killed, offline) finish the next time that account is active.
 */
import { useRecorder, type UseRecorderResult } from "@opengeni/react/recordings";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useNativeRecorderPlatform, type NativeRecorderPlatformOptions } from "../recordings";

export type MeetingRecorder = UseRecorderResult & {
  /** Recordings whose upload finished while the app was open, newest last. */
  finished: readonly string[];
};

const MeetingRecorderContext = createContext<MeetingRecorder | null>(null);

export type MeetingRecorderProviderProps = NativeRecorderPlatformOptions & {
  /** The SDK client recordings upload with. The provider's client otherwise. */
  client?: object;
  /** The workspace recordings are made in. The provider's workspace otherwise. */
  workspaceId?: string;
  children: ReactNode;
};

/**
 * Hold one recorder for everything below. Give it a new `key` when the account
 * changes: a new account is a new client and a new store, so a fresh recorder.
 */
export function MeetingRecorderProvider({
  client,
  workspaceId,
  children,
  ...platformOptions
}: MeetingRecorderProviderProps) {
  const platform = useNativeRecorderPlatform(platformOptions);
  const [finished, setFinished] = useState<readonly string[]>([]);
  const recorder = useRecorder({
    ...(client ? { client } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    platform,
    onFinished: (recordingId) =>
      setFinished((previous) => [...previous.filter((id) => id !== recordingId), recordingId]),
  });
  // The recorder's result is new on each of its updates, so this changes exactly then.
  const value = useMemo(() => ({ ...recorder, finished }), [recorder, finished]);
  return (
    <MeetingRecorderContext.Provider value={value}>{children}</MeetingRecorderContext.Provider>
  );
}

/** The live recorder, or null outside a {@link MeetingRecorderProvider}. */
export function useMeetingRecorder(): MeetingRecorder | null {
  return useContext(MeetingRecorderContext);
}

/** True while capture holds the microphone. */
export function isCapturing(recorder: MeetingRecorder | null): boolean {
  const state = recorder?.state;
  return (
    state === "starting" || state === "recording" || state === "paused" || state === "stopping"
  );
}

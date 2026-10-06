import { useCallback, useEffect, useRef, useState } from "react";

/** A finished recording on the device. */
export interface NativeVoiceRecording {
  uri: string;
  mimeType: string;
  durationSeconds: number;
}

/**
 * The platform recorder behind dictation. The Expo implementation lives in
 * `@opengeni/react-native/expo` (`useExpoVoiceRecorder`).
 */
export interface NativeVoiceRecorder {
  /** Ask for microphone access; resolves false when the person declines. */
  requestPermission(): Promise<boolean>;
  start(): Promise<void>;
  /** Stop and keep the recording; null when nothing was captured. */
  stop(): Promise<NativeVoiceRecording | null>;
  /** Stop and throw the recording away. */
  cancel(): Promise<void>;
  /** Seconds captured so far while recording. */
  durationSeconds(): number;
  /** The current input level from 0 to 1 while recording, when the platform meters it. */
  level(): number | null;
}

export type NativeVoiceInputStatus =
  | "idle"
  | "requesting-permission"
  | "recording"
  | "transcribing"
  | "error";

export interface NativeVoiceInput {
  /** Dictation is offered: a recorder exists and the deployment can transcribe. */
  available: boolean;
  status: NativeVoiceInputStatus;
  error: string | null;
  durationSeconds: number;
  /** Input level from 0 to 1 while recording (null when not metered). */
  level: number | null;
  /** Recording stops and transcribes automatically after this many seconds. */
  maxDurationSeconds: number | null;
  start(): void;
  /** Stop, transcribe and append the text to the draft. */
  stop(): void;
  cancel(): void;
  clearError(): void;
}

/** Append dictated text to the draft, as the web composer does. */
export function appendDictation(draft: string, transcript: string): string {
  const final = transcript.trim();
  if (!final) return draft;
  if (!draft) return final;
  return /\s$/u.test(draft) ? `${draft}${final}` : `${draft} ${final}`;
}

/**
 * Dictation for a native composer: record on the device, send the audio to the
 * deployment's transcription API, and append the text to the draft. The draft
 * is read at completion, so typing while transcribing is preserved.
 */
export function useNativeVoiceInput(input: {
  recorder: NativeVoiceRecorder | null;
  /** Whether the deployment offers transcription in this workspace. */
  available: boolean;
  maxDurationSeconds?: number | null | undefined;
  transcribe: (recording: NativeVoiceRecording) => Promise<string>;
  getValue: () => string;
  setValue: (value: string) => void;
  /** Host feedback (haptics) when recording starts and stops. */
  onFeedback?: ((event: "start" | "stop" | "cancel") => void) | undefined;
  /** Scope key; changing it cancels a running capture (another session or workspace). */
  scope?: string | undefined;
}): NativeVoiceInput {
  const [status, setStatus] = useState<NativeVoiceInputStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [level, setLevel] = useState<number | null>(null);
  const generation = useRef(0);
  const statusRef = useRef<NativeVoiceInputStatus>("idle");
  const latest = useRef(input);
  latest.current = input;
  const maxDurationSeconds = input.maxDurationSeconds ?? null;

  const update = useCallback((next: NativeVoiceInputStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const finish = useCallback(async () => {
    const recorder = latest.current.recorder;
    if (!recorder || statusRef.current !== "recording") return;
    const ticket = generation.current;
    latest.current.onFeedback?.("stop");
    update("transcribing");
    setLevel(null);
    try {
      const recording = await recorder.stop();
      if (ticket !== generation.current) return;
      if (!recording || recording.durationSeconds < 0.3) {
        update("idle");
        return;
      }
      const text = await latest.current.transcribe(recording);
      if (ticket !== generation.current) return;
      latest.current.setValue(appendDictation(latest.current.getValue(), text));
      update("idle");
    } catch (cause) {
      if (ticket !== generation.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      update("error");
    }
  }, [update]);

  const start = useCallback(() => {
    const recorder = latest.current.recorder;
    if (!recorder || !latest.current.available) return;
    if (statusRef.current === "recording" || statusRef.current === "transcribing") return;
    const ticket = ++generation.current;
    setError(null);
    setDurationSeconds(0);
    update("requesting-permission");
    void (async () => {
      try {
        const granted = await recorder.requestPermission();
        if (ticket !== generation.current) return;
        if (!granted) {
          setError("Allow microphone access in Settings to dictate.");
          update("error");
          return;
        }
        await recorder.start();
        if (ticket !== generation.current) {
          await recorder.cancel();
          return;
        }
        latest.current.onFeedback?.("start");
        update("recording");
      } catch (cause) {
        if (ticket !== generation.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        update("error");
      }
    })();
  }, [update]);

  const cancel = useCallback(() => {
    generation.current += 1;
    const recorder = latest.current.recorder;
    const wasRecording = statusRef.current === "recording";
    update("idle");
    setLevel(null);
    setDurationSeconds(0);
    if (wasRecording) latest.current.onFeedback?.("cancel");
    if (recorder && wasRecording) void recorder.cancel().catch(() => undefined);
  }, [update]);

  // Duration and level tick while recording; the cap stops and transcribes.
  useEffect(() => {
    if (status !== "recording") return;
    const timer = setInterval(() => {
      const recorder = latest.current.recorder;
      if (!recorder) return;
      const seconds = recorder.durationSeconds();
      setDurationSeconds(seconds);
      setLevel(recorder.level());
      if (maxDurationSeconds !== null && seconds >= maxDurationSeconds) void finish();
    }, 100);
    return () => clearInterval(timer);
  }, [finish, maxDurationSeconds, status]);

  // Leaving the scope (another session or workspace) drops a running capture.
  const scope = input.scope;
  useEffect(() => () => cancel(), [cancel, scope]);

  return {
    available: Boolean(input.recorder) && input.available,
    status,
    error,
    durationSeconds,
    level,
    maxDurationSeconds,
    start,
    stop: () => void finish(),
    cancel,
    clearError: () => {
      setError(null);
      if (statusRef.current === "error") update("idle");
    },
  };
}

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
  /**
   * Stop and keep the recording; null when nothing was captured. The file must
   * survive a following `start()`: dictation keeps it until its text is in the
   * draft, then calls `discard`.
   */
  stop(): Promise<NativeVoiceRecording | null>;
  /** Stop and throw the current recording away. */
  cancel(): Promise<void>;
  /** Delete a kept recording file once it is no longer needed. */
  discard?(recording: NativeVoiceRecording): void;
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
  /** Total seconds captured in this dictation, across segments. */
  durationSeconds: number;
  /** Input level from 0 to 1 while recording (null when not metered). */
  level: number | null;
  /**
   * Always null: long dictation rolls over into segments under the server's
   * per-request limit, so there is no recording cap to count down to.
   */
  maxDurationSeconds: number | null;
  /** A finished recording is kept on the device after a failed transcription. */
  hasSavedRecording: boolean;
  start(): void;
  /** Stop, transcribe and append the text to the draft. */
  stop(): void;
  /** Throw the current dictation away (recording or saved). */
  cancel(): void;
  /** Transcribe a saved recording again. */
  retry(): void;
  /** Hide the error message; a saved recording stays available to retry. */
  clearError(): void;
}

/** Append dictated text to the draft, as the web composer does. */
export function appendDictation(draft: string, transcript: string): string {
  const final = transcript.trim();
  if (!final) return draft;
  if (!draft) return final;
  return /\s$/u.test(draft) ? `${draft}${final}` : `${draft} ${final}`;
}

/** An error from the transcription request, with the HTTP status when there was one. */
export class NativeTranscriptionError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "NativeTranscriptionError";
    this.status = status;
  }
}

/**
 * Whether trying the same audio again can succeed: network failures, timeouts,
 * rate limits and server errors. Rejections of the audio itself (bad request,
 * too large, unsupported, forbidden) do not change on retry.
 */
export function isRetryableTranscriptionError(cause: unknown): boolean {
  const status = cause instanceof NativeTranscriptionError ? cause.status : null;
  if (status === null) return true;
  return status === 408 || status === 425 || status === 429 || status === 499 || status >= 500;
}

/** Delays between automatic attempts; the recording is kept whatever happens. */
export const TRANSCRIPTION_RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;

/**
 * Where a long recording rolls over into a new segment: a little under the
 * server's per-request limit, so a segment is never rejected as too long.
 */
export function dictationSegmentSeconds(maxDurationSeconds: number | null): number | null {
  if (maxDurationSeconds === null || !(maxDurationSeconds > 0)) return null;
  return Math.max(1, maxDurationSeconds - Math.min(3, maxDurationSeconds * 0.1));
}

type Segment = { recording: NativeVoiceRecording; text: string | null };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Dictation for a native composer: record on the device, send the audio to the
 * deployment's transcription API, and append the text to the draft. The draft
 * is read at completion, so typing while transcribing is preserved.
 *
 * Nothing said is lost: a long recording rolls over into segments under the
 * per-request limit (transcribed in the background while recording goes on),
 * failed requests are retried, and a recording whose text could not be fetched
 * stays on the device until it is transcribed or the person discards it.
 */
export function useNativeVoiceInput(input: {
  recorder: NativeVoiceRecorder | null;
  /** Whether the deployment offers transcription in this workspace. */
  available: boolean;
  /** The server's per-request duration limit; long dictation is segmented under it. */
  maxDurationSeconds?: number | null | undefined;
  transcribe: (recording: NativeVoiceRecording) => Promise<string>;
  getValue: () => string;
  setValue: (value: string) => void;
  /** Host feedback (haptics) when recording starts and stops. */
  onFeedback?: ((event: "start" | "stop" | "cancel") => void) | undefined;
  /** Scope key; changing it cancels a running capture (another session or workspace). */
  scope?: string | undefined;
  /** Test seam for the retry delays. */
  retryDelaysMs?: readonly number[] | undefined;
}): NativeVoiceInput {
  const [status, setStatus] = useState<NativeVoiceInputStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [level, setLevel] = useState<number | null>(null);
  const [hasSavedRecording, setHasSavedRecording] = useState(false);
  const generation = useRef(0);
  const statusRef = useRef<NativeVoiceInputStatus>("idle");
  const segments = useRef<Segment[]>([]);
  const inFlight = useRef(new Map<Segment, Promise<void>>());
  const capturedBefore = useRef(0);
  const rolling = useRef(false);
  const latest = useRef(input);
  latest.current = input;
  const segmentSeconds = dictationSegmentSeconds(input.maxDurationSeconds ?? null);

  const update = useCallback((next: NativeVoiceInputStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const discardAll = useCallback(() => {
    const recorder = latest.current.recorder;
    for (const segment of segments.current) recorder?.discard?.(segment.recording);
    segments.current = [];
    inFlight.current.clear();
    capturedBefore.current = 0;
    setHasSavedRecording(false);
  }, []);

  /** Transcribe one segment, retrying transient failures; resolves either way. */
  const transcribeSegment = useCallback((segment: Segment): Promise<void> => {
    if (segment.text !== null) return Promise.resolve();
    const running = inFlight.current.get(segment);
    if (running) return running;
    const work = (async () => {
      const delays = latest.current.retryDelaysMs ?? TRANSCRIPTION_RETRY_DELAYS_MS;
      const limit = latest.current.maxDurationSeconds ?? null;
      // The reported length never exceeds the limit: a recording stopped a
      // moment after the cap must not be rejected as too long.
      const recording =
        limit !== null && segment.recording.durationSeconds > limit
          ? { ...segment.recording, durationSeconds: limit }
          : segment.recording;
      for (let attempt = 0; ; attempt += 1) {
        try {
          segment.text = await latest.current.transcribe(recording);
          return;
        } catch (cause) {
          if (attempt >= delays.length || !isRetryableTranscriptionError(cause)) throw cause;
          await wait(delays[attempt]!);
        }
      }
    })().finally(() => inFlight.current.delete(segment));
    inFlight.current.set(segment, work);
    return work;
  }, []);

  /** Transcribe every kept segment in order and append the text once all are in. */
  const complete = useCallback(
    async (ticket: number) => {
      update("transcribing");
      setError(null);
      try {
        for (const segment of [...segments.current]) {
          await transcribeSegment(segment);
          if (ticket !== generation.current) return;
        }
        const text = segments.current
          .map((segment) => segment.text?.trim() ?? "")
          .filter(Boolean)
          .join(" ");
        latest.current.setValue(appendDictation(latest.current.getValue(), text));
        discardAll();
        update("idle");
      } catch (cause) {
        if (ticket !== generation.current) return;
        // The recording stays on the device; Retry sends the same audio again.
        setHasSavedRecording(true);
        setError(
          isRetryableTranscriptionError(cause)
            ? "Couldn't reach transcription. Your recording is saved. Retry when you're back online."
            : `Couldn't transcribe this recording${
                cause instanceof Error && cause.message ? ` (${cause.message})` : ""
              }. It's saved, so you can retry.`,
        );
        update("error");
      }
    },
    [discardAll, transcribeSegment, update],
  );

  const finish = useCallback(async () => {
    const recorder = latest.current.recorder;
    if (!recorder || statusRef.current !== "recording") return;
    const ticket = generation.current;
    latest.current.onFeedback?.("stop");
    update("transcribing");
    setLevel(null);
    // A rollover in progress hands over its segment before the final stop.
    while (rolling.current) await wait(20);
    try {
      const recording = await recorder.stop();
      if (ticket !== generation.current) return;
      if (recording && recording.durationSeconds >= 0.3) {
        segments.current.push({ recording, text: null });
      } else if (recording) {
        recorder.discard?.(recording);
      }
    } catch {
      // The platform could not hand over the last segment; earlier ones are kept.
    }
    if (ticket !== generation.current) return;
    if (segments.current.length === 0) {
      capturedBefore.current = 0;
      update("idle");
      return;
    }
    await complete(ticket);
  }, [complete, update]);

  /** Close the current segment and keep recording into a new one. */
  const rollover = useCallback(async () => {
    const recorder = latest.current.recorder;
    if (!recorder || rolling.current || statusRef.current !== "recording") return;
    const ticket = generation.current;
    rolling.current = true;
    try {
      const recording = await recorder.stop();
      if (recording) {
        capturedBefore.current += recording.durationSeconds;
        const segment: Segment = { recording, text: null };
        segments.current.push(segment);
        // Start transcribing now; failures are retried again at the end.
        void transcribeSegment(segment).catch(() => undefined);
      }
      if (ticket !== generation.current || statusRef.current !== "recording") return;
      await recorder.start();
    } catch {
      if (ticket !== generation.current) return;
      // The microphone could not restart: keep what was captured and transcribe it.
      rolling.current = false;
      if (segments.current.length > 0) await complete(ticket);
      else update("idle");
      return;
    } finally {
      rolling.current = false;
    }
  }, [complete, transcribeSegment, update]);

  const start = useCallback(() => {
    const recorder = latest.current.recorder;
    if (!recorder || !latest.current.available) return;
    if (statusRef.current === "recording" || statusRef.current === "transcribing") return;
    // A saved recording is transcribed first; a new dictation never replaces it.
    if (segments.current.length > 0) {
      void complete(++generation.current);
      return;
    }
    const ticket = ++generation.current;
    setError(null);
    setDurationSeconds(0);
    capturedBefore.current = 0;
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
      } catch {
        if (ticket !== generation.current) return;
        // The platform's reason (no input device, audio session busy) is not actionable.
        setError("Couldn't start the microphone. Try again.");
        update("error");
      }
    })();
  }, [complete, update]);

  const cancel = useCallback(() => {
    generation.current += 1;
    const recorder = latest.current.recorder;
    const wasRecording = statusRef.current === "recording";
    update("idle");
    setError(null);
    setLevel(null);
    setDurationSeconds(0);
    if (wasRecording) latest.current.onFeedback?.("cancel");
    if (recorder && wasRecording) void recorder.cancel().catch(() => undefined);
    discardAll();
  }, [discardAll, update]);

  const retry = useCallback(() => {
    if (segments.current.length === 0 || statusRef.current === "transcribing") return;
    const ticket = ++generation.current;
    void complete(ticket);
  }, [complete]);

  // Duration and level tick while recording; near the per-request limit the
  // recording rolls over into a new segment instead of stopping.
  useEffect(() => {
    if (status !== "recording") return;
    const timer = setInterval(() => {
      const recorder = latest.current.recorder;
      if (!recorder || rolling.current) return;
      const seconds = recorder.durationSeconds();
      setDurationSeconds(capturedBefore.current + seconds);
      setLevel(recorder.level());
      if (segmentSeconds !== null && seconds >= segmentSeconds) void rollover();
    }, 100);
    return () => clearInterval(timer);
  }, [rollover, segmentSeconds, status]);

  // Leaving the scope (another session or workspace) drops a running capture.
  const scope = input.scope;
  useEffect(() => () => cancel(), [cancel, scope]);

  return {
    available: Boolean(input.recorder) && input.available,
    status,
    error,
    durationSeconds,
    level,
    maxDurationSeconds: null,
    hasSavedRecording,
    start,
    stop: () => void finish(),
    cancel,
    retry,
    clearError: () => {
      setError(null);
      if (statusRef.current === "error" && segments.current.length === 0) update("idle");
    },
  };
}

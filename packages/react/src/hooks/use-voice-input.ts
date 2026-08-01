import type { ClientVoiceInputConfig, OpenGeniClient } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { appendFinalTranscript } from "./use-transcription";

export type VoiceInputStatus =
  | "idle"
  | "requesting-permission"
  | "recording"
  | "transcribing"
  | "error";

export type UseVoiceInputOptions = {
  client: Pick<OpenGeniClient, "transcribeAudio"> | null;
  workspaceId: string;
  capability: ClientVoiceInputConfig | null;
  enabled: boolean;
  value: string;
  setValue: (value: string) => void;
  focusInput: () => void;
  disabled?: boolean | undefined;
};

export type UseVoiceInputResult = {
  status: VoiceInputStatus;
  error: string | null;
  available: boolean;
  /** Live mic stream while recording; null once stopped/cancelled. */
  stream: MediaStream | null;
  start: () => Promise<boolean>;
  /** Stop capture and immediately upload/transcribe into the draft (no Send). */
  stop: () => void;
  /** Discard the in-flight recording or transcription; Escape also cancels. */
  cancel: () => void;
};

const MIME_PREFERENCES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];

export function useVoiceInput({
  client,
  workspaceId,
  capability,
  enabled,
  value,
  setValue,
  focusInput,
  disabled = false,
}: UseVoiceInputOptions): UseVoiceInputResult {
  const [status, setStatus] = useState<VoiceInputStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const generationRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const clearRuntime = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setStream(null);
  }, []);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    const recorder = recorderRef.current;
    clearRuntime();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    setStatus("idle");
    setError(null);
    focusInput();
  }, [clearRuntime, focusInput]);

  const stop = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setStatus("transcribing");
    recorder.stop();
  };

  const start = async (): Promise<boolean> => {
    if (
      disabled ||
      !client ||
      !enabled ||
      !capability?.available ||
      status === "requesting-permission" ||
      status === "recording" ||
      status === "transcribing" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      return false;
    }
    const voiceClient = client;
    const generation = ++generationRef.current;
    setStatus("requesting-permission");
    setError(null);
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== generationRef.current) {
        mediaStream.getTracks().forEach((track) => track.stop());
        return false;
      }
      const mimeType = chooseMimeType(capability.acceptedMimeTypes);
      const recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      const startedAt = Date.now();
      streamRef.current = mediaStream;
      recorderRef.current = recorder;
      setStream(mediaStream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        clearRuntime();
        if (generation !== generationRef.current) return;
        const audio = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        if (audio.size === 0) {
          setStatus("error");
          setError("invalid_audio");
          return;
        }
        const controller = new AbortController();
        controllerRef.current = controller;
        void voiceClient
          .transcribeAudio(workspaceId, {
            audio,
            mimeType: audio.type,
            durationSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
            signal: controller.signal,
          })
          .then((response) => {
            if (generation !== generationRef.current || controller.signal.aborted) return;
            const next = appendFinalTranscript(valueRef.current, response.text);
            if (next !== valueRef.current) {
              valueRef.current = next;
              setValue(next);
            }
            setStatus("idle");
            focusInput();
          })
          .catch((reason: unknown) => {
            if (generation !== generationRef.current || controller.signal.aborted) return;
            setStatus("error");
            setError(errorCode(reason));
          })
          .finally(() => {
            if (controllerRef.current === controller) controllerRef.current = null;
          });
      };
      recorder.start();
      setStatus("recording");
      timerRef.current = setTimeout(
        () => stop(),
        Math.min(capability.maxDurationSeconds, 60) * 1000,
      );
      return true;
    } catch (reason) {
      if (generation !== generationRef.current) return false;
      clearRuntime();
      setStatus("error");
      setError(errorCode(reason));
      return false;
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && status !== "idle") {
        event.preventDefault();
        cancel();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [cancel, status]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      const recorder = recorderRef.current;
      clearRuntime();
      if (recorder && recorder.state !== "inactive") recorder.stop();
    },
    [clearRuntime],
  );

  return {
    status,
    error,
    available: Boolean(capability?.available && enabled && !disabled),
    stream,
    start,
    stop,
    cancel,
  };
}

function chooseMimeType(accepted: string[]): string | undefined {
  const normalized = accepted.map((value) => value.trim().toLowerCase());
  return MIME_PREFERENCES.find((mimeType) => {
    const bare = mimeType.split(";")[0] ?? mimeType;
    const allowed =
      normalized.includes(mimeType) ||
      normalized.includes(bare) ||
      normalized.some((candidate) => candidate.split(";")[0] === bare);
    return (
      allowed &&
      (typeof MediaRecorder.isTypeSupported !== "function" ||
        MediaRecorder.isTypeSupported(mimeType))
    );
  });
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") return "permission_denied";
  if (error instanceof DOMException && error.name === "NotSupportedError") return "not_supported";
  return "unknown";
}

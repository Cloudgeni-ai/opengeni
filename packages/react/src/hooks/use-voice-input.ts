import type { ClientVoiceInputConfig, OpenGeniClient } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IndexedDbVoiceRecordingStore,
  VoiceRecordingStorageUnavailableError,
  createVoiceRecordingManifest,
  type VoiceRecordingManifest,
  type VoiceRecordingStore,
} from "../voice-recording-store";
import { appendFinalTranscript } from "./use-transcription";

export type VoiceInputStatus =
  | "idle"
  | "requesting-permission"
  | "recording"
  | "saving"
  | "transcribing"
  | "recovered"
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
  /** Test/embed seam. Production defaults to the origin-scoped IndexedDB store. */
  createRecordingStore?: (() => VoiceRecordingStore) | undefined;
  createRecordingId?: (() => string) | undefined;
  now?: (() => Date) | undefined;
};

export type UseVoiceInputResult = {
  status: VoiceInputStatus;
  error: string | null;
  available: boolean;
  /** Live mic stream while recording; null once stopped/cancelled. */
  stream: MediaStream | null;
  recordingId: string | null;
  durationSeconds: number;
  locallySaved: boolean;
  hasRecoverableRecording: boolean;
  start: () => Promise<boolean>;
  /** Stop capture, durably settle the final chunk, then transcribe into the draft. */
  stop: () => void;
  /** Retry finalization/transcription from the already-persisted recording. */
  retry: () => void;
  /** Cancel active work. A stopped/transcribing recording remains recoverable. */
  cancel: () => void;
  /** Intentionally delete the current durable recording. */
  discard: () => Promise<void>;
};

export const VOICE_RECORDING_TIMESLICE_MILLISECONDS = 5_000;

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
  createRecordingStore,
  createRecordingId = () => crypto.randomUUID(),
  now = () => new Date(),
}: UseVoiceInputOptions): UseVoiceInputResult {
  const [status, setStatus] = useState<VoiceInputStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [locallySaved, setLocallySaved] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(
    () => Boolean(createRecordingStore) || typeof globalThis.indexedDB !== "undefined",
  );
  const generationRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const valueRef = useRef(value);
  const storeRef = useRef<VoiceRecordingStore | null>(null);
  const storePromiseRef = useRef<Promise<VoiceRecordingStore> | null>(null);
  const ownsStoreRef = useRef(false);
  const manifestRef = useRef<VoiceRecordingManifest | null>(null);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const persistenceErrorRef = useRef<unknown>(null);
  const captureSettledRef = useRef<Promise<void>>(Promise.resolve());
  const resolveCaptureSettledRef = useRef<(() => void) | null>(null);
  const nextChunkNumberRef = useRef(0);
  const lastChunkEndMillisecondsRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  valueRef.current = value;

  const clearCaptureRuntime = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setStream(null);
  }, []);

  const clearVisibleRecording = useCallback(() => {
    manifestRef.current = null;
    setRecordingId(null);
    setDurationSeconds(0);
    setLocallySaved(false);
  }, []);

  const ensureStore = useCallback(async (): Promise<VoiceRecordingStore> => {
    if (storeRef.current) return storeRef.current;
    if (!storePromiseRef.current) {
      storePromiseRef.current = Promise.resolve().then(() => {
        const store = createRecordingStore?.() ?? new IndexedDbVoiceRecordingStore();
        ownsStoreRef.current = createRecordingStore === undefined;
        storeRef.current = store;
        setStorageAvailable(true);
        return store;
      });
    }
    try {
      return await storePromiseRef.current;
    } catch (reason) {
      storePromiseRef.current = null;
      if (reason instanceof VoiceRecordingStorageUnavailableError) setStorageAvailable(false);
      throw reason;
    }
  }, [createRecordingStore]);

  const rememberManifest = useCallback((manifest: VoiceRecordingManifest) => {
    manifestRef.current = manifest;
    setRecordingId(manifest.recordingId);
    setDurationSeconds(manifest.totalDurationMilliseconds / 1_000);
    setLocallySaved(manifest.chunkCount > 0);
  }, []);

  const preserveForRetry = useCallback(
    async (manifest: VoiceRecordingManifest, code: string | null, generation: number) => {
      if (generation !== generationRef.current) return;
      rememberManifest(manifest);
      setStatus(code ? "error" : "recovered");
      setError(code);
      focusInput();
    },
    [focusInput, rememberManifest],
  );

  const updateManifestBestEffort = useCallback(
    async (
      manifest: VoiceRecordingManifest,
      update: Parameters<VoiceRecordingStore["updateManifest"]>[1],
    ): Promise<VoiceRecordingManifest> => {
      try {
        return await (
          await ensureStore()
        ).updateManifest(manifest.recordingId, update, now().toISOString());
      } catch {
        return manifest;
      }
    },
    [ensureStore, now],
  );

  const finalizePersistedRecording = useCallback(
    async (generation: number): Promise<void> => {
      const manifest = manifestRef.current;
      if (!manifest || !client || manifest.workspaceId !== workspaceId) return;
      let store: VoiceRecordingStore | null = null;
      let transcribing = manifest;
      let controller: AbortController | null = null;
      let response: { text: string } | null = null;
      try {
        store = await ensureStore();
        transcribing = await updateManifestBestEffort(manifest, {
          captureState: "stopped",
          uploadState: "syncing",
          transcriptionState: "transcribing",
        });
        if (generation !== generationRef.current) return;
        rememberManifest(transcribing);
        setStatus("transcribing");
        setError(null);
        const chunks = await store.listChunks(transcribing.recordingId);
        if (chunks.length === 0) {
          const retained = await updateManifestBestEffort(transcribing, {
            uploadState: "retrying",
            transcriptionState: "retrying",
          });
          await preserveForRetry(retained, "invalid_audio", generation);
          return;
        }
        const audio = new Blob(
          chunks
            .sort((left, right) => left.chunkNumber - right.chunkNumber)
            .map((chunk) => chunk.audio),
          { type: transcribing.mimeType },
        );
        controller = new AbortController();
        controllerRef.current = controller;
        response = await client.transcribeAudio(workspaceId, {
          audio,
          mimeType: audio.type,
          durationSeconds: transcribing.totalDurationMilliseconds / 1_000,
          signal: controller.signal,
        });
        if (generation !== generationRef.current || controller.signal.aborted) return;
      } catch (reason) {
        if (generation !== generationRef.current) return;
        const retained = await updateManifestBestEffort(transcribing, {
          uploadState: "retrying",
          transcriptionState: "retrying",
        });
        await preserveForRetry(
          retained,
          controller?.signal.aborted ? null : errorCode(reason),
          generation,
        );
        return;
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }

      if (!store || !response || generation !== generationRef.current) return;
      const ready = await updateManifestBestEffort(transcribing, {
        uploadState: "complete",
        transcriptionState: "complete",
        finalizationState: "ready",
      });
      if (generation !== generationRef.current) return;
      rememberManifest(ready);
      const next = appendFinalTranscript(valueRef.current, response.text);
      if (next !== valueRef.current) {
        valueRef.current = next;
        setValue(next);
      }
      const handedOff = await updateManifestBestEffort(ready, {
        finalizationState: "handed-off",
      });
      await store.discard(handedOff.recordingId).catch(() => undefined);
      if (
        generation !== generationRef.current ||
        manifestRef.current?.recordingId !== handedOff.recordingId
      ) {
        return;
      }
      clearVisibleRecording();
      setStatus("idle");
      setError(null);
      focusInput();
    },
    [
      clearVisibleRecording,
      client,
      ensureStore,
      focusInput,
      preserveForRetry,
      rememberManifest,
      setValue,
      updateManifestBestEffort,
      workspaceId,
    ],
  );

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setStatus("saving");
    recorder.stop();
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (
      disabled ||
      !client ||
      !enabled ||
      !capability?.available ||
      manifestRef.current !== null ||
      status === "requesting-permission" ||
      status === "recording" ||
      status === "saving" ||
      status === "transcribing" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      return false;
    }
    let store: VoiceRecordingStore;
    try {
      store = await ensureStore();
    } catch (reason) {
      setStatus("error");
      setError(
        reason instanceof VoiceRecordingStorageUnavailableError
          ? "storage_unavailable"
          : errorCode(reason),
      );
      return false;
    }
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
      const createdAt = now();
      const manifest = createVoiceRecordingManifest({
        recordingId: createRecordingId(),
        workspaceId,
        mimeType: recorder.mimeType || mimeType || "audio/webm",
        createdAt: createdAt.toISOString(),
      });
      await store.createManifest(manifest);
      if (generation !== generationRef.current) {
        await store.discard(manifest.recordingId);
        mediaStream.getTracks().forEach((track) => track.stop());
        return false;
      }
      rememberManifest(manifest);
      persistenceQueueRef.current = Promise.resolve();
      persistenceErrorRef.current = null;
      nextChunkNumberRef.current = 0;
      lastChunkEndMillisecondsRef.current = 0;
      streamRef.current = mediaStream;
      recorderRef.current = recorder;
      setStream(mediaStream);
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0 || persistenceErrorRef.current) return;
        const chunkNumber = nextChunkNumberRef.current++;
        const elapsed = Math.max(0, now().getTime() - recordingStartedAtRef.current);
        const eventTimecode = Number.isFinite(event.timecode) ? Math.max(0, event.timecode) : 0;
        const endMilliseconds = Math.max(
          lastChunkEndMillisecondsRef.current,
          eventTimecode,
          elapsed,
        );
        const startMilliseconds = lastChunkEndMillisecondsRef.current;
        const durationMilliseconds = Math.max(0, endMilliseconds - startMilliseconds);
        lastChunkEndMillisecondsRef.current = endMilliseconds;
        persistenceQueueRef.current = persistenceQueueRef.current
          .then(async () => {
            const result = await store.persistChunk({
              recordingId: manifest.recordingId,
              chunkNumber,
              capturedAt: now().toISOString(),
              startMilliseconds,
              durationMilliseconds,
              mimeType: manifest.mimeType,
              audio: event.data,
            });
            if (generation !== generationRef.current) return;
            rememberManifest(result.manifest);
          })
          .catch((reason: unknown) => {
            persistenceErrorRef.current = reason;
            if (recorder.state !== "inactive") recorder.stop();
          });
      };
      recorder.onstop = () => {
        clearCaptureRuntime();
        void persistenceQueueRef.current
          .catch((reason: unknown) => {
            persistenceErrorRef.current = reason;
          })
          .then(async () => {
            const resolveSettled = resolveCaptureSettledRef.current;
            resolveCaptureSettledRef.current = null;
            resolveSettled?.();
            if (generation !== generationRef.current) return;
            const current = manifestRef.current ?? manifest;
            const stopped = await updateManifestBestEffort(current, { captureState: "stopped" });
            rememberManifest(stopped);
            if (persistenceErrorRef.current) {
              await preserveForRetry(stopped, "storage_unavailable", generation);
              return;
            }
            await finalizePersistedRecording(generation);
          });
      };
      captureSettledRef.current = new Promise<void>((resolve) => {
        resolveCaptureSettledRef.current = resolve;
      });
      recordingStartedAtRef.current = now().getTime();
      recorder.start(VOICE_RECORDING_TIMESLICE_MILLISECONDS);
      setStatus("recording");
      timerRef.current = setTimeout(stop, capability.maxDurationSeconds * 1_000);
      return true;
    } catch (reason) {
      const resolveSettled = resolveCaptureSettledRef.current;
      resolveCaptureSettledRef.current = null;
      resolveSettled?.();
      if (generation !== generationRef.current) return false;
      clearCaptureRuntime();
      const manifest = manifestRef.current;
      if (manifest) {
        const retained = await updateManifestBestEffort(manifest, { captureState: "stopped" });
        await preserveForRetry(
          retained,
          reason instanceof VoiceRecordingStorageUnavailableError
            ? "storage_unavailable"
            : errorCode(reason),
          generation,
        );
      } else {
        setStatus("error");
        setError(errorCode(reason));
      }
      return false;
    }
  }, [
    capability,
    clearCaptureRuntime,
    client,
    createRecordingId,
    disabled,
    enabled,
    ensureStore,
    finalizePersistedRecording,
    now,
    preserveForRetry,
    rememberManifest,
    status,
    stop,
    updateManifestBestEffort,
    workspaceId,
  ]);

  const retry = useCallback(() => {
    if (
      !manifestRef.current ||
      manifestRef.current.workspaceId !== workspaceId ||
      !client ||
      disabled ||
      !enabled ||
      status === "saving" ||
      status === "transcribing"
    ) {
      return;
    }
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    setError(null);
    void finalizePersistedRecording(generation);
  }, [client, disabled, enabled, finalizePersistedRecording, status, workspaceId]);

  const discard = useCallback(async (): Promise<void> => {
    const manifest = manifestRef.current;
    ++generationRef.current;
    controllerRef.current?.abort();
    controllerRef.current = null;
    const recorder = recorderRef.current;
    let captureSettled = persistenceQueueRef.current;
    if (recorder && recorder.state !== "inactive") {
      captureSettled = captureSettledRef.current;
      recorder.stop();
    }
    clearCaptureRuntime();
    await captureSettled.catch(() => undefined);
    if (manifest) await (await ensureStore()).discard(manifest.recordingId).catch(() => undefined);
    clearVisibleRecording();
    persistenceErrorRef.current = null;
    setStatus("idle");
    setError(null);
    focusInput();
  }, [clearCaptureRuntime, clearVisibleRecording, ensureStore, focusInput]);

  const cancel = useCallback(() => {
    if (status === "recording" || status === "requesting-permission") {
      void discard();
      return;
    }
    if (status === "saving" || status === "transcribing") {
      const generation = ++generationRef.current;
      controllerRef.current?.abort();
      controllerRef.current = null;
      const captureSettled = status === "saving" ? captureSettledRef.current : Promise.resolve();
      void captureSettled.then(async () => {
        const manifest = manifestRef.current;
        if (!manifest) return;
        const retained = await updateManifestBestEffort(manifest, {
          captureState: "stopped",
          uploadState: "retrying",
          transcriptionState: "retrying",
        });
        await preserveForRetry(retained, null, generation);
      });
    }
  }, [discard, preserveForRetry, status, updateManifestBestEffort]);

  useEffect(() => {
    let disposed = false;
    const current = manifestRef.current;
    if (current && current.workspaceId !== workspaceId) {
      ++generationRef.current;
      controllerRef.current?.abort();
      controllerRef.current = null;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      clearCaptureRuntime();
      clearVisibleRecording();
      setStatus("idle");
      setError(null);
    }
    void ensureStore()
      .then((store) => store.listRecoverableManifests(workspaceId))
      .then((manifests) => {
        if (disposed || manifestRef.current) return;
        const manifest = manifests.at(-1);
        if (!manifest) return;
        rememberManifest(manifest);
        setStatus("recovered");
        setError(null);
      })
      .catch((reason: unknown) => {
        if (reason instanceof VoiceRecordingStorageUnavailableError) setStorageAvailable(false);
      });
    return () => {
      disposed = true;
    };
  }, [clearCaptureRuntime, clearVisibleRecording, ensureStore, rememberManifest, workspaceId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        (status === "requesting-permission" ||
          status === "recording" ||
          status === "saving" ||
          status === "transcribing")
      ) {
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
      let captureSettled = persistenceQueueRef.current;
      if (recorder && recorder.state !== "inactive") {
        captureSettled = captureSettledRef.current;
        recorder.stop();
      }
      clearCaptureRuntime();
      if (ownsStoreRef.current) {
        void captureSettled
          .catch(() => undefined)
          .then(() => storeRef.current?.close())
          .catch(() => undefined);
      }
    },
    [clearCaptureRuntime],
  );

  return {
    status,
    error,
    available: Boolean(capability?.available && enabled && !disabled && storageAvailable),
    stream,
    recordingId,
    durationSeconds,
    locallySaved,
    hasRecoverableRecording: manifestRef.current !== null && status !== "recording",
    start,
    stop,
    retry,
    cancel,
    discard,
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

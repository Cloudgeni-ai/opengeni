import type { ClientVoiceInputConfig, OpenGeniClient } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IndexedDbVoiceRecordingStore,
  VoiceRecordingOwnedError,
  VoiceRecordingStorageUnavailableError,
  createVoiceRecordingManifest,
  type VoiceRecordingManifest,
  type VoiceRecordingStore,
} from "../voice-recording-store";
import {
  acquireDefaultVoiceRecordingOwnerLease,
  type VoiceRecordingOwnerLease,
} from "../voice-recording-owner";
import { appendFinalTranscript } from "./use-transcription";

export type VoiceInputStatus =
  | "idle"
  | "requesting-permission"
  | "recording"
  | "saving"
  | "transcribing"
  | "recovered"
  | "transcript-ready"
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
  createOwnerId?: (() => string) | undefined;
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
  savedTranscript: string | null;
  start: () => Promise<boolean>;
  /** Stop capture, durably settle the final chunk, then transcribe into the draft. */
  stop: () => void;
  /** Retry finalization/transcription from the already-persisted recording. */
  retry: () => void;
  /** Explicitly insert a durably saved transcript whose prior handoff may be uncertain. */
  insertSavedTranscript: () => Promise<void>;
  /** Cancel active work. A stopped/transcribing recording remains recoverable. */
  cancel: () => void;
  /** Intentionally delete the current durable recording. */
  discard: () => Promise<void>;
};

export const VOICE_RECORDING_TIMESLICE_MILLISECONDS = 5_000;
export const VOICE_RECORDING_OWNER_HEARTBEAT_MILLISECONDS = 5_000;
export const VOICE_RECORDING_OWNER_STALE_MILLISECONDS = 30_000;
export const VOICE_RECORDING_CLIENT_MAX_DURATION_SECONDS = 600;

const MIME_PREFERENCES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
const createDefaultVoiceRecordingId = () => crypto.randomUUID();
const currentDate = () => new Date();

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
  createRecordingId = createDefaultVoiceRecordingId,
  createOwnerId,
  now = currentDate,
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
  const createRecordingStoreRef = useRef(createRecordingStore);
  createRecordingStoreRef.current = createRecordingStore;
  const nowRef = useRef(now);
  nowRef.current = now;
  const readNow = useCallback(() => nowRef.current(), []);
  const generationRef = useRef(0);
  const workspaceIdRef = useRef(workspaceId);
  const ownerIdRef = useRef<string | null>(null);
  const ownerLeaseRef = useRef<VoiceRecordingOwnerLease | null>(null);
  const ownerIdPromiseRef = useRef<Promise<string> | null>(null);
  const createOwnerIdRef = useRef(createOwnerId);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownerHeartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const valueRef = useRef(value);
  const storeRef = useRef<VoiceRecordingStore | null>(null);
  const storePromiseRef = useRef<Promise<VoiceRecordingStore> | null>(null);
  const ownsStoreRef = useRef(false);
  const manifestRef = useRef<VoiceRecordingManifest | null>(null);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const persistenceErrorRef = useRef<unknown>(null);
  const captureLimitErrorRef = useRef<string | null>(null);
  const captureSettledRef = useRef<Promise<void>>(Promise.resolve());
  const resolveCaptureSettledRef = useRef<(() => void) | null>(null);
  const nextChunkNumberRef = useRef(0);
  const lastChunkEndMillisecondsRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const statusRef = useRef(status);
  valueRef.current = value;
  statusRef.current = status;
  workspaceIdRef.current = workspaceId;

  const ensureOwnerId = useCallback(async (): Promise<string> => {
    if (ownerIdRef.current) return ownerIdRef.current;
    ownerIdPromiseRef.current ??= (async () => {
      const injectedOwnerId = createOwnerIdRef.current?.();
      if (injectedOwnerId) {
        ownerIdRef.current = injectedOwnerId;
        return injectedOwnerId;
      }
      const lease = await acquireDefaultVoiceRecordingOwnerLease();
      ownerLeaseRef.current = lease;
      ownerIdRef.current = lease.ownerId;
      return lease.ownerId;
    })();
    return await ownerIdPromiseRef.current;
  }, []);

  const stopOwnerHeartbeat = useCallback(() => {
    if (ownerHeartbeatTimerRef.current) clearInterval(ownerHeartbeatTimerRef.current);
    ownerHeartbeatTimerRef.current = null;
  }, []);

  const clearCaptureRuntime = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setStream(null);
  }, []);

  const clearVisibleRecording = useCallback(() => {
    stopOwnerHeartbeat();
    manifestRef.current = null;
    setRecordingId(null);
    setDurationSeconds(0);
    setLocallySaved(false);
  }, [stopOwnerHeartbeat]);

  const ensureStore = useCallback(async (): Promise<VoiceRecordingStore> => {
    if (storeRef.current) return storeRef.current;
    if (!storePromiseRef.current) {
      storePromiseRef.current = Promise.resolve().then(() => {
        const factory = createRecordingStoreRef.current;
        const store = factory?.() ?? new IndexedDbVoiceRecordingStore();
        ownsStoreRef.current = factory === undefined;
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
  }, []);

  const rememberManifest = useCallback((manifest: VoiceRecordingManifest) => {
    manifestRef.current = manifest;
    setRecordingId(manifest.recordingId);
    setDurationSeconds(manifest.totalDurationMilliseconds / 1_000);
    setLocallySaved(manifest.chunkCount > 0);
  }, []);

  const beginOwnerHeartbeat = useCallback(
    (manifest: VoiceRecordingManifest) => {
      stopOwnerHeartbeat();
      ownerHeartbeatTimerRef.current = setInterval(() => {
        if (
          manifestRef.current?.recordingId !== manifest.recordingId ||
          manifestRef.current.ownerId !== ownerIdRef.current
        ) {
          stopOwnerHeartbeat();
          return;
        }
        const updatedAt = readNow().toISOString();
        void ensureStore()
          .then((store) =>
            store.updateManifest(
              manifest.recordingId,
              { ownerHeartbeatAt: updatedAt },
              updatedAt,
              ownerIdRef.current ?? undefined,
            ),
          )
          .then((updated) => {
            if (manifestRef.current?.recordingId === updated.recordingId) {
              manifestRef.current = updated;
            }
          })
          .catch(() => undefined);
      }, VOICE_RECORDING_OWNER_HEARTBEAT_MILLISECONDS);
    },
    [ensureStore, readNow, stopOwnerHeartbeat],
  );

  const preserveForRetry = useCallback(
    async (manifest: VoiceRecordingManifest, code: string | null, generation: number) => {
      if (generation !== generationRef.current) return;
      rememberManifest(manifest);
      const transcriptReady =
        manifest.finalizationState === "transcript-ready" && manifest.transcriptText !== null;
      setStatus(transcriptReady ? "transcript-ready" : code ? "error" : "recovered");
      setError(transcriptReady ? "handoff_uncertain" : code);
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
        ).updateManifest(
          manifest.recordingId,
          update,
          readNow().toISOString(),
          ownerIdRef.current ?? undefined,
        );
      } catch {
        return manifest;
      }
    },
    [ensureStore, readNow],
  );

  const loadNextRecoverable = useCallback(
    async (generation: number): Promise<void> => {
      const active = () =>
        generation === generationRef.current && workspaceIdRef.current === workspaceId;
      const [store, ownerId] = await Promise.all([ensureStore(), ensureOwnerId()]);
      if (!active()) return;
      const staleBefore = new Date(
        readNow().getTime() - VOICE_RECORDING_OWNER_STALE_MILLISECONDS,
      ).toISOString();
      await store.cleanupHandedOffManifests({ ownerId, staleBefore }).catch(() => undefined);
      if (!active()) return;
      const manifests = await store.listRecoverableManifests(workspaceId, {
        ownerId,
        staleBefore,
      });
      if (!active()) return;
      for (const candidate of manifests) {
        try {
          const claimedAt = readNow().toISOString();
          const claimed = await store.claimManifest(
            candidate.recordingId,
            ownerId,
            claimedAt,
            staleBefore,
          );
          if (!active()) {
            await store
              .updateManifest(
                claimed.recordingId,
                { ownerId: null, ownerHeartbeatAt: null },
                readNow().toISOString(),
                ownerId,
              )
              .catch(() => undefined);
            return;
          }
          rememberManifest(claimed);
          beginOwnerHeartbeat(claimed);
          setStatus(
            claimed.finalizationState === "transcript-ready" && claimed.transcriptText !== null
              ? "transcript-ready"
              : "recovered",
          );
          setError(null);
          return;
        } catch (reason) {
          if (reason instanceof VoiceRecordingOwnedError) continue;
          throw reason;
        }
      }
      if (active() && !manifestRef.current) {
        setStatus("idle");
        setError(null);
      }
    },
    [beginOwnerHeartbeat, ensureOwnerId, ensureStore, readNow, rememberManifest, workspaceId],
  );

  const finalizePersistedRecording = useCallback(
    async (generation: number): Promise<void> => {
      const manifest = manifestRef.current;
      const maxSizeBytes = capability?.maxSizeBytes;
      if (!manifest || !client || !maxSizeBytes || manifest.workspaceId !== workspaceId) return;
      const controller = new AbortController();
      controllerRef.current?.abort();
      controllerRef.current = controller;
      const active = () =>
        generation === generationRef.current &&
        workspaceIdRef.current === workspaceId &&
        !controller.signal.aborted &&
        manifestRef.current?.recordingId === manifest.recordingId &&
        manifestRef.current.workspaceId === workspaceId;
      let transcribing = manifest;
      try {
        const store = await ensureStore();
        if (!active()) return;
        transcribing = await store.updateManifest(
          manifest.recordingId,
          {
            captureState: "stopped",
            uploadState: "syncing",
            transcriptionState: "transcribing",
            ownerHeartbeatAt: readNow().toISOString(),
          },
          readNow().toISOString(),
          ownerIdRef.current ?? undefined,
        );
        if (!active()) return;
        rememberManifest(transcribing);
        setStatus("transcribing");
        setError(null);
        if (transcribing.totalBytes > maxSizeBytes) {
          throw { code: "too_large" };
        }
        const chunks = await store.listChunks(transcribing.recordingId);
        if (!active()) return;
        if (chunks.length === 0) {
          const retained = await store.updateManifest(
            transcribing.recordingId,
            { uploadState: "retrying", transcriptionState: "retrying" },
            readNow().toISOString(),
            ownerIdRef.current ?? undefined,
          );
          if (!active()) return;
          await preserveForRetry(retained, "invalid_audio", generation);
          return;
        }
        const audio = new Blob(
          chunks
            .sort((left, right) => left.chunkNumber - right.chunkNumber)
            .map((chunk) => chunk.audio),
          { type: transcribing.mimeType },
        );
        if (!active()) return;
        if (audio.size > maxSizeBytes) throw { code: "too_large" };
        const response = await client.transcribeAudio(workspaceId, {
          audio,
          mimeType: audio.type,
          durationSeconds: transcribing.totalDurationMilliseconds / 1_000,
          signal: controller.signal,
        });
        if (!active()) return;
        const ready = await store.updateManifest(
          transcribing.recordingId,
          {
            uploadState: "complete",
            transcriptionState: "complete",
            finalizationState: "transcript-ready",
            transcriptText: response.text,
            ownerHeartbeatAt: readNow().toISOString(),
          },
          readNow().toISOString(),
          ownerIdRef.current ?? undefined,
        );
        if (!active()) return;
        rememberManifest(ready);

        const next = appendFinalTranscript(valueRef.current, response.text);
        if (next !== valueRef.current) {
          valueRef.current = next;
          setValue(next);
        }

        let handedOff: VoiceRecordingManifest;
        try {
          handedOff = await store.updateManifest(
            ready.recordingId,
            { finalizationState: "handed-off" },
            readNow().toISOString(),
            ownerIdRef.current ?? undefined,
          );
        } catch {
          if (!active()) return;
          rememberManifest(ready);
          setStatus("transcript-ready");
          setError("handoff_uncertain");
          focusInput();
          return;
        }
        if (!active()) return;
        rememberManifest(handedOff);
        await store
          .discard(handedOff.recordingId, ownerIdRef.current ?? undefined)
          .catch(() => undefined);
        if (!active()) return;
        clearVisibleRecording();
        setStatus("idle");
        setError(null);
        focusInput();
        await loadNextRecoverable(generation);
      } catch (reason) {
        if (!active()) return;
        const retained = await updateManifestBestEffort(transcribing, {
          uploadState: "retrying",
          transcriptionState: "retrying",
        });
        if (!active()) return;
        await preserveForRetry(
          retained,
          controller.signal.aborted ? null : errorCode(reason),
          generation,
        );
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [
      capability?.maxSizeBytes,
      clearVisibleRecording,
      client,
      ensureStore,
      focusInput,
      loadNextRecoverable,
      readNow,
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
    const prerequisiteGeneration = generationRef.current;
    let store: VoiceRecordingStore;
    let ownerId: string;
    try {
      [store, ownerId] = await Promise.all([ensureStore(), ensureOwnerId()]);
    } catch (reason) {
      setStatus("error");
      setError(
        reason instanceof VoiceRecordingStorageUnavailableError
          ? "storage_unavailable"
          : errorCode(reason),
      );
      return false;
    }
    if (
      prerequisiteGeneration !== generationRef.current ||
      workspaceIdRef.current !== workspaceId ||
      ownerIdRef.current !== ownerId ||
      manifestRef.current !== null ||
      statusRef.current === "requesting-permission" ||
      statusRef.current === "recording" ||
      statusRef.current === "saving" ||
      statusRef.current === "transcribing"
    ) {
      return false;
    }
    const generation = ++generationRef.current;
    const startAttemptIsCurrent = () =>
      generation === generationRef.current &&
      workspaceIdRef.current === workspaceId &&
      ownerIdRef.current === ownerId;
    setStatus("requesting-permission");
    setError(null);
    let acquiredStream: MediaStream | null = null;
    let createdManifest: VoiceRecordingManifest | null = null;
    let recorderStarted = false;
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      acquiredStream = mediaStream;
      if (!startAttemptIsCurrent()) {
        mediaStream.getTracks().forEach((track) => track.stop());
        return false;
      }
      streamRef.current = mediaStream;
      setStream(mediaStream);
      const mimeType = chooseMimeType(capability.acceptedMimeTypes);
      const recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
      const createdAt = readNow();
      const manifest = createVoiceRecordingManifest({
        recordingId: createRecordingId(),
        workspaceId,
        mimeType: recorder.mimeType || mimeType || "audio/webm",
        createdAt: createdAt.toISOString(),
        ownerId,
      });
      createdManifest = manifest;
      await store.createManifest(manifest);
      if (!startAttemptIsCurrent()) {
        await store.discard(manifest.recordingId, ownerId);
        clearCaptureRuntime();
        return false;
      }
      rememberManifest(manifest);
      beginOwnerHeartbeat(manifest);
      persistenceQueueRef.current = Promise.resolve();
      persistenceErrorRef.current = null;
      captureLimitErrorRef.current = null;
      nextChunkNumberRef.current = 0;
      lastChunkEndMillisecondsRef.current = 0;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0 || persistenceErrorRef.current || captureLimitErrorRef.current) {
          return;
        }
        const chunkNumber = nextChunkNumberRef.current++;
        const elapsed = Math.max(0, readNow().getTime() - recordingStartedAtRef.current);
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
              ownerId,
              chunkNumber,
              capturedAt: readNow().toISOString(),
              startMilliseconds,
              durationMilliseconds,
              mimeType: manifest.mimeType,
              audio: event.data,
            });
            if (!startAttemptIsCurrent()) return;
            rememberManifest(result.manifest);
            if (result.manifest.totalBytes > capability.maxSizeBytes) {
              captureLimitErrorRef.current = "too_large";
              if (recorder.state !== "inactive") recorder.stop();
            }
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
            const stoppedCaptureIsCurrent = () =>
              generation === generationRef.current &&
              workspaceIdRef.current === workspaceId &&
              ownerIdRef.current === ownerId &&
              manifestRef.current?.recordingId === manifest.recordingId &&
              manifestRef.current.workspaceId === workspaceId &&
              manifestRef.current.ownerId === ownerId;
            if (!stoppedCaptureIsCurrent()) return;
            const current = manifestRef.current;
            if (!current) return;
            const stopped = await updateManifestBestEffort(current, { captureState: "stopped" });
            if (
              !stoppedCaptureIsCurrent() ||
              stopped.recordingId !== manifest.recordingId ||
              stopped.workspaceId !== workspaceId ||
              stopped.ownerId !== ownerId
            ) {
              return;
            }
            rememberManifest(stopped);
            if (persistenceErrorRef.current) {
              await preserveForRetry(stopped, "storage_unavailable", generation);
              return;
            }
            if (captureLimitErrorRef.current) {
              await preserveForRetry(stopped, captureLimitErrorRef.current, generation);
              return;
            }
            await finalizePersistedRecording(generation);
          });
      };
      captureSettledRef.current = new Promise<void>((resolve) => {
        resolveCaptureSettledRef.current = resolve;
      });
      recordingStartedAtRef.current = readNow().getTime();
      recorder.start(VOICE_RECORDING_TIMESLICE_MILLISECONDS);
      recorderStarted = true;
      setStatus("recording");
      timerRef.current = setTimeout(
        stop,
        Math.min(capability.maxDurationSeconds, VOICE_RECORDING_CLIENT_MAX_DURATION_SECONDS) *
          1_000,
      );
      return true;
    } catch (reason) {
      const resolveSettled = resolveCaptureSettledRef.current;
      resolveCaptureSettledRef.current = null;
      resolveSettled?.();
      if (acquiredStream && streamRef.current !== acquiredStream) {
        acquiredStream.getTracks().forEach((track) => track.stop());
      }
      clearCaptureRuntime();
      const failedManifest = createdManifest as VoiceRecordingManifest | null;
      if (failedManifest && !recorderStarted) {
        const discarded = await store
          .discard(failedManifest.recordingId, ownerId)
          .then(() => true)
          .catch(() => false);
        if (!discarded) {
          await store
            .updateManifest(
              failedManifest.recordingId,
              { captureState: "stopped", ownerId: null, ownerHeartbeatAt: null },
              readNow().toISOString(),
              ownerId,
            )
            .catch(() => undefined);
        }
        clearVisibleRecording();
      }
      if (generation !== generationRef.current) return false;
      setStatus("error");
      setError(
        reason instanceof VoiceRecordingStorageUnavailableError
          ? "storage_unavailable"
          : errorCode(reason),
      );
      return false;
    }
  }, [
    capability,
    beginOwnerHeartbeat,
    clearCaptureRuntime,
    clearVisibleRecording,
    client,
    createRecordingId,
    disabled,
    enabled,
    ensureOwnerId,
    ensureStore,
    finalizePersistedRecording,
    readNow,
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
      manifestRef.current.finalizationState === "transcript-ready" ||
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

  const insertSavedTranscript = useCallback(async (): Promise<void> => {
    const manifest = manifestRef.current;
    if (
      !manifest ||
      manifest.workspaceId !== workspaceId ||
      manifest.finalizationState !== "transcript-ready" ||
      manifest.transcriptText === null
    ) {
      return;
    }
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    controllerRef.current = null;
    const store = await ensureStore();
    if (generation !== generationRef.current) return;
    const next = appendFinalTranscript(valueRef.current, manifest.transcriptText);
    if (next !== valueRef.current) {
      valueRef.current = next;
      setValue(next);
    }
    let handedOff: VoiceRecordingManifest;
    try {
      handedOff = await store.updateManifest(
        manifest.recordingId,
        { finalizationState: "handed-off" },
        readNow().toISOString(),
        ownerIdRef.current ?? undefined,
      );
    } catch {
      if (generation !== generationRef.current) return;
      rememberManifest(manifest);
      setStatus("transcript-ready");
      setError("handoff_uncertain");
      focusInput();
      return;
    }
    if (generation !== generationRef.current) return;
    await store
      .discard(handedOff.recordingId, ownerIdRef.current ?? undefined)
      .catch(() => undefined);
    if (generation !== generationRef.current) return;
    clearVisibleRecording();
    setStatus("idle");
    setError(null);
    focusInput();
    await loadNextRecoverable(generation);
  }, [
    clearVisibleRecording,
    ensureStore,
    focusInput,
    loadNextRecoverable,
    readNow,
    rememberManifest,
    setValue,
    workspaceId,
  ]);

  const discard = useCallback(async (): Promise<void> => {
    const manifest = manifestRef.current;
    const generation = ++generationRef.current;
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
    if (generation !== generationRef.current) return;
    if (manifest) {
      try {
        await (await ensureStore()).discard(manifest.recordingId, ownerIdRef.current ?? undefined);
      } catch {
        if (generation !== generationRef.current) return;
        rememberManifest(manifest);
        setStatus("error");
        setError("storage_unavailable");
        focusInput();
        return;
      }
    }
    clearVisibleRecording();
    persistenceErrorRef.current = null;
    captureLimitErrorRef.current = null;
    setStatus("idle");
    setError(null);
    focusInput();
    await loadNextRecoverable(generation);
  }, [
    clearCaptureRuntime,
    clearVisibleRecording,
    ensureStore,
    focusInput,
    loadNextRecoverable,
    rememberManifest,
  ]);

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
    const current = manifestRef.current;
    const generation = ++generationRef.current;
    if (current && current.workspaceId !== workspaceId) {
      controllerRef.current?.abort();
      controllerRef.current = null;
      const recorder = recorderRef.current;
      let captureSettled = persistenceQueueRef.current;
      if (recorder && recorder.state !== "inactive") {
        captureSettled = captureSettledRef.current;
        recorder.stop();
      }
      clearCaptureRuntime();
      clearVisibleRecording();
      setStatus("idle");
      setError(null);
      void captureSettled
        .catch(() => undefined)
        .then(async () => {
          const store = await ensureStore();
          const wasProcessing =
            current.uploadState === "syncing" || current.transcriptionState === "transcribing";
          await store.updateManifest(
            current.recordingId,
            {
              ...(current.captureState === "capturing" ? { captureState: "stopped" as const } : {}),
              ...(wasProcessing
                ? { uploadState: "retrying" as const, transcriptionState: "retrying" as const }
                : {}),
              ownerId: null,
              ownerHeartbeatAt: null,
            },
            readNow().toISOString(),
            ownerIdRef.current ?? undefined,
          );
        })
        .catch(() => undefined);
    }
    if (!manifestRef.current) {
      void loadNextRecoverable(generation).catch((reason: unknown) => {
        if (reason instanceof VoiceRecordingStorageUnavailableError) setStorageAvailable(false);
      });
    }
  }, [
    clearCaptureRuntime,
    clearVisibleRecording,
    ensureStore,
    loadNextRecoverable,
    readNow,
    workspaceId,
  ]);

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
      controllerRef.current = null;
      const manifest = manifestRef.current;
      const ownerReady = ownerIdPromiseRef.current;
      stopOwnerHeartbeat();
      const recorder = recorderRef.current;
      let captureSettled = persistenceQueueRef.current;
      if (recorder && recorder.state !== "inactive") {
        captureSettled = captureSettledRef.current;
        recorder.stop();
      }
      clearCaptureRuntime();
      void captureSettled
        .catch(() => undefined)
        .then(async () => {
          const ownerId =
            ownerIdRef.current ?? (ownerReady ? await ownerReady.catch(() => null) : null);
          const store = storeRef.current;
          if (store && manifest && ownerId) {
            const wasProcessing =
              statusRef.current === "saving" || statusRef.current === "transcribing";
            await store
              .updateManifest(
                manifest.recordingId,
                {
                  ...(manifest.captureState === "capturing"
                    ? { captureState: "stopped" as const }
                    : {}),
                  ...(wasProcessing
                    ? {
                        uploadState: "retrying" as const,
                        transcriptionState: "retrying" as const,
                      }
                    : {}),
                  ownerId: null,
                  ownerHeartbeatAt: null,
                },
                readNow().toISOString(),
                ownerId,
              )
              .catch(() => undefined);
          }
          if (ownsStoreRef.current) await store?.close();
        })
        .catch(() => undefined)
        .finally(() => {
          ownerLeaseRef.current?.release();
          ownerLeaseRef.current = null;
        });
    },
    [clearCaptureRuntime, readNow, stopOwnerHeartbeat],
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
    savedTranscript:
      manifestRef.current?.finalizationState === "transcript-ready"
        ? manifestRef.current.transcriptText
        : null,
    start,
    stop,
    retry,
    insertSavedTranscript,
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

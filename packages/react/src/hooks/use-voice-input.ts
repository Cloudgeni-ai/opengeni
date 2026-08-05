import type { ClientVoiceInputConfig, OpenGeniClient } from "@opengeni/sdk";
import { TRANSCRIPTION_RECORDING_RECOVERY_RETRY_AFTER_MILLISECONDS } from "@opengeni/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IndexedDbVoiceRecordingStore,
  VoiceRecordingOwnedError,
  VoiceRecordingStorageUnavailableError,
  createVoiceRecordingManifest,
  type VoiceRecordingChunk,
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
  client: VoiceInputClient | null;
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

type ResumableVoiceInputClient = Pick<
  OpenGeniClient,
  | "createTranscriptionRecording"
  | "getTranscriptionRecording"
  | "uploadTranscriptionRecordingChunk"
  | "finalizeTranscriptionRecording"
  | "processNextTranscriptionRecordingSegment"
  | "discardTranscriptionRecording"
>;

type VoiceInputClient = Pick<OpenGeniClient, "transcribeAudio"> &
  Partial<ResumableVoiceInputClient>;

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
export const VOICE_RECORDING_RESUMABLE_CLIENT_MAX_DURATION_SECONDS = 8 * 60 * 60;
export const VOICE_RECORDING_RECOVERY_STATUS_POLL_MILLISECONDS = 2_000;
export const VOICE_RECORDING_RECOVERY_MAX_MUTATION_DELAY_MILLISECONDS = 30_000;

const MIME_PREFERENCES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
const createDefaultVoiceRecordingId = () => crypto.randomUUID();
const currentDate = () => new Date();

export function transcriptionRecoveryMutationDelayMilliseconds(
  retryAfterMilliseconds: number | undefined,
  attempt: number,
  random: () => number = Math.random,
): number {
  const hint =
    typeof retryAfterMilliseconds === "number" &&
    Number.isInteger(retryAfterMilliseconds) &&
    retryAfterMilliseconds > 0
      ? retryAfterMilliseconds
      : TRANSCRIPTION_RECORDING_RECOVERY_RETRY_AFTER_MILLISECONDS;
  const boundedHint = Math.max(
    500,
    Math.min(hint, VOICE_RECORDING_RECOVERY_MAX_MUTATION_DELAY_MILLISECONDS),
  );
  const exponent = Math.max(0, Math.min(Math.floor(attempt), 6));
  const exponential = Math.min(
    VOICE_RECORDING_RECOVERY_MAX_MUTATION_DELAY_MILLISECONDS,
    boundedHint * 2 ** exponent,
  );
  const sampledJitter = random();
  const jitterRatio = Number.isFinite(sampledJitter)
    ? Math.max(0, Math.min(1, sampledJitter))
    : 0;
  return Math.min(
    VOICE_RECORDING_RECOVERY_MAX_MUTATION_DELAY_MILLISECONDS,
    Math.ceil(exponential * (1 + jitterRatio * 0.2)),
  );
}

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

  const clearCaptureRuntime = useCallback((expectedStream?: MediaStream) => {
    const captureStream = expectedStream ?? streamRef.current;
    captureStream?.getTracks().forEach((track) => track.stop());
    if (expectedStream && streamRef.current !== expectedStream) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
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
      const resumable =
        capability?.resumable && isResumableVoiceInputClient(client) ? capability.resumable : null;
      const maxSizeBytes = resumable?.maxSizeBytes ?? capability?.maxSizeBytes;
      if (
        !manifest ||
        !client ||
        !capability ||
        !maxSizeBytes ||
        manifest.workspaceId !== workspaceId
      )
        return;
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
        const response = await transcribePersistedRecording({
          client,
          workspaceId,
          capability,
          manifest: transcribing,
          chunks,
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
        if (resumable && isResumableVoiceInputClient(client)) {
          await client
            .discardTranscriptionRecording(workspaceId, handedOff.recordingId, {
              signal: controller.signal,
            })
            .catch(() => undefined);
        }
        if (!active()) return;
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
      capability,
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
    let attemptStream: MediaStream | null = null;
    let attemptRecorder: MediaRecorder | null = null;
    let attemptPersistenceQueue = Promise.resolve();
    let attemptPersistenceError: unknown = null;
    let attemptCaptureLimitError: string | null = null;
    const attemptCaptureSettlement: { resolve: (() => void) | null } = { resolve: null };
    const attemptManifest: { current: VoiceRecordingManifest | null } = { current: null };
    let attemptNextChunkNumber = 0;
    let attemptLastChunkEndMilliseconds = 0;
    let attemptRecordingStartedAt = 0;
    const attemptOwnsSharedCapture = () =>
      startAttemptIsCurrent() &&
      attemptStream !== null &&
      streamRef.current === attemptStream &&
      attemptRecorder !== null &&
      recorderRef.current === attemptRecorder &&
      attemptManifest.current !== null &&
      manifestRef.current?.recordingId === attemptManifest.current.recordingId &&
      manifestRef.current.workspaceId === workspaceId &&
      manifestRef.current.ownerId === ownerId;
    setStatus("requesting-permission");
    setError(null);
    let acquiredStream: MediaStream | null = null;
    let recorderStarted = false;
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      acquiredStream = mediaStream;
      attemptStream = mediaStream;
      if (!startAttemptIsCurrent()) {
        mediaStream.getTracks().forEach((track) => track.stop());
        return false;
      }
      streamRef.current = mediaStream;
      setStream(mediaStream);
      const mimeType = chooseMimeType(capability.acceptedMimeTypes);
      const recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
      attemptRecorder = recorder;
      const createdAt = readNow();
      const manifest = createVoiceRecordingManifest({
        recordingId: createRecordingId(),
        workspaceId,
        mimeType: recorder.mimeType || mimeType || "audio/webm",
        createdAt: createdAt.toISOString(),
        ownerId,
      });
      attemptManifest.current = manifest;
      await store.createManifest(manifest);
      if (!startAttemptIsCurrent()) {
        await store.discard(manifest.recordingId, ownerId);
        clearCaptureRuntime(mediaStream);
        return false;
      }
      rememberManifest(manifest);
      beginOwnerHeartbeat(manifest);
      persistenceQueueRef.current = attemptPersistenceQueue;
      persistenceErrorRef.current = null;
      captureLimitErrorRef.current = null;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0 || attemptPersistenceError || attemptCaptureLimitError) {
          return;
        }
        const chunkNumber = attemptNextChunkNumber++;
        const elapsed = Math.max(0, readNow().getTime() - attemptRecordingStartedAt);
        const eventTimecode = Number.isFinite(event.timecode) ? Math.max(0, event.timecode) : 0;
        const endMilliseconds = Math.max(attemptLastChunkEndMilliseconds, eventTimecode, elapsed);
        const startMilliseconds = attemptLastChunkEndMilliseconds;
        const durationMilliseconds = Math.max(0, endMilliseconds - startMilliseconds);
        attemptLastChunkEndMilliseconds = endMilliseconds;
        attemptPersistenceQueue = attemptPersistenceQueue
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
            const maxSizeBytes =
              capability.resumable && isResumableVoiceInputClient(client)
                ? capability.resumable.maxSizeBytes
                : capability.maxSizeBytes;
            if (result.manifest.totalBytes > maxSizeBytes) {
              attemptCaptureLimitError = "too_large";
              if (attemptOwnsSharedCapture()) captureLimitErrorRef.current = "too_large";
              if (recorder.state !== "inactive") recorder.stop();
            }
          })
          .catch((reason: unknown) => {
            attemptPersistenceError = reason;
            if (attemptOwnsSharedCapture()) persistenceErrorRef.current = reason;
            if (recorder.state !== "inactive") recorder.stop();
          });
        if (attemptOwnsSharedCapture()) {
          persistenceQueueRef.current = attemptPersistenceQueue;
        }
      };
      recorder.onstop = () => {
        if (attemptOwnsSharedCapture()) {
          clearCaptureRuntime(mediaStream);
        } else {
          mediaStream.getTracks().forEach((track) => track.stop());
        }
        void attemptPersistenceQueue
          .catch((reason: unknown) => {
            attemptPersistenceError = reason;
          })
          .then(async () => {
            const resolveSettled = attemptCaptureSettlement.resolve;
            attemptCaptureSettlement.resolve = null;
            resolveSettled?.();
            if (resolveCaptureSettledRef.current === resolveSettled) {
              resolveCaptureSettledRef.current = null;
            }
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
            if (attemptPersistenceError) {
              await preserveForRetry(stopped, "storage_unavailable", generation);
              return;
            }
            if (attemptCaptureLimitError) {
              await preserveForRetry(stopped, attemptCaptureLimitError, generation);
              return;
            }
            await finalizePersistedRecording(generation);
          });
      };
      captureSettledRef.current = new Promise<void>((resolve) => {
        attemptCaptureSettlement.resolve = resolve;
        resolveCaptureSettledRef.current = resolve;
      });
      attemptRecordingStartedAt = readNow().getTime();
      recorder.start(VOICE_RECORDING_TIMESLICE_MILLISECONDS);
      recorderStarted = true;
      setStatus("recording");
      timerRef.current = setTimeout(
        stop,
        Math.min(
          capability.resumable && isResumableVoiceInputClient(client)
            ? capability.resumable.maxDurationSeconds
            : capability.maxDurationSeconds,
          capability.resumable && isResumableVoiceInputClient(client)
            ? VOICE_RECORDING_RESUMABLE_CLIENT_MAX_DURATION_SECONDS
            : VOICE_RECORDING_CLIENT_MAX_DURATION_SECONDS,
        ) * 1_000,
      );
      return true;
    } catch (reason) {
      const resolveSettled = attemptCaptureSettlement.resolve;
      attemptCaptureSettlement.resolve = null;
      resolveSettled?.();
      if (resolveCaptureSettledRef.current === resolveSettled) {
        resolveCaptureSettledRef.current = null;
      }
      if (acquiredStream) {
        if (startAttemptIsCurrent() && streamRef.current === acquiredStream) {
          clearCaptureRuntime(acquiredStream);
        } else {
          acquiredStream.getTracks().forEach((track) => track.stop());
        }
      }
      const failedManifest = attemptManifest.current;
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
      }
      if (generation !== generationRef.current) return false;
      const visibleManifest = manifestRef.current as VoiceRecordingManifest | null;
      if (failedManifest && visibleManifest?.recordingId === failedManifest.recordingId) {
        clearVisibleRecording();
      }
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
    if (capability?.resumable && isResumableVoiceInputClient(client)) {
      await client
        .discardTranscriptionRecording(workspaceId, handedOff.recordingId)
        .catch(() => undefined);
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
    capability?.resumable,
    client,
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
      if (capability?.resumable && isResumableVoiceInputClient(client)) {
        await client
          .discardTranscriptionRecording(workspaceId, manifest.recordingId)
          .catch(() => undefined);
      }
      if (generation !== generationRef.current) return;
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
    capability?.resumable,
    client,
    ensureStore,
    focusInput,
    loadNextRecoverable,
    rememberManifest,
    workspaceId,
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

async function transcribePersistedRecording(input: {
  client: VoiceInputClient;
  workspaceId: string;
  capability: ClientVoiceInputConfig;
  manifest: VoiceRecordingManifest;
  chunks: VoiceRecordingChunk[];
  signal: AbortSignal;
}): Promise<{ text: string; languages: string[] }> {
  const client = input.client;
  const resumable = input.capability.resumable;
  const ordered = [...input.chunks].sort((left, right) => left.chunkNumber - right.chunkNumber);
  if (!resumable || !isResumableVoiceInputClient(client)) {
    const audio = new Blob(
      ordered.map((chunk) => chunk.audio),
      { type: input.manifest.mimeType },
    );
    if (audio.size > input.capability.maxSizeBytes) throw { code: "too_large" };
    return await client.transcribeAudio(input.workspaceId, {
      audio,
      mimeType: audio.type,
      durationSeconds: input.manifest.totalDurationMilliseconds / 1_000,
      signal: input.signal,
    });
  }

  if (
    input.manifest.totalBytes > resumable.maxSizeBytes ||
    input.manifest.totalDurationMilliseconds > resumable.maxDurationSeconds * 1_000
  ) {
    throw { code: "too_large" };
  }
  if (
    ordered.some((chunk, index) => chunk.chunkNumber !== index) ||
    ordered.length !== input.manifest.chunkCount
  ) {
    throw { code: "invalid_audio" };
  }

  const finalizeInput = {
    chunkCount: input.manifest.chunkCount,
    totalBytes: input.manifest.totalBytes,
    totalDurationMilliseconds: input.manifest.totalDurationMilliseconds,
    signal: input.signal,
  };

  let remote = await client.createTranscriptionRecording(input.workspaceId, {
    recordingId: input.manifest.recordingId,
    mimeType: input.manifest.mimeType,
    signal: input.signal,
  });
  for (const chunk of ordered) {
    if (chunk.chunkNumber < remote.recording.nextChunkNumber) continue;
    if (chunk.chunkNumber !== remote.recording.nextChunkNumber) {
      throw { code: "invalid_audio" };
    }
    if (chunk.byteLength > resumable.maxChunkSizeBytes) throw { code: "too_large" };
    const uploaded = await client.uploadTranscriptionRecordingChunk(
      input.workspaceId,
      input.manifest.recordingId,
      chunk.chunkNumber,
      {
        audio: chunk.audio,
        mimeType: input.manifest.mimeType,
        sha256: chunk.sha256,
        startMilliseconds: chunk.startMilliseconds,
        durationMilliseconds: chunk.durationMilliseconds,
        signal: input.signal,
      },
    );
    remote = { recording: uploaded.recording, segments: remote.segments };
  }
  if (remote.recording.nextChunkNumber !== ordered.length) {
    throw { code: "invalid_audio" };
  }

  remote = await client.finalizeTranscriptionRecording(
    input.workspaceId,
    input.manifest.recordingId,
    finalizeInput,
  );

  let recoveryMutationAttempt = 0;
  let recoveryMutationDueAt = 0;
  const scheduleRecoveryMutation = (response: typeof remote): void => {
    if (
      response.recording.state !== "segmenting" &&
      response.recording.state !== "transcribing"
    ) {
      return;
    }
    recoveryMutationDueAt =
      Date.now() +
      transcriptionRecoveryMutationDelayMilliseconds(
        response.retryAfterMilliseconds,
        recoveryMutationAttempt,
      );
    recoveryMutationAttempt += 1;
  };
  scheduleRecoveryMutation(remote);

  for (;;) {
    if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
    switch (remote.recording.state) {
      case "complete":
        if (remote.recording.transcriptText === null) throw { code: "invalid_audio" };
        return {
          text: remote.recording.transcriptText,
          languages: remote.recording.languages,
        };
      case "ready":
        remote = await client.processNextTranscriptionRecordingSegment(
          input.workspaceId,
          input.manifest.recordingId,
          { signal: input.signal },
        );
        scheduleRecoveryMutation(remote);
        break;
      case "failed": {
        if (!remote.recording.retryable) {
          throw { code: remote.recording.errorCode ?? "unknown" };
        }
        const retried =
          remote.recording.segmentCount === 0
            ? await client.finalizeTranscriptionRecording(
                input.workspaceId,
                input.manifest.recordingId,
                finalizeInput,
              )
            : await client.processNextTranscriptionRecordingSegment(
                input.workspaceId,
                input.manifest.recordingId,
                { signal: input.signal },
              );
        if (retried.recording.state === "failed") {
          throw { code: retried.recording.errorCode ?? "unknown" };
        }
        remote = retried;
        scheduleRecoveryMutation(remote);
        break;
      }
      case "discarded":
        throw { code: "invalid_audio" };
      case "uploading":
        remote = await client.finalizeTranscriptionRecording(
          input.workspaceId,
          input.manifest.recordingId,
          finalizeInput,
        );
        scheduleRecoveryMutation(remote);
        break;
      case "segmenting":
      case "transcribing":
        if (Date.now() < recoveryMutationDueAt) {
          await abortableDelay(
            Math.min(
              recoveryMutationDueAt - Date.now(),
              VOICE_RECORDING_RECOVERY_STATUS_POLL_MILLISECONDS,
            ),
            input.signal,
          );
          remote = await client.getTranscriptionRecording(
            input.workspaceId,
            input.manifest.recordingId,
            { signal: input.signal },
          );
          break;
        }
        if (remote.recording.state === "segmenting") {
          // Re-enter the server-authoritative assembly claim only when its
          // durable recovery schedule is due.
          remote = await client.finalizeTranscriptionRecording(
            input.workspaceId,
            input.manifest.recordingId,
            finalizeInput,
          );
        } else {
          // Re-enter the server-authoritative segment claim only when its
          // durable recovery schedule is due.
          remote = await client.processNextTranscriptionRecordingSegment(
            input.workspaceId,
            input.manifest.recordingId,
            { signal: input.signal },
          );
        }
        scheduleRecoveryMutation(remote);
        break;
    }
  }
}

function isResumableVoiceInputClient(
  client: VoiceInputClient | null,
): client is VoiceInputClient & ResumableVoiceInputClient {
  return Boolean(
    client &&
    client.createTranscriptionRecording &&
    client.getTranscriptionRecording &&
    client.uploadTranscriptionRecordingChunk &&
    client.finalizeTranscriptionRecording &&
    client.processNextTranscriptionRecordingSegment &&
    client.discardTranscriptionRecording,
  );
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

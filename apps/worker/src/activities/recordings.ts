import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  buildRecordingSegments,
  createRecordingTranscriptionProviderRegistry,
  estimateRecordingTranscriptionCostMicros,
  findRecordingTranscriptionModel,
  planRecordingTracks,
  recordingDiarizationKind,
  RecordingTranscriptionError,
  type RecordingTranscribedWord,
  type RecordingTranscriptionProviderRegistry,
  type RecordingTrackWords,
} from "@opengeni/core";
import {
  claimRecordingTranscriptVersion,
  completeRecordingTranscriptVersion,
  failRecordingTranscriptVersion,
  getRecordingTrackPreparedObject,
  listDeletingRecordingObjectKeys,
  listStalledRecordingWork,
  loadOrganizationModelProviderApiKey,
  loadWorkspaceProviderApiKey,
  purgeDeletingRecording,
  recordingPreparedTrackObjectKey,
  RecordingNotFoundError,
  setRecordingTrackPrepared,
  type Database,
  type StalledRecordingWork,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import type { ObjectStorage } from "@opengeni/storage";
import { createHash } from "node:crypto";
import {
  prepareRecordingTrackAudio,
  preparedAudioFormat,
  recordingAudioContainer,
  RecordingAudioError,
} from "./recording-audio";
import type { ControlActivityServices } from "./types";

/** One recording's work: a transcript version, or the recording's deletion. */
export type RecordingWorkInput = {
  accountId: string;
  workspaceId: string;
  recordingId: string;
  /** Every step runs as the person who recorded, under their row-level security. */
  ownerSubjectId: string;
};

export type RecordingTranscriptInput = RecordingWorkInput & {
  versionId: string;
  /** The workflow's own lease name, so a retry takes its lease back. */
  processingOwner: string;
};

export type RecordingTranscriptOutcome =
  | { outcome: "complete" }
  | { outcome: "failed"; errorCode: string }
  | { outcome: "skipped" };

/** A version lease outlives the longest provider call; retries reclaim it by owner. */
const TRANSCRIPT_LEASE_SECONDS = 3 * 60 * 60;

export type RecordingActivityOptions = {
  registry?: RecordingTranscriptionProviderRegistry;
  loadApiKey?: (
    db: Database,
    settings: Settings,
    scope: { accountId: string; workspaceId: string; providerId: string },
  ) => Promise<string | null>;
  heartbeat?: (details?: unknown) => void;
  cancellationSignal?: () => AbortSignal | undefined;
};

/** The workspace's own key for the provider, else its organization's. */
async function loadRecordingProviderApiKey(
  db: Database,
  settings: Settings,
  scope: { accountId: string; workspaceId: string; providerId: string },
): Promise<string | null> {
  if (scope.providerId !== "elevenlabs") return null;
  return (
    (await loadWorkspaceProviderApiKey(db, settings, scope.workspaceId, "elevenlabs")) ??
    (await loadOrganizationModelProviderApiKey(db, settings, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      providerKind: "elevenlabs",
    }))
  );
}

function activityContext(): Context | null {
  try {
    return Context.current();
  } catch {
    return null;
  }
}

/** A failure the workflow should not retry; the version is failed with this code. */
class PermanentRecordingFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function shiftWords(
  words: readonly RecordingTranscribedWord[],
  offsetMilliseconds: number,
): RecordingTranscribedWord[] {
  if (offsetMilliseconds === 0) return [...words];
  return words.map((word) => ({
    ...word,
    startMilliseconds: word.startMilliseconds + offsetMilliseconds,
    endMilliseconds: word.endMilliseconds + offsetMilliseconds,
  }));
}

export function createRecordingActivities(
  services: () => Promise<ControlActivityServices>,
  options: RecordingActivityOptions = {},
) {
  const registry = options.registry ?? createRecordingTranscriptionProviderRegistry();
  const loadApiKey = options.loadApiKey ?? loadRecordingProviderApiKey;
  const heartbeat = (details?: unknown) => {
    if (options.heartbeat) options.heartbeat(details);
    else activityContext()?.heartbeat(details);
  };
  const cancellation = () =>
    options.cancellationSignal
      ? options.cancellationSignal()
      : activityContext()?.cancellationSignal;

  /**
   * Make one transcript version: prepare each track's audio once (later
   * versions reuse it), transcribe each track, then build and store the
   * segments. Permanent failures fail the version here; retryable ones throw
   * so Temporal retries, and the workflow fails the version if retries run out.
   */
  async function transcribeRecordingVersion(
    input: RecordingTranscriptInput,
  ): Promise<RecordingTranscriptOutcome> {
    const { db, objectStorage, settings, observability } = await services();
    const actor = { workspaceId: input.workspaceId, subjectId: input.ownerSubjectId };
    const job = await claimRecordingTranscriptVersion(db, {
      ...actor,
      versionId: input.versionId,
      processingOwner: input.processingOwner,
      leaseSeconds: TRANSCRIPT_LEASE_SECONDS,
    });
    if (!job) return { outcome: "skipped" };
    const fail = async (errorCode: string): Promise<RecordingTranscriptOutcome> => {
      await failRecordingTranscriptVersion(db, {
        ...actor,
        versionId: input.versionId,
        processingOwner: input.processingOwner,
        errorCode,
      });
      observability.warn("recording transcript failed", {
        workspaceId: input.workspaceId,
        recordingId: input.recordingId,
        versionId: input.versionId,
        errorCode,
      });
      return { outcome: "failed", errorCode };
    };
    try {
      if (!objectStorage) throw new PermanentRecordingFailure("storage_unavailable");
      const found = findRecordingTranscriptionModel(
        registry,
        job.version.providerId,
        job.version.model,
      );
      if (!found) throw new PermanentRecordingFailure("model_unavailable");
      const apiKey = await loadApiKey(db, settings, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        providerId: job.version.providerId,
      });
      if (!apiKey) throw new PermanentRecordingFailure("missing_provider_key");
      const plans = planRecordingTracks(job.recording.tracks);
      const capabilities = found.spec.capabilities;
      const requested = job.version.options;
      const signal = cancellation();
      const trackWords: RecordingTrackWords[] = [];
      let providerDiarized = false;
      let audioMilliseconds = 0;
      const languages = new Set<string>();
      for (const plan of plans) {
        const track = job.recording.tracks.find((item) => item.trackNumber === plan.trackNumber)!;
        const chunks = job.chunks.filter((chunk) => chunk.trackNumber === plan.trackNumber);
        if (chunks.length === 0) continue;
        const offsetMilliseconds = Math.min(...chunks.map((chunk) => chunk.startMilliseconds));
        const audio = await preparedTrackAudio({
          db,
          objectStorage,
          settings,
          actor,
          recordingId: input.recordingId,
          trackNumber: plan.trackNumber,
          mimeType: track.mimeType,
          chunks,
          offsetMilliseconds,
          knownDurationMilliseconds: Math.max(0, track.durationMilliseconds - offsetMilliseconds),
          signal,
        });
        heartbeat({ phase: "transcribing", trackNumber: plan.trackNumber });
        const diarize = plan.diarize && capabilities.diarization;
        const result = await withHeartbeat(() =>
          found.provider.transcribe(
            {
              audio: {
                bytes: audio.bytes,
                mimeType: audio.mimeType,
                fileName: `track-${plan.trackNumber}.${audio.extension}`,
              },
              model: found.spec.model,
              language: requested.language,
              diarize,
              maxSpeakers: requested.maxSpeakers,
              keyterms: capabilities.keyterms ? requested.keyterms : undefined,
              signal,
            },
            { apiKey },
          ),
        );
        if (diarize && result.diarized) providerDiarized = true;
        for (const language of result.languages) languages.add(language);
        audioMilliseconds += result.audioMilliseconds ?? audio.durationMilliseconds;
        trackWords.push({
          trackNumber: plan.trackNumber,
          fixedLabel: plan.fixedLabel,
          words: shiftWords(result.words, offsetMilliseconds),
        });
      }
      const segments = buildRecordingSegments(trackWords);
      const diarization = recordingDiarizationKind({ plans, providerDiarized, ourDiarizer: false });
      const costUsdMicros = estimateRecordingTranscriptionCostMicros(
        found.spec,
        audioMilliseconds,
        {
          keyterms: capabilities.keyterms && (requested.keyterms?.length ?? 0) > 0,
        },
      );
      const completed = await completeRecordingTranscriptVersion(db, {
        ...actor,
        versionId: input.versionId,
        processingOwner: input.processingOwner,
        languages: [...languages],
        diarized: diarization === "provider" || diarization === "ours",
        diarization,
        costUsdMicros,
        audioMilliseconds,
        segments: segments.map((segment) => ({
          startMilliseconds: segment.startMilliseconds,
          endMilliseconds: segment.endMilliseconds,
          trackNumber: segment.trackNumber,
          speakerLabel: segment.speakerLabel,
          text: segment.text,
          words: segment.words,
        })),
      });
      return completed ? { outcome: "complete" } : { outcome: "skipped" };
    } catch (error) {
      if (error instanceof RecordingNotFoundError) return { outcome: "skipped" };
      if (error instanceof PermanentRecordingFailure) return await fail(error.code);
      if (error instanceof RecordingAudioError) {
        if (error.code === "missing_chunk") {
          throw ApplicationFailure.retryable(error.message, "missing_chunk");
        }
        return await fail(error.code);
      }
      if (error instanceof RecordingTranscriptionError) {
        if (!error.retryable) return await fail(`provider_${error.code}`);
        throw ApplicationFailure.retryable(error.message, `provider_${error.code}`);
      }
      throw error;
    }

    async function withHeartbeat<T>(work: () => Promise<T>): Promise<T> {
      const timer = setInterval(() => heartbeat({ phase: "transcribing" }), 30_000);
      try {
        return await work();
      } finally {
        clearInterval(timer);
      }
    }
  }

  /**
   * The track's prepared file: reused when an earlier version made it,
   * otherwise built from the chunks and stored for playback and re-runs.
   */
  async function preparedTrackAudio(input: {
    db: Database;
    objectStorage: ObjectStorage;
    settings: Settings;
    actor: { workspaceId: string; subjectId: string };
    recordingId: string;
    trackNumber: number;
    mimeType: string;
    chunks: ReadonlyArray<{
      chunkNumber: number;
      startMilliseconds: number;
      durationMilliseconds: number;
      objectKey: string;
    }>;
    offsetMilliseconds: number;
    knownDurationMilliseconds: number;
    signal: AbortSignal | undefined;
  }): Promise<{
    bytes: Uint8Array;
    mimeType: string;
    extension: string;
    durationMilliseconds: number;
  }> {
    const container = recordingAudioContainer(input.mimeType);
    if (!container) throw new PermanentRecordingFailure("invalid_audio");
    const format = preparedAudioFormat(container);
    const existing = await getRecordingTrackPreparedObject(input.db, {
      ...input.actor,
      recordingId: input.recordingId,
      trackNumber: input.trackNumber,
    });
    if (existing) {
      const stored = await input.objectStorage.getObjectBytes(existing.objectKey);
      if (stored && stored.bytes.byteLength === existing.bytes) {
        return {
          bytes: stored.bytes,
          mimeType: format.mimeType,
          extension: format.extension,
          durationMilliseconds: input.knownDurationMilliseconds,
        };
      }
    }
    heartbeat({ phase: "preparing", trackNumber: input.trackNumber });
    const prepared = await prepareRecordingTrackAudio({
      chunks: input.chunks,
      mimeType: input.mimeType,
      ffmpegPath: input.settings.voiceInputFfmpegPath,
      signal: input.signal,
      onProgress: () => heartbeat({ phase: "preparing", trackNumber: input.trackNumber }),
      readChunk: async (chunk) =>
        (await input.objectStorage.getObjectBytes(chunk.objectKey))?.bytes ?? null,
    });
    const objectKey = recordingPreparedTrackObjectKey({
      workspaceId: input.actor.workspaceId,
      recordingId: input.recordingId,
      trackNumber: input.trackNumber,
      extension: prepared.extension,
    });
    await input.objectStorage.putObject({
      key: objectKey,
      contentType: prepared.mimeType,
      body: prepared.bytes,
      sha256: createHash("sha256").update(prepared.bytes).digest("hex"),
    });
    try {
      await setRecordingTrackPrepared(input.db, {
        ...input.actor,
        recordingId: input.recordingId,
        trackNumber: input.trackNumber,
        objectKey,
        bytes: prepared.bytes.byteLength,
        durationMilliseconds: input.offsetMilliseconds + prepared.durationMilliseconds,
      });
    } catch (error) {
      // Deleted meanwhile: its deletion listed keys before this one existed.
      if (error instanceof RecordingNotFoundError)
        await input.objectStorage.deleteObject(objectKey);
      throw error;
    }
    return prepared;
  }

  /** Retries ran out on a retryable failure: fail the version with its last cause. */
  async function failRecordingTranscript(
    input: RecordingTranscriptInput & { errorCode: string },
  ): Promise<void> {
    const { db } = await services();
    await failRecordingTranscriptVersion(db, {
      workspaceId: input.workspaceId,
      subjectId: input.ownerSubjectId,
      versionId: input.versionId,
      processingOwner: input.processingOwner,
      errorCode: input.errorCode,
    }).catch((error: unknown) => {
      if (!(error instanceof RecordingNotFoundError)) throw error;
    });
  }

  /**
   * Remove a deleted recording's audio, then its rows. Deleting a missing
   * object succeeds, so repeating this is harmless.
   */
  async function deleteRecordingMedia(
    input: RecordingWorkInput,
  ): Promise<{ deleted: number; purged: boolean }> {
    const { db, objectStorage } = await services();
    const actor = {
      workspaceId: input.workspaceId,
      subjectId: input.ownerSubjectId,
      recordingId: input.recordingId,
    };
    const keys = await listDeletingRecordingObjectKeys(db, actor);
    if (keys === null) return { deleted: 0, purged: false };
    if (!objectStorage)
      throw ApplicationFailure.retryable("Object storage is unavailable", "storage_unavailable");
    const prefix = `workspaces/${input.workspaceId}/recordings/${input.recordingId}/`;
    let deleted = 0;
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      await objectStorage.deleteObject(key);
      deleted += 1;
      if (deleted % 50 === 0) heartbeat({ deleted });
    }
    return { deleted, purged: await purgeDeletingRecording(db, actor) };
  }

  /** Start workflows for transcripts and deletions that never got one. */
  async function recoverRecordingWorkflows(): Promise<{
    found: number;
    started: number;
    failed: number;
  }> {
    const { db, startRecordingWorkflow, observability } = await services();
    if (!startRecordingWorkflow) return { found: 0, started: 0, failed: 0 };
    const work = await listStalledRecordingWork(db, 50);
    let started = 0;
    let failed = 0;
    for (const item of work) {
      try {
        if ((await startRecordingWorkflow(item)) === "started") started += 1;
      } catch (error) {
        failed += 1;
        observability.warn("recording workflow recovery start failed", {
          workspaceId: item.workspaceId,
          recordingId: item.recordingId,
          kind: item.kind,
          errorClass: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    return { found: work.length, started, failed };
  }

  return {
    transcribeRecordingVersion,
    failRecordingTranscript,
    deleteRecordingMedia,
    recoverRecordingWorkflows,
  };
}

export type StartRecordingWorkflowInput = StalledRecordingWork;

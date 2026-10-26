import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  alignedTranscribedWords,
  buildRecordingSegments,
  createVoiceInputBilling,
  estimateRecordingTranscriptionCostMicros,
  findRecordingTranscriptionModel,
  labelWordsFromTurns,
  mergeRecordingTranscriptionPieces,
  planRecordingTracks,
  planRecordingTranscriptionPieces,
  recordingDiarizationKind,
  recordingSpeakerLabels,
  recordingTextWords,
  RecordingTranscriptionError,
  TranscriptionBillingRefusedError,
  TranscriptionServiceError,
  withoutMicrophoneEchoes,
  type RecordingDiarizerResult,
  type RecordingDiarizer,
  type RecordingAlignedWords,
  type RecordingTranscribedWord,
  type RecordingTranscriptionAudio,
  type RecordingTranscriptionCredentials,
  type RecordingTranscriptionModelSpec,
  type RecordingTranscriptionProvider,
  type RecordingTranscriptionProviderRegistry,
  type RecordingTranscriptionRequest,
  type RecordingTranscriptionResult,
  type RecordingTrackWords,
  type RecordingWordAligner,
  type TranscriptionBilling,
  type TranscriptionSegmenter,
  type TranscriptionService,
} from "@opengeni/core";
import {
  asRecordingTranscriptionError,
  createFfmpegTranscriptionSegmenter,
  createSpeechToTextDeployment,
  createTranscriptionService,
  dictationProviders,
  type SpeechToTextDeployment,
  TranscriptionSegmenterError,
  wavDurationSeconds,
} from "@opengeni/core/transcription-service";
import {
  beginRecordingAudioExpiry,
  claimRecordingTranscriptVersion,
  completeRecordingAudioExpiry,
  completeRecordingTranscriptVersion,
  failRecordingTranscriptVersion,
  getRecordingTrackPreparedObject,
  getRecording,
  getWorkspace,
  listDeletingRecordingObjectKeys,
  listDueRecordingRetention,
  listStalledRecordingWork,
  loadOrganizationModelProviderApiKey,
  loadWorkspaceProviderApiKey,
  markRecordingDeleting,
  purgeDeletingRecording,
  recordingPreparedTrackObjectKey,
  RecordingNotFoundError,
  recordingVoiceChannel,
  setRecordingTrackPrepared,
  type Database,
  type RecordingSpeakerVoice,
  type StalledRecordingWork,
  type TrackSpeaker,
  workspaceMemberDisplayName,
} from "@opengeni/db";
import {
  resolveWorkspaceRecordingSettings,
  resolveWorkspaceVoiceInputEnabled,
  DICTATION_RETENTION_MILLISECONDS,
  TRANSCRIPTION_RECORDING_PROVIDER_SEGMENT_SECONDS,
  WorkspaceVoiceInputSettings,
} from "@opengeni/contracts";
import {
  voiceInputCreditBillingActive,
  type Settings,
  type VoiceInputPricing,
} from "@opengeni/config";
import type { ObjectStorage } from "@opengeni/storage";
import { createHash } from "node:crypto";
import {
  measureRecordingStage,
  RecordingUsage,
  reportRecordingProcessing,
  runMeasuredCommand,
  withRecordingUsage,
  type RecordingProcessingReport,
} from "./recording-usage";
import {
  prepareRecordingTrackAudio,
  preparedAudioFormat,
  recordingAudioContainer,
  RecordingAudioError,
  RECORDING_PIECE_BYTES_PER_SECOND,
  renderRecordingAudioPiece,
  type RecordingPieceFormat,
} from "./recording-audio";
import type { ControlActivityServices } from "./types";
import {
  createLocalAligner,
  createLocalDiarizer,
  recordingAlignerConfig,
  recordingSpeakersConfig,
} from "./recording-speakers";

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

export type RecordingTranscriptOutcome = (
  | { outcome: "complete" }
  | { outcome: "failed"; errorCode: string }
  | { outcome: "skipped" }
) & {
  /**
   * A dictation is deleted this long after its transcript settles, when its
   * owner hasn't already taken the text and deleted it.
   */
  expireAfterMilliseconds?: number;
};

/** A version lease outlives the longest provider call; retries reclaim it by owner. */
const TRANSCRIPT_LEASE_SECONDS = 3 * 60 * 60;

export type RecordingActivityOptions = {
  /** Providers to offer instead of the deployment's own, such as fakes in tests. */
  registry?: RecordingTranscriptionProviderRegistry;
  loadApiKey?: (
    db: Database,
    settings: Settings,
    scope: { accountId: string; workspaceId: string; providerId: string },
  ) => Promise<string | null>;
  heartbeat?: (details?: unknown) => void;
  cancellationSignal?: () => AbortSignal | undefined;
  /** Our own diarizer; defaults to the configured CPU speaker models, if any. */
  diarizer?: (settings: Settings) => RecordingDiarizer | null;
  /**
   * Places a text-only model's words on the audio; defaults to the
   * configured CPU aligner when the deployment aligns words.
   */
  aligner?: (settings: Settings) => RecordingWordAligner | null;
  /**
   * The voice input service that transcribes dictations; defaults to the
   * deployment's configured voice input providers, with credit billing.
   */
  dictationTranscription?: (settings: Settings, db: Database) => TranscriptionService;
  /** Cuts a dictation into provider-sized WAV pieces; defaults to ffmpeg. */
  dictationSegmenter?: (settings: Settings) => TranscriptionSegmenter;
  /** Credit charges for meetings on deployment-funded models; defaults to voice input billing. */
  billing?: (settings: Settings, db: Database) => TranscriptionBilling;
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

/** The prepared formats as a model names them. */
function preparedPieceFormat(extension: string): RecordingPieceFormat {
  return extension === "m4a" ? "mp4" : "webm";
}

/** Formats the worker can write, in the order it prefers them for a model. */
const WRITABLE_PIECE_FORMATS: readonly RecordingPieceFormat[] = ["flac", "wav", "webm", "mp4"];

/**
 * Transcribe one track with a model, converting it when the model needs
 * another format and sending it in overlapping pieces when it is longer
 * than the model takes in one request.
 */
export async function transcribeTrack(input: {
  provider: RecordingTranscriptionProvider;
  spec: RecordingTranscriptionModelSpec;
  audio: RecordingTranscriptionAudio & { extension: string };
  durationMilliseconds: number;
  ffmpegPath: string;
  credentials: RecordingTranscriptionCredentials | null;
  request: Omit<RecordingTranscriptionRequest, "audio">;
  onPiece?: (index: number) => void;
  tempRoot?: string;
  /** Places the words of a model that returns only text. */
  aligner?: RecordingWordAligner | null;
  /** Adds each aligned piece's placement counts and scores. */
  onAligned?: (aligned: RecordingAlignedWords) => void;
}): Promise<RecordingTranscriptionResult> {
  const { source, format, maxPieceMilliseconds } = pieceShape(input.spec, input.audio.extension);
  const pieces = planRecordingTranscriptionPieces(input.durationMilliseconds, maxPieceMilliseconds);
  const parts: Array<{
    piece: (typeof pieces)[number];
    result: RecordingTranscriptionResult;
  }> = [];
  for (const [index, piece] of pieces.entries()) {
    input.onPiece?.(index);
    const whole = pieces.length === 1;
    const audio =
      whole && !format
        ? input.audio
        : await measureRecordingStage("convert", () =>
            renderRecordingAudioPiece({
              audio: input.audio,
              startMilliseconds: piece.startMilliseconds,
              endMilliseconds: piece.endMilliseconds,
              whole,
              format: format ?? source,
              ffmpegPath: input.ffmpegPath,
              tempRoot: input.tempRoot,
              signal: input.request.signal,
            }),
          ).then((rendered) => ({
            bytes: rendered.bytes,
            mimeType: rendered.mimeType,
            fileName: `${input.audio.fileName.replace(/\.[^.]+$/u, "")}-${index}.${rendered.extension}`,
          }));
    const result = await measureRecordingStage("transcribe", () =>
      input.provider.transcribe(
        {
          ...input.request,
          audio: { bytes: audio.bytes, mimeType: audio.mimeType, fileName: audio.fileName },
        },
        input.credentials,
      ),
    ).catch((error: unknown) => {
      throw asRecordingTranscriptionError(error);
    });
    parts.push({ piece, result: await alignPiece(input, audio, result) });
  }
  return mergeRecordingTranscriptionPieces(parts);
}

/**
 * Give a text-only model's piece word timings by aligning its text on the
 * same audio it heard. Results that already time their words pass through.
 */
async function alignPiece(
  input: {
    aligner?: RecordingWordAligner | null;
    onAligned?: (aligned: RecordingAlignedWords) => void;
    request: { signal?: AbortSignal | undefined };
  },
  audio: RecordingTranscriptionAudio,
  result: RecordingTranscriptionResult,
): Promise<RecordingTranscriptionResult> {
  if (result.words.length > 0 || !input.aligner) return result;
  const text = recordingTextWords(result.text);
  if (text.length === 0) return result;
  const aligner = input.aligner;
  const aligned = await measureRecordingStage("align", () =>
    aligner.align(audio, text, { signal: input.request.signal }),
  );
  input.onAligned?.(aligned);
  return { ...result, words: alignedTranscribedWords(text, aligned) };
}

/**
 * The format a model is sent a track in (null keeps the prepared one) and
 * the longest piece it takes in one request.
 */
function pieceShape(
  spec: RecordingTranscriptionModelSpec,
  extension: string,
): {
  source: RecordingPieceFormat;
  format: RecordingPieceFormat | null;
  maxPieceMilliseconds: number | null;
} {
  const source = preparedPieceFormat(extension);
  const accepted = spec.audioFormats;
  let format: RecordingPieceFormat | null = null;
  if (accepted && !accepted.includes(source)) {
    format = WRITABLE_PIECE_FORMATS.find((candidate) => accepted.includes(candidate)) ?? null;
    if (!format) throw new PermanentRecordingFailure("model_unavailable");
  }
  const { maxDurationSeconds, maxFileBytes } = spec.capabilities;
  const bytesPerSecond = format ? RECORDING_PIECE_BYTES_PER_SECOND[format] : undefined;
  const limits = [
    maxDurationSeconds === null ? null : maxDurationSeconds * 1_000,
    // Converted audio has a known rate; keep a tenth spare under the file limit.
    maxFileBytes !== null && bytesPerSecond
      ? Math.floor(((maxFileBytes * 0.9) / bytesPerSecond) * 1_000)
      : null,
  ].filter((limit): limit is number => limit !== null);
  return {
    source,
    format,
    maxPieceMilliseconds: limits.length > 0 ? Math.min(...limits) : null,
  };
}

/**
 * How a meeting's transcript is paid for. A deployment-funded model with a
 * credit price is charged in Opengeni credits where credit billing is on;
 * everything else (the workspace's own key or subscription, or a
 * deployment that does not charge credits) counts toward the workspace's
 * allowance at its list price.
 */
/** Count one aligned piece into the version's alignment telemetry. */
function addAlignment(
  telemetry: { alignment: RecordingProcessingReport["alignment"] },
  aligned: RecordingAlignedWords,
): void {
  const total = (telemetry.alignment ??= {
    words: 0,
    anchoredWords: 0,
    spreadWords: 0,
    untimedWords: 0,
    scoredWords: 0,
    scoreSum: 0,
  });
  total.words += aligned.words.length;
  total.anchoredWords += aligned.anchoredWords;
  total.spreadWords += aligned.spreadWords;
  total.untimedWords += aligned.untimedWords;
  for (const word of aligned.words) {
    if (word.score === null) continue;
    total.scoredWords += 1;
    total.scoreSum += word.score;
  }
}

function meetingCharge(
  settings: Settings,
  provider: RecordingTranscriptionProvider,
  spec: RecordingTranscriptionModelSpec,
): { pricing: VoiceInputPricing } | null {
  if (provider.funding !== "deployment" || !voiceInputCreditBillingActive(settings)) return null;
  return spec.creditPricing ? { pricing: spec.creditPricing } : null;
}

export function createRecordingActivities(
  services: () => Promise<ControlActivityServices>,
  options: RecordingActivityOptions = {},
) {
  const loadApiKey = options.loadApiKey ?? loadRecordingProviderApiKey;
  let deploymentMemo: { settings: Settings; deployment: SpeechToTextDeployment } | null = null;
  /** The deployment's speech-to-text providers, the same ones the API offers. */
  const deploymentFor = (settings: Settings, db: Database): SpeechToTextDeployment => {
    if (deploymentMemo?.settings !== settings) {
      deploymentMemo = {
        settings,
        deployment: createSpeechToTextDeployment(
          { settings, db },
          {
            ...(options.registry ? { providers: [...options.registry.values()] } : {}),
            loadWorkspaceKey: (providerId, scope) =>
              loadApiKey(db, settings, { ...scope, providerId }),
          },
        ),
      };
    }
    return deploymentMemo.deployment;
  };
  let defaultBilling: { settings: Settings; billing: TranscriptionBilling } | null = null;
  const billingFor = (settings: Settings, db: Database): TranscriptionBilling => {
    if (options.billing) return options.billing(settings, db);
    if (defaultBilling?.settings !== settings) {
      defaultBilling = { settings, billing: createVoiceInputBilling({ db, settings }) };
    }
    return defaultBilling.billing;
  };
  let defaultDiarizer: { settings: Settings; diarizer: RecordingDiarizer | null } | null = null;
  const diarizerFor = (settings: Settings): RecordingDiarizer | null => {
    if (options.diarizer) return options.diarizer(settings);
    if (defaultDiarizer?.settings !== settings) {
      const config = recordingSpeakersConfig(settings);
      defaultDiarizer = { settings, diarizer: config ? createLocalDiarizer(config) : null };
    }
    return defaultDiarizer.diarizer;
  };
  let defaultAligner: { settings: Settings; aligner: RecordingWordAligner | null } | null = null;
  const alignerFor = (settings: Settings): RecordingWordAligner | null => {
    if (options.aligner) return options.aligner(settings);
    if (defaultAligner?.settings !== settings) {
      const config = recordingAlignerConfig(settings);
      defaultAligner = { settings, aligner: config ? createLocalAligner(config) : null };
    }
    return defaultAligner.aligner;
  };
  let defaultDictation: {
    settings: Settings;
    service: TranscriptionService;
    segmenter: TranscriptionSegmenter;
  } | null = null;
  const dictationFor = (settings: Settings, db: Database) => {
    if (defaultDictation?.settings !== settings) {
      defaultDictation = {
        settings,
        service: options.dictationTranscription
          ? options.dictationTranscription(settings, db)
          : createTranscriptionService({ settings, db, deployment: deploymentFor(settings, db) }),
        segmenter: options.dictationSegmenter
          ? options.dictationSegmenter(settings)
          : createFfmpegTranscriptionSegmenter({
              ffmpegPath: settings.voiceInputFfmpegPath,
              runCommand: runMeasuredCommand,
            }),
      };
    }
    return defaultDictation;
  };
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
    const leased = await claimRecordingTranscriptVersion(db, {
      ...actor,
      versionId: input.versionId,
      processingOwner: input.processingOwner,
      leaseSeconds: TRANSCRIPT_LEASE_SECONDS,
    });
    if (!leased) return { outcome: "skipped" };
    const job = leased;
    // A dictation is kept only long enough for its owner to take the text.
    const expiry =
      job.recording.purpose === "dictation"
        ? { expireAfterMilliseconds: DICTATION_RETENTION_MILLISECONDS }
        : {};
    const fail = async (
      errorCode: string,
      cause?: unknown,
    ): Promise<RecordingTranscriptOutcome> => {
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
        // The stored code is all the user sees; the cause is what an operator needs.
        providerId: job.version.providerId,
        model: job.version.model,
        ...(cause instanceof Error ? { error: cause.message.slice(0, 1_000) } : {}),
      });
      return { outcome: "failed", errorCode, ...expiry };
    };
    const usage = new RecordingUsage();
    const startedAt = performance.now();
    const telemetry: Omit<
      RecordingProcessingReport,
      "outcome" | "errorCode" | "wallSeconds" | "stages"
    > = {
      purpose: job.recording.purpose === "dictation" ? "dictation" : "meeting",
      provider: job.version.providerId,
      model: job.version.model,
      funding: "none",
      audioSeconds: 0,
      queueSeconds: job.queuedMilliseconds === null ? null : job.queuedMilliseconds / 1_000,
      preparedBytes: 0,
      providerCostUsd: null,
      credits: null,
      diarization: null,
      speakers: null,
      ourDiarizerFailed: false,
      alignment: null,
    };
    let finished: RecordingTranscriptOutcome | null = null;
    let retryCode = "unknown";
    try {
      finished = await withRecordingUsage(usage, transcribeClaimed);
      return finished;
    } catch (error) {
      if (error instanceof ApplicationFailure && error.type) retryCode = error.type;
      throw error;
    } finally {
      reportRecordingProcessing(
        observability,
        {
          ...telemetry,
          outcome: finished?.outcome ?? "retry",
          errorCode: finished
            ? finished.outcome === "failed"
              ? finished.errorCode
              : null
            : retryCode,
          wallSeconds: (performance.now() - startedAt) / 1_000,
          stages: usage.stages(),
        },
        {
          workspaceId: input.workspaceId,
          recordingId: input.recordingId,
          versionId: input.versionId,
        },
      );
    }

    async function transcribeClaimed(): Promise<RecordingTranscriptOutcome> {
      try {
        if (!objectStorage) throw new PermanentRecordingFailure("storage_unavailable");
        if (job.recording.purpose === "dictation") {
          return await transcribeDictation(objectStorage, job);
        }
        const deployment = deploymentFor(settings, db);
        const found = findRecordingTranscriptionModel(
          deployment.registry,
          job.version.providerId,
          job.version.model,
        );
        if (!found) throw new PermanentRecordingFailure("model_unavailable");
        telemetry.funding = found.provider.funding;
        // A pinned deployment sends audio to no other model, even for an
        // older version that named one.
        if (
          deployment.pinned &&
          (deployment.pinned.providerId !== found.provider.id ||
            deployment.pinned.model !== found.spec.model)
        ) {
          throw new PermanentRecordingFailure("model_unavailable");
        }
        // A meeting transcript places every word in time, to tell speakers
        // apart and to play from. A model that returns only text needs our
        // aligner to do it.
        const aligner = found.spec.capabilities.wordTimestamps ? null : alignerFor(settings);
        if (!found.spec.capabilities.wordTimestamps && !aligner) {
          throw new PermanentRecordingFailure("model_unavailable");
        }
        const resolved = await deployment.credentials(job.version.providerId, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
        });
        if (resolved === "missing") throw new PermanentRecordingFailure("missing_provider_key");
        const credentials = resolved.credentials;
        if (
          found.provider.available &&
          !(await deployment.available(found.provider.id, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: input.ownerSubjectId,
          }))
        ) {
          // A subscription the workspace is no longer signed in to.
          throw new PermanentRecordingFailure("missing_provider_key");
        }
        const charge = meetingCharge(settings, found.provider, found.spec);
        const plans = planRecordingTracks(job.recording.tracks);
        const capabilities = found.spec.capabilities;
        const requested = job.version.options;
        const signal = cancellation();
        const trackWords: RecordingTrackWords[] = [];
        let providerDiarized = false;
        let ourDiarized = false;
        let audioMilliseconds = 0;
        const languages = new Set<string>();
        const ourDiarizer = diarizerFor(settings);
        // Recognizing voices needs every speaker's voice vector, which only
        // our diarizer gives, so it tells the speakers apart whatever the model.
        const recognizeVoices =
          ourDiarizer !== null &&
          resolveWorkspaceRecordingSettings((await getWorkspace(db, input.workspaceId))?.settings)
            .voiceprints === true;
        const trackVoices: Array<{
          trackNumber: number;
          source: (typeof job.recording.tracks)[number]["source"];
          result: RecordingDiarizerResult;
        }> = [];
        for (const plan of plans) {
          const track = job.recording.tracks.find((item) => item.trackNumber === plan.trackNumber)!;
          const chunks = job.chunks.filter((chunk) => chunk.trackNumber === plan.trackNumber);
          if (chunks.length === 0) continue;
          const offsetMilliseconds = Math.min(...chunks.map((chunk) => chunk.startMilliseconds));
          const audio = await measureRecordingStage("prepare", () =>
            preparedTrackAudio({
              db,
              objectStorage,
              settings,
              actor,
              recordingId: input.recordingId,
              trackNumber: plan.trackNumber,
              mimeType: track.mimeType,
              chunks,
              offsetMilliseconds,
              knownDurationMilliseconds: Math.max(
                0,
                track.durationMilliseconds - offsetMilliseconds,
              ),
              signal,
            }),
          );
          telemetry.preparedBytes += audio.storedBytes;
          heartbeat({ phase: "transcribing", trackNumber: plan.trackNumber });
          // The model's own diarization is still requested when it has one, so
          // a failure of ours falls back to it.
          const diarize = plan.diarize && capabilities.diarization;
          const useOurs =
            plan.diarize &&
            ourDiarizer !== null &&
            (requested.diarizer === "ours" || !capabilities.diarization || recognizeVoices);
          const trackAudio = {
            bytes: audio.bytes,
            mimeType: audio.mimeType,
            fileName: `track-${plan.trackNumber}.${audio.extension}`,
          };
          const request = {
            model: found.spec.model,
            language: requested.language,
            diarize,
            maxSpeakers: requested.maxSpeakers,
            keyterms: capabilities.keyterms ? requested.keyterms : undefined,
            signal,
            scope: {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              subjectId: input.ownerSubjectId,
              requestId: `${input.versionId}:${plan.trackNumber}`,
            },
          };
          const onPiece = (piece: number) =>
            heartbeat({ phase: "transcribing", trackNumber: plan.trackNumber, piece });
          const runOurs = () =>
            useOurs
              ? measureRecordingStage("diarize", () =>
                  ourDiarizer.diarize(trackAudio, { maxSpeakers: requested.maxSpeakers, signal }),
                ).catch((error: unknown) => {
                  if (signal?.aborted) throw error;
                  telemetry.ourDiarizerFailed = true;
                  observability.warn("our diarizer failed; using the model's speakers", {
                    workspaceId: input.workspaceId,
                    recordingId: input.recordingId,
                    versionId: input.versionId,
                    trackNumber: plan.trackNumber,
                    error: error instanceof Error ? error.message : String(error),
                  });
                  return null;
                })
              : Promise.resolve(null);
          const [result, ours] = await withHeartbeat(async () => {
            return await Promise.all([
              transcribeTrack({
                provider: found.provider,
                spec: found.spec,
                audio: { ...trackAudio, extension: audio.extension },
                durationMilliseconds: audio.durationMilliseconds,
                ffmpegPath: settings.voiceInputFfmpegPath,
                credentials,
                onPiece,
                request,
                aligner,
                onAligned: (aligned) => addAlignment(telemetry, aligned),
              }),
              runOurs(),
            ]);
          });
          let words = result.words;
          if (ours) {
            words = labelWordsFromTurns(result.words, ours.turns);
            ourDiarized = true;
            trackVoices.push({ trackNumber: plan.trackNumber, source: track.source, result: ours });
          } else if (diarize && result.diarized) {
            providerDiarized = true;
          }
          for (const language of result.languages) languages.add(language);
          audioMilliseconds += result.audioMilliseconds ?? audio.durationMilliseconds;
          trackWords.push({
            trackNumber: plan.trackNumber,
            fixedLabel: plan.fixedLabel,
            words: shiftWords(words, offsetMilliseconds),
          });
        }
        const segments = buildRecordingSegments(
          withoutMicrophoneEchoes(trackWords, job.recording.tracks),
        );
        const voices: RecordingSpeakerVoice[] = [];
        if (recognizeVoices) {
          const labels = recordingSpeakerLabels(trackWords);
          for (const { trackNumber, source, result } of trackVoices) {
            for (const voice of result.voices) {
              const label = labels.get(trackNumber)?.get(voice.speaker);
              if (!label || voice.embedding.length === 0) continue;
              voices.push({
                label,
                channel: recordingVoiceChannel(source),
                model: result.voiceModel,
                embedding: voice.embedding,
                speechMilliseconds: voice.speechMilliseconds,
              });
            }
          }
        }
        const diarization = recordingDiarizationKind({
          plans,
          providerDiarized,
          ourDiarizer: ourDiarized,
        });
        const costUsdMicros = estimateRecordingTranscriptionCostMicros(
          found.spec,
          audioMilliseconds,
          {
            keyterms: capabilities.keyterms && (requested.keyterms?.length ?? 0) > 0,
          },
        );
        telemetry.audioSeconds = audioMilliseconds / 1_000;
        telemetry.diarization = diarization;
        telemetry.speakers = new Set(
          segments.flatMap((segment) => (segment.speakerLabel ? [segment.speakerLabel] : [])),
        ).size;
        telemetry.providerCostUsd = costUsdMicros === null ? null : costUsdMicros / 1_000_000;
        // A microphone beside computer or tab audio is the person recording.
        const recorderLabels = plans.flatMap((plan) => (plan.fixedLabel ? [plan.fixedLabel] : []));
        const trackSpeakers: TrackSpeaker[] = [];
        if (recorderLabels.length > 0) {
          const displayName = await workspaceMemberDisplayName(db, {
            workspaceId: input.workspaceId,
            subjectId: input.ownerSubjectId,
          }).catch((error: unknown) => {
            // Without a name a person can still say "It's me".
            observability.warn("couldn't read the recording owner's name", {
              workspaceId: input.workspaceId,
              recordingId: input.recordingId,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          });
          for (const label of recorderLabels) {
            trackSpeakers.push({ label, memberSubjectId: input.ownerSubjectId, displayName });
          }
        }
        return await measureRecordingStage("finish", async () => {
          const creditCostMicros = charge
            ? await settleMeetingCredits({
                billing: billingFor(settings, db),
                pricing: charge.pricing,
                providerId: found.provider.id,
                model: found.spec.model,
                audioMilliseconds,
                attribution: job.creditAttribution ?? { kind: "unknown" },
              })
            : null;
          const completed = await completeRecordingTranscriptVersion(db, {
            ...actor,
            versionId: input.versionId,
            processingOwner: input.processingOwner,
            languages: [...languages],
            diarized: diarization === "provider" || diarization === "ours",
            diarization,
            costUsdMicros,
            creditCostMicros,
            audioMilliseconds,
            segments: segments.map((segment) => ({
              startMilliseconds: segment.startMilliseconds,
              endMilliseconds: segment.endMilliseconds,
              trackNumber: segment.trackNumber,
              speakerLabel: segment.speakerLabel,
              text: segment.text,
              words: segment.words,
            })),
            trackSpeakers,
            voices,
          });
          telemetry.credits = creditCostMicros === null ? null : creditCostMicros / 1_000_000;
          return completed ? { outcome: "complete" } : { outcome: "skipped" };
        });
      } catch (error) {
        if (error instanceof RecordingNotFoundError) return { outcome: "skipped" };
        if (error instanceof PermanentRecordingFailure) return await fail(error.code, error);
        if (error instanceof RecordingAudioError) {
          if (error.code === "missing_chunk") {
            throw ApplicationFailure.retryable(error.message, "missing_chunk");
          }
          return await fail(error.code, error);
        }
        if (error instanceof RecordingTranscriptionError) {
          if (!error.retryable) return await fail(`provider_${error.code}`, error);
          throw ApplicationFailure.retryable(error.message, `provider_${error.code}`);
        }
        // A dictation's voice input refused to bill it: nothing was sent, and
        // retrying won't change the answer until the payer's credits do.
        if (error instanceof TranscriptionBillingRefusedError) return await fail(error.code, error);
        if (error instanceof TranscriptionServiceError) {
          if (!error.retryable) return await fail(`voice_${error.code}`, error);
          throw ApplicationFailure.retryable(error.message, `voice_${error.code}`);
        }
        if (error instanceof TranscriptionSegmenterError) {
          if (!error.retryable) return await fail(error.code, error);
          throw ApplicationFailure.retryable(error.message, error.code);
        }
        throw error;
      }
    }

    /**
     * A dictation is transcribed by the workspace's voice input, as plain text
     * without speakers: its one track is prepared like a meeting's, cut into
     * provider-sized WAV pieces, and each piece is heard and billed once.
     */
    async function transcribeDictation(
      storage: ObjectStorage,
      claimed: NonNullable<typeof job>,
    ): Promise<RecordingTranscriptOutcome> {
      const workspace = await getWorkspace(db, input.workspaceId);
      if (resolveWorkspaceVoiceInputEnabled(workspace?.settings) === false) {
        throw new PermanentRecordingFailure("policy_blocked");
      }
      const voiceInput = WorkspaceVoiceInputSettings.safeParse(workspace?.settings.voiceInput).data;
      const { service, segmenter } = dictationFor(settings, db);
      const track = claimed.recording.tracks[0];
      const chunks = claimed.chunks.filter((chunk) => chunk.trackNumber === track?.trackNumber);
      const signal = cancellation();
      const segments: Array<{
        startMilliseconds: number;
        endMilliseconds: number;
        trackNumber: number;
        speakerLabel: string | null;
        text: string;
        words: never[];
      }> = [];
      const languages = new Set<string>();
      let audioMilliseconds = 0;
      let creditCostMicros = 0;
      let charged = false;
      let listCostMicros: number | null = null;
      const offered = dictationProviders(deploymentFor(settings, db));
      if (track && chunks.length > 0) {
        const offsetMilliseconds = Math.min(...chunks.map((chunk) => chunk.startMilliseconds));
        const audio = await measureRecordingStage("prepare", () =>
          preparedTrackAudio({
            db,
            objectStorage: storage,
            settings,
            actor: actor,
            recordingId: input.recordingId,
            trackNumber: track.trackNumber,
            mimeType: track.mimeType,
            chunks,
            offsetMilliseconds,
            knownDurationMilliseconds: Math.max(0, track.durationMilliseconds - offsetMilliseconds),
            signal,
          }),
        );
        telemetry.preparedBytes += audio.storedBytes;
        if (!(await segmenter.available())) throw new PermanentRecordingFailure("unavailable");
        const providerSegmentSeconds = Math.min(
          TRANSCRIPTION_RECORDING_PROVIDER_SEGMENT_SECONDS,
          service.limits().maxDurationSeconds,
        );
        const pinned = claimed.version.providerId !== "host" ? claimed.version.providerId : null;
        const attribution = claimed.creditAttribution ?? { kind: "unknown" as const };
        heartbeat({ phase: "transcribing", trackNumber: track.trackNumber });
        const segmented = segmenter.segment({
          sourceMimeType: audio.mimeType,
          totalDurationMilliseconds: Math.max(1, Math.round(audio.durationMilliseconds)),
          providerSegmentSeconds,
          chunks: (async function* () {
            yield audio.bytes;
          })(),
          signal,
        });
        // Stepped by hand so cutting the pieces is measured apart from hearing them.
        const pieces = segmented[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await measureRecordingStage("segment", () => pieces.next());
            if (next.done) break;
            const piece = next.value;
            const trustedSeconds = wavDurationSeconds(piece.bytes) ?? undefined;
            const result = await withHeartbeat(() =>
              measureRecordingStage("transcribe", () =>
                service.transcribe({
                  workspaceId: input.workspaceId,
                  accountId: input.accountId,
                  subjectId: input.ownerSubjectId,
                  audio: piece.bytes,
                  mimeType: piece.mimeType,
                  durationSeconds: piece.durationMilliseconds / 1_000,
                  requestId: `${input.versionId}:${piece.segmentNumber}`,
                  ...(signal ? { signal } : {}),
                  preferredProvider: pinned ?? voiceInput?.preferredProvider,
                  fallbackEnabled: voiceInput?.fallbackEnabled,
                  billing: {
                    // One settlement per piece of this version, however many
                    // attempts the activity takes: a retry that hears it again
                    // settles the same unit, so the payer is billed once.
                    sourceId: `${input.recordingId}:${input.versionId}:${piece.segmentNumber}`,
                    attribution,
                    trustedDurationSeconds: trustedSeconds,
                  },
                }),
              ),
            );
            creditCostMicros += result.creditCostMicros ?? 0;
            const heard = offered.find((provider) => provider.id === result.providerId);
            if (heard) {
              telemetry.provider = heard.id;
              telemetry.model = heard.model.model;
              telemetry.funding = heard.provider.funding;
            }
            if (
              heard?.provider.funding === "deployment" &&
              voiceInputCreditBillingActive(settings)
            ) {
              charged = true;
            }
            const pieceCost = heard
              ? estimateRecordingTranscriptionCostMicros(heard.model, piece.durationMilliseconds)
              : null;
            if (pieceCost !== null) listCostMicros = (listCostMicros ?? 0) + pieceCost;
            for (const language of result.languages ?? []) languages.add(language);
            audioMilliseconds += piece.durationMilliseconds;
            const text = result.text.trim();
            if (!text) continue;
            const startMilliseconds = offsetMilliseconds + piece.startMilliseconds;
            segments.push({
              startMilliseconds,
              endMilliseconds: startMilliseconds + piece.durationMilliseconds,
              trackNumber: track.trackNumber,
              speakerLabel: null,
              text,
              words: [],
            });
          }
        } finally {
          await pieces.return?.();
        }
      }
      telemetry.audioSeconds = audioMilliseconds / 1_000;
      telemetry.providerCostUsd = listCostMicros === null ? null : listCostMicros / 1_000_000;
      telemetry.credits = charged ? creditCostMicros / 1_000_000 : null;
      const completed = await measureRecordingStage("finish", () =>
        completeRecordingTranscriptVersion(db, {
          ...actor,
          versionId: input.versionId,
          processingOwner: input.processingOwner,
          languages: [...languages],
          diarized: false,
          diarization: "none",
          // The list price, like a meeting's; a version charged in credits
          // also records the credits, and its ledger debit is what counts.
          costUsdMicros: listCostMicros,
          creditCostMicros: charged ? creditCostMicros : null,
          audioMilliseconds,
          segments,
        }),
      );
      return completed ? { outcome: "complete", ...expiry } : { outcome: "skipped" };
    }

    /**
     * Charge a meeting on a deployment-funded model in credits, once per
     * version however many attempts it takes. The transcript is already
     * made, so a failed charge is logged and reconciled by the next voice
     * admission rather than failing the version.
     */
    async function settleMeetingCredits(charge: {
      billing: TranscriptionBilling;
      pricing: VoiceInputPricing;
      providerId: string;
      model: string;
      audioMilliseconds: number;
      attribution: NonNullable<NonNullable<typeof job>["creditAttribution"]>;
    }): Promise<number> {
      const seconds = charge.audioMilliseconds / 1_000;
      try {
        return (
          await charge.billing.settle({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            providerId: charge.providerId,
            model: charge.model,
            pricing: charge.pricing,
            usage: null,
            billing: {
              sourceId: `${input.recordingId}:${input.versionId}`,
              attribution: charge.attribution,
              trustedDurationSeconds: seconds,
            },
          })
        ).creditCostMicros;
      } catch (error) {
        observability.error(
          "meeting transcript charge is unsettled after the transcript was made",
          {
            workspaceId: input.workspaceId,
            recordingId: input.recordingId,
            versionId: input.versionId,
            providerId: charge.providerId,
            error: error instanceof Error ? error.message.slice(0, 500) : String(error),
          },
        );
        return 0;
      }
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
    /** Bytes this call wrote to storage: 0 when an earlier version's file was reused. */
    storedBytes: number;
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
          storedBytes: 0,
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
    return { ...prepared, storedBytes: prepared.bytes.byteLength };
  }

  /** Retries ran out on a retryable failure: fail the version with its last cause. */
  async function failRecordingTranscript(
    input: RecordingTranscriptInput & { errorCode: string; errorMessage?: string },
  ): Promise<{ expireAfterMilliseconds?: number }> {
    const { db, observability } = await services();
    observability.warn("recording transcript failed after retries", {
      workspaceId: input.workspaceId,
      recordingId: input.recordingId,
      versionId: input.versionId,
      errorCode: input.errorCode,
      ...(input.errorMessage ? { error: input.errorMessage.slice(0, 1_000) } : {}),
    });
    await failRecordingTranscriptVersion(db, {
      workspaceId: input.workspaceId,
      subjectId: input.ownerSubjectId,
      versionId: input.versionId,
      processingOwner: input.processingOwner,
      errorCode: input.errorCode,
    }).catch((error: unknown) => {
      if (!(error instanceof RecordingNotFoundError)) throw error;
    });
    const recording = await getRecording(db, {
      workspaceId: input.workspaceId,
      subjectId: input.ownerSubjectId,
      recordingId: input.recordingId,
    }).catch(() => null);
    return recording?.purpose === "dictation"
      ? { expireAfterMilliseconds: DICTATION_RETENTION_MILLISECONDS }
      : {};
  }

  /**
   * A dictation's day is up: delete it as its owner would, unless it is
   * already gone. Only dictations; anything else is left alone.
   */
  async function expireDictation(
    input: RecordingWorkInput,
  ): Promise<{ deleted: number; purged: boolean }> {
    const { db } = await services();
    const actor = { workspaceId: input.workspaceId, subjectId: input.ownerSubjectId };
    try {
      const recording = await getRecording(db, { ...actor, recordingId: input.recordingId });
      if (recording.purpose !== "dictation") return { deleted: 0, purged: false };
      await markRecordingDeleting(db, { ...actor, recordingId: input.recordingId });
    } catch (error) {
      if (error instanceof RecordingNotFoundError) return { deleted: 0, purged: false };
      throw error;
    }
    return await deleteRecordingMedia(input);
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
    const work: StalledRecordingWork[] = await listStalledRecordingWork(db, 50);
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

  /**
   * Apply each workspace's recording retention: delete the audio of meetings
   * past their audio period (the transcript stays), and delete meetings past
   * their transcript period, as their owner would.
   */
  async function applyRecordingRetention(): Promise<{
    found: number;
    audioDeleted: number;
    recordingsDeleted: number;
    failed: number;
  }> {
    const { db, objectStorage, startRecordingWorkflow, observability } = await services();
    const due = await listDueRecordingRetention(db, 50);
    let audioDeleted = 0;
    let recordingsDeleted = 0;
    let failed = 0;
    for (const item of due) {
      const actor = { workspaceId: item.workspaceId, subjectId: item.ownerSubjectId };
      try {
        if (item.kind === "recording") {
          await markRecordingDeleting(db, { ...actor, recordingId: item.recordingId });
          // The recovery sweep starts it later if this start fails.
          await startRecordingWorkflow?.({
            kind: "deletion",
            accountId: item.accountId,
            workspaceId: item.workspaceId,
            recordingId: item.recordingId,
            versionId: null,
            ownerSubjectId: item.ownerSubjectId,
          });
          recordingsDeleted += 1;
          continue;
        }
        if (!objectStorage) {
          throw ApplicationFailure.retryable(
            "Object storage is unavailable",
            "storage_unavailable",
          );
        }
        const keys = await beginRecordingAudioExpiry(db, {
          ...actor,
          recordingId: item.recordingId,
        });
        if (keys === null) continue;
        const prefix = `workspaces/${item.workspaceId}/recordings/${item.recordingId}/`;
        for (const key of keys) {
          if (key.startsWith(prefix)) await objectStorage.deleteObject(key);
        }
        await completeRecordingAudioExpiry(db, { ...actor, recordingId: item.recordingId });
        audioDeleted += 1;
      } catch (error) {
        if (error instanceof RecordingNotFoundError) continue;
        failed += 1;
        observability.warn("recording retention failed", {
          workspaceId: item.workspaceId,
          recordingId: item.recordingId,
          kind: item.kind,
          error: error instanceof Error ? error.message.slice(0, 1_000) : String(error),
        });
      }
    }
    return { found: due.length, audioDeleted, recordingsDeleted, failed };
  }

  return {
    transcribeRecordingVersion,
    failRecordingTranscript,
    deleteRecordingMedia,
    expireDictation,
    recoverRecordingWorkflows,
    applyRecordingRetention,
  };
}

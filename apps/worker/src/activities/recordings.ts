import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  buildRecordingSegments,
  createVoiceInputBilling,
  estimateRecordingTranscriptionCostMicros,
  findRecordingTranscriptionModel,
  labelWordsFromTurns,
  mergeRecordingTranscriptionPieces,
  planRecordingTracks,
  planRecordingTextSpans,
  planRecordingTranscriptionPieces,
  recordingDiarizationKind,
  recordingSpeakerLabels,
  recordingWordsFromText,
  RecordingTranscriptionError,
  TranscriptionBillingRefusedError,
  TranscriptionServiceError,
  type RecordingDiarizerResult,
  type RecordingDiarizer,
  type RecordingTextSpan,
  type RecordingTranscribedWord,
  type RecordingTranscriptionAudio,
  type RecordingTranscriptionCredentials,
  type RecordingTranscriptionModelSpec,
  type RecordingTranscriptionProvider,
  type RecordingTranscriptionProviderRegistry,
  type RecordingTranscriptionRequest,
  type RecordingTranscriptionResult,
  type RecordingTrackWords,
  type SpeakerTurn,
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
  transcriptText,
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
  prepareRecordingTrackAudio,
  preparedAudioFormat,
  recordingAudioContainer,
  RecordingAudioError,
  RECORDING_PIECE_BYTES_PER_SECOND,
  renderRecordingAudioPiece,
  type RecordingPieceFormat,
} from "./recording-audio";
import type { ControlActivityServices } from "./types";
import { createLocalDiarizer, recordingSpeakersConfig } from "./recording-speakers";

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
        : await renderRecordingAudioPiece({
            audio: input.audio,
            startMilliseconds: piece.startMilliseconds,
            endMilliseconds: piece.endMilliseconds,
            whole,
            format: format ?? source,
            ffmpegPath: input.ffmpegPath,
            tempRoot: input.tempRoot,
            signal: input.request.signal,
          }).then((rendered) => ({
            bytes: rendered.bytes,
            mimeType: rendered.mimeType,
            fileName: `${input.audio.fileName.replace(/\.[^.]+$/u, "")}-${index}.${rendered.extension}`,
          }));
    const result = await input.provider
      .transcribe(
        {
          ...input.request,
          audio: { bytes: audio.bytes, mimeType: audio.mimeType, fileName: audio.fileName },
        },
        input.credentials,
      )
      .catch((error: unknown) => {
        throw asRecordingTranscriptionError(error);
      });
    parts.push({ piece, result });
  }
  return mergeRecordingTranscriptionPieces(parts);
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

/** Text-only models hear this many spans of a track at once. */
const TEXT_SPAN_CONCURRENCY = 4;

/**
 * How a meeting's transcript is paid for. A deployment-funded model with a
 * credit price is charged in Opengeni credits where credit billing is on;
 * everything else (the workspace's own key or subscription, or a
 * deployment that does not charge credits) counts toward the workspace's
 * allowance at its list price.
 */
function meetingCharge(
  settings: Settings,
  provider: RecordingTranscriptionProvider,
  spec: RecordingTranscriptionModelSpec,
): { pricing: VoiceInputPricing } | null {
  if (provider.funding !== "deployment" || !voiceInputCreditBillingActive(settings)) return null;
  return spec.creditPricing ? { pricing: spec.creditPricing } : null;
}

/**
 * Transcribe one track with a model that returns only text, such as a
 * subscription's dictation model. With our diarizer's turns each span sent
 * is one speaker, who then owns its words; without them the track is cut
 * only to the model's limits. Each span's text is spread over its time as
 * estimated word timings.
 */
export async function transcribeTextTrack(input: {
  provider: RecordingTranscriptionProvider;
  spec: RecordingTranscriptionModelSpec;
  audio: RecordingTranscriptionAudio & { extension: string };
  durationMilliseconds: number;
  ffmpegPath: string;
  credentials: RecordingTranscriptionCredentials | null;
  request: Omit<RecordingTranscriptionRequest, "audio">;
  turns: readonly SpeakerTurn[] | null;
  onPiece?: (index: number) => void;
  tempRoot?: string;
}): Promise<RecordingTranscriptionResult> {
  const { source, format, maxPieceMilliseconds } = pieceShape(input.spec, input.audio.extension);
  const spans = planRecordingTextSpans(
    input.durationMilliseconds,
    input.turns,
    maxPieceMilliseconds,
  );
  const results: Array<{ span: RecordingTextSpan; result: RecordingTranscriptionResult } | null> =
    spans.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < spans.length) {
      const index = next;
      next += 1;
      const span = spans[index]!;
      input.onPiece?.(index);
      const whole =
        spans.length === 1 &&
        span.startMilliseconds === 0 &&
        span.endMilliseconds >= Math.floor(input.durationMilliseconds);
      const audio =
        whole && !format
          ? input.audio
          : await renderRecordingAudioPiece({
              audio: input.audio,
              startMilliseconds: span.startMilliseconds,
              endMilliseconds: span.endMilliseconds,
              whole,
              format: format ?? source,
              ffmpegPath: input.ffmpegPath,
              tempRoot: input.tempRoot,
              signal: input.request.signal,
            }).then((rendered) => ({
              bytes: rendered.bytes,
              mimeType: rendered.mimeType,
              fileName: `${input.audio.fileName.replace(/\.[^.]+$/u, "")}-${index}.${rendered.extension}`,
            }));
      const result = await input.provider
        .transcribe(
          {
            ...input.request,
            audio: { bytes: audio.bytes, mimeType: audio.mimeType, fileName: audio.fileName },
            ...(input.request.scope
              ? {
                  scope: {
                    ...input.request.scope,
                    requestId: `${input.request.scope.requestId}:${index}`,
                  },
                }
              : {}),
          },
          input.credentials,
        )
        .catch((error: unknown) => {
          throw asRecordingTranscriptionError(error);
        });
      results[index] = { span, result };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TEXT_SPAN_CONCURRENCY, spans.length) }, () => worker()),
  );
  const languages = new Set<string>();
  const words: RecordingTranscribedWord[] = [];
  let audioMilliseconds = 0;
  for (const entry of results) {
    if (!entry) continue;
    for (const language of entry.result.languages) languages.add(language);
    audioMilliseconds += entry.span.endMilliseconds - entry.span.startMilliseconds;
    words.push(...recordingWordsFromText(transcriptText(entry.result), entry.span));
  }
  return { languages: [...languages], audioMilliseconds, diarized: false, words };
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
          : createFfmpegTranscriptionSegmenter({ ffmpegPath: settings.voiceInputFfmpegPath }),
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
    const job = await claimRecordingTranscriptVersion(db, {
      ...actor,
      versionId: input.versionId,
      processingOwner: input.processingOwner,
      leaseSeconds: TRANSCRIPT_LEASE_SECONDS,
    });
    if (!job) return { outcome: "skipped" };
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
      // A pinned deployment sends audio to no other model, even for an
      // older version that named one.
      if (
        deployment.pinned &&
        (deployment.pinned.providerId !== found.provider.id ||
          deployment.pinned.model !== found.spec.model)
      ) {
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
      // Models that return only text: speakers come from the tracks and our
      // diarizer, and word timings are estimated within each span.
      const textOnly = !capabilities.wordTimestamps;
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
        // The model's own diarization is still requested when it has one, so
        // a failure of ours falls back to it.
        const diarize = plan.diarize && capabilities.diarization && !textOnly;
        const useOurs =
          plan.diarize &&
          ourDiarizer !== null &&
          (requested.diarizer === "ours" ||
            !capabilities.diarization ||
            recognizeVoices ||
            textOnly);
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
            ? ourDiarizer
                .diarize(trackAudio, { maxSpeakers: requested.maxSpeakers, signal })
                .catch((error: unknown) => {
                  if (signal?.aborted) throw error;
                  observability.warn(
                    textOnly
                      ? "our diarizer failed; this track has no speakers"
                      : "our diarizer failed; using the model's speakers",
                    {
                      workspaceId: input.workspaceId,
                      recordingId: input.recordingId,
                      versionId: input.versionId,
                      trackNumber: plan.trackNumber,
                      error: error instanceof Error ? error.message : String(error),
                    },
                  );
                  return null;
                })
            : Promise.resolve(null);
        const [result, ours] = await withHeartbeat(async () => {
          if (textOnly) {
            // The turns decide where the track is cut, so they come first.
            const turns = await runOurs();
            const text = await transcribeTextTrack({
              provider: found.provider,
              spec: found.spec,
              audio: { ...trackAudio, extension: audio.extension },
              durationMilliseconds: audio.durationMilliseconds,
              ffmpegPath: settings.voiceInputFfmpegPath,
              credentials,
              onPiece,
              request,
              turns: turns?.turns ?? null,
            });
            return [text, turns] as const;
          }
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
      const segments = buildRecordingSegments(trackWords);
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
        voices,
      });
      return completed ? { outcome: "complete" } : { outcome: "skipped" };
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
        const audio = await preparedTrackAudio({
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
        });
        if (!(await segmenter.available())) throw new PermanentRecordingFailure("unavailable");
        const providerSegmentSeconds = Math.min(
          TRANSCRIPTION_RECORDING_PROVIDER_SEGMENT_SECONDS,
          service.limits().maxDurationSeconds,
        );
        const pinned = claimed.version.providerId !== "host" ? claimed.version.providerId : null;
        const attribution = claimed.creditAttribution ?? { kind: "unknown" as const };
        heartbeat({ phase: "transcribing", trackNumber: track.trackNumber });
        for await (const piece of segmenter.segment({
          sourceMimeType: audio.mimeType,
          totalDurationMilliseconds: Math.max(1, Math.round(audio.durationMilliseconds)),
          providerSegmentSeconds,
          chunks: (async function* () {
            yield audio.bytes;
          })(),
          signal,
        })) {
          const trustedSeconds = wavDurationSeconds(piece.bytes) ?? undefined;
          const result = await withHeartbeat(() =>
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
          );
          creditCostMicros += result.creditCostMicros ?? 0;
          const heard = offered.find((provider) => provider.id === result.providerId);
          if (heard?.provider.funding === "deployment" && voiceInputCreditBillingActive(settings)) {
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
      }
      const completed = await completeRecordingTranscriptVersion(db, {
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
      });
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

export type StartRecordingWorkflowInput = StalledRecordingWork;

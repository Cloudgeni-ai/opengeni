import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * Recordings: captured conversations (meetings, interviews, site walks) with
 * one or more audio tracks, versioned transcripts and editable speakers.
 * Visibility matches chats: "private" is Only me, "workspace" is shared.
 */
export const RECORDING_MAX_TRACKS = 8;
export const RECORDING_MAX_CHUNK_BYTES = 64 * 1024 * 1024;
export const RECORDING_MAX_DURATION_MILLISECONDS = 10 * 60 * 60 * 1_000;
export const RECORDING_UPLOAD_BATCH_MAX = 50;

export const RecordingVisibility = /* @__PURE__ */ defineSchema(() =>
  z.enum(["private", "workspace"]),
);
export type RecordingVisibility = z.infer<typeof RecordingVisibility>;

export const RecordingState = /* @__PURE__ */ defineSchema(() =>
  z.enum(["capturing", "processing", "ready", "failed"]),
);
export type RecordingState = z.infer<typeof RecordingState>;

/** microphone: the person recording; system: the computer's audio (the other side). */
export const RecordingTrackSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["microphone", "system", "mixed", "upload"]),
);
export type RecordingTrackSource = z.infer<typeof RecordingTrackSource>;

export const RecordingTranscriptVersionState = /* @__PURE__ */ defineSchema(() =>
  z.enum(["queued", "processing", "complete", "failed"]),
);
export type RecordingTranscriptVersionState = z.infer<typeof RecordingTranscriptVersionState>;

export const RecordingSpeakerSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["confirmed", "suggested", "carried_over", "track"]),
);
export type RecordingSpeakerSource = z.infer<typeof RecordingSpeakerSource>;

/**
 * Who told the speakers apart in a version: the transcription provider, our
 * own diarizer, the tracks alone (microphone versus system audio), or nobody.
 */
export const RecordingDiarization = /* @__PURE__ */ defineSchema(() =>
  z.enum(["provider", "ours", "tracks", "none"]),
);
export type RecordingDiarization = z.infer<typeof RecordingDiarization>;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
const externalRef = z.string().trim().min(1).max(512);
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(4096),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue).max(100),
    z.record(z.string().max(128), jsonValue),
  ]),
);
/** Product-owned metadata; Opengeni stores and filters on it but never interprets it. */
const recordingMetadata = z
  .record(z.string().min(1).max(128), jsonValue)
  .refine((value) => JSON.stringify(value).length <= 16_384, "metadata is too large");

/** How to transcribe; every field is optional and falls back to workspace defaults. */
export const RecordingTranscriptionOptions = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      providerId: z.string().trim().min(1).max(128).optional(),
      model: z.string().trim().min(1).max(128).optional(),
      /** ISO 639-1 or 639-3 hint; omitted means detect. */
      language: z
        .string()
        .regex(/^[a-z]{2,3}$/u)
        .optional(),
      /** Upper bound on distinct speakers when the model diarizes. */
      maxSpeakers: z.number().int().min(1).max(32).optional(),
      /** Names and terms the model should recognize. */
      keyterms: z.array(z.string().trim().min(1).max(50)).max(100).optional(),
    })
    .strict(),
);
export type RecordingTranscriptionOptions = z.infer<typeof RecordingTranscriptionOptions>;

/**
 * A workspace's recording defaults. New recordings are Only me unless the
 * workspace says otherwise; products may always set visibility explicitly.
 */
export const WorkspaceRecordingSettings = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      defaultVisibility: RecordingVisibility.optional(),
      /** Provider and model new transcripts use when a request names none. */
      transcription: z
        .object({
          providerId: z.string().trim().min(1).max(128),
          model: z.string().trim().min(1).max(128),
        })
        .strict()
        .optional(),
    })
    .strict(),
);
export type WorkspaceRecordingSettings = z.infer<typeof WorkspaceRecordingSettings>;

/** Read a workspace's recording defaults leniently; a bad value means none. */
export function resolveWorkspaceRecordingSettings(settings: unknown): WorkspaceRecordingSettings {
  const value =
    settings !== null && typeof settings === "object"
      ? (settings as { recordings?: unknown }).recordings
      : undefined;
  return WorkspaceRecordingSettings.safeParse(value ?? {}).data ?? {};
}

export const CreateRecordingRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** Client-generated id; creating the same id again returns the existing recording. */
      recordingId: z.string().uuid(),
      title: z.string().trim().min(1).max(300).optional(),
      visibility: RecordingVisibility.optional(),
      startedAt: z.string().datetime({ offset: true }).optional(),
      externalRef: externalRef.optional(),
      metadata: recordingMetadata.optional(),
      tracks: z
        .array(
          z
            .object({
              trackNumber: z
                .number()
                .int()
                .min(0)
                .max(RECORDING_MAX_TRACKS - 1),
              source: RecordingTrackSource,
              mimeType: z.string().trim().min(1).max(128),
            })
            .strict(),
        )
        .min(1)
        .max(RECORDING_MAX_TRACKS)
        .refine(
          (tracks) => new Set(tracks.map((track) => track.trackNumber)).size === tracks.length,
          "track numbers must be unique",
        ),
      transcription: RecordingTranscriptionOptions.optional(),
    })
    .strict(),
);
export type CreateRecordingRequest = z.infer<typeof CreateRecordingRequest>;

export const RecordingChunkDescriptor = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      chunkNumber: z.number().int().min(0).max(100_000),
      byteLength: z.number().int().positive().max(RECORDING_MAX_CHUNK_BYTES),
      sha256: sha256Hex,
      startMilliseconds: z.number().int().min(0).max(RECORDING_MAX_DURATION_MILLISECONDS),
      durationMilliseconds: z.number().int().min(0).max(RECORDING_MAX_DURATION_MILLISECONDS),
    })
    .strict(),
);
export type RecordingChunkDescriptor = z.infer<typeof RecordingChunkDescriptor>;

/** Reserve chunks and get presigned URLs to PUT their bytes straight to storage. */
export const CreateRecordingUploadsRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      trackNumber: z
        .number()
        .int()
        .min(0)
        .max(RECORDING_MAX_TRACKS - 1),
      chunks: z.array(RecordingChunkDescriptor).min(1).max(RECORDING_UPLOAD_BATCH_MAX),
    })
    .strict(),
);
export type CreateRecordingUploadsRequest = z.infer<typeof CreateRecordingUploadsRequest>;

export type RecordingChunkUpload = {
  chunkNumber: number;
  /** Already stored; skip the PUT. */
  uploaded: boolean;
  url: string | null;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string | null;
};
export type CreateRecordingUploadsResponse = { uploads: RecordingChunkUpload[] };

/** Confirm chunks whose bytes were PUT; the server checks each object first. */
export const CompleteRecordingChunksRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      trackNumber: z
        .number()
        .int()
        .min(0)
        .max(RECORDING_MAX_TRACKS - 1),
      chunkNumbers: z
        .array(z.number().int().min(0).max(100_000))
        .min(1)
        .max(RECORDING_UPLOAD_BATCH_MAX),
    })
    .strict(),
);
export type CompleteRecordingChunksRequest = z.infer<typeof CompleteRecordingChunksRequest>;

/** Capture is over: every listed chunk must be uploaded. Starts transcription. */
export const FinalizeRecordingRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      endedAt: z.string().datetime({ offset: true }).optional(),
      tracks: z
        .array(
          z
            .object({
              trackNumber: z
                .number()
                .int()
                .min(0)
                .max(RECORDING_MAX_TRACKS - 1),
              chunkCount: z.number().int().min(0).max(100_001),
            })
            .strict(),
        )
        .min(1)
        .max(RECORDING_MAX_TRACKS),
    })
    .strict(),
);
export type FinalizeRecordingRequest = z.infer<typeof FinalizeRecordingRequest>;

export const UpdateRecordingRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      title: z.string().trim().min(1).max(300).optional(),
      visibility: RecordingVisibility.optional(),
      externalRef: externalRef.nullable().optional(),
      metadata: recordingMetadata.optional(),
    })
    .strict(),
);
export type UpdateRecordingRequest = z.infer<typeof UpdateRecordingRequest>;

/** Start a new transcript version over the recording's audio. */
export const CreateRecordingTranscriptRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      transcription: RecordingTranscriptionOptions.optional(),
    })
    .strict(),
);
export type CreateRecordingTranscriptRequest = z.infer<typeof CreateRecordingTranscriptRequest>;

/**
 * Name speakers in one version. An assignment names a label (a person from
 * the directory, or a plain name); a segment override moves one segment to
 * another label. Assigning two labels to one person merges them.
 */
export const UpdateRecordingSpeakersRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      assignments: z
        .array(
          z
            .object({
              label: z.string().min(1).max(128),
              personId: z.string().uuid().nullable().optional(),
              name: z.string().trim().min(1).max(200).nullable().optional(),
            })
            .strict(),
        )
        .max(64)
        .optional(),
      segmentOverrides: z
        .array(
          z
            .object({
              segmentIndex: z.number().int().min(0),
              label: z.string().min(1).max(128),
            })
            .strict(),
        )
        .max(500)
        .optional(),
    })
    .strict(),
);
export type UpdateRecordingSpeakersRequest = z.infer<typeof UpdateRecordingSpeakersRequest>;

/**
 * Correct the text of segments in one version. The version itself never
 * changes; edits are a layer on top. `text: null` reverts to the original.
 */
export const UpdateRecordingSegmentsRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      edits: z
        .array(
          z
            .object({
              segmentIndex: z.number().int().min(0),
              text: z.string().max(65_536).nullable(),
            })
            .strict(),
        )
        .min(1)
        .max(500),
    })
    .strict(),
);
export type UpdateRecordingSegmentsRequest = z.infer<typeof UpdateRecordingSegmentsRequest>;

export const CreateRecordingPersonRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      displayName: z.string().trim().min(1).max(200),
      email: z.string().trim().email().max(320).optional(),
      memberSubjectId: z.string().min(1).max(1024).optional(),
      externalRef: externalRef.optional(),
    })
    .strict(),
);
export type CreateRecordingPersonRequest = z.infer<typeof CreateRecordingPersonRequest>;

export type RecordingTrack = {
  trackNumber: number;
  kind: "audio";
  source: RecordingTrackSource;
  mimeType: string;
  chunkCount: number;
  totalBytes: number;
  durationMilliseconds: number;
  /** The worker has prepared one seekable file for this track. */
  playable: boolean;
};

export type RecordingTranscriptVersion = {
  id: string;
  recordingId: string;
  versionNumber: number;
  providerId: string;
  model: string;
  options: RecordingTranscriptionOptions;
  state: RecordingTranscriptVersionState;
  isCurrent: boolean;
  languages: string[];
  diarized: boolean;
  diarization: RecordingDiarization | null;
  audioMilliseconds: number;
  segmentCount: number;
  /** Estimated provider cost at list price, in US dollars. */
  costUsd: number | null;
  requestedBySubjectId: string;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type Recording = {
  id: string;
  workspaceId: string;
  ownerSubjectId: string;
  visibility: RecordingVisibility;
  title: string;
  state: RecordingState;
  startedAt: string;
  captureEndedAt: string | null;
  durationMilliseconds: number;
  externalRef: string | null;
  metadata: Record<string, unknown>;
  transcription: RecordingTranscriptionOptions;
  tracks: RecordingTrack[];
  /** The current transcript version, or the newest one while none is complete. */
  transcript: RecordingTranscriptVersion | null;
  createdAt: string;
  updatedAt: string;
};

export type RecordingPerson = {
  id: string;
  displayName: string;
  memberSubjectId: string | null;
  email: string | null;
  externalRef: string | null;
  createdAt: string;
};

export type RecordingSpeaker = {
  label: string;
  /** Resolved display name: the person's name, the plain name, or the label. */
  name: string;
  personId: string | null;
  source: RecordingSpeakerSource | null;
  confidence: number | null;
};

export type RecordingTranscriptSegment = {
  index: number;
  startMilliseconds: number;
  endMilliseconds: number;
  trackNumber: number | null;
  /** Effective label after human edits; null when the model gave none. */
  speakerLabel: string | null;
  /** Effective text after human edits. */
  text: string;
  /** A person corrected this segment's text. */
  edited: boolean;
};

export type RecordingTranscriptPage = {
  version: RecordingTranscriptVersion;
  speakers: RecordingSpeaker[];
  segments: RecordingTranscriptSegment[];
  /** Pass as `after` to read the next page; null at the end. */
  nextAfter: number | null;
};

export type RecordingTranscriptionModel = {
  providerId: string;
  providerName: string;
  model: string;
  name: string;
  available: boolean;
  capabilities: RecordingTranscriptionCapabilities;
  /** List price in USD per audio hour, when known. */
  usdPerHour: number | null;
};

export type RecordingTranscriptionCapabilities = {
  batch: boolean;
  live: boolean;
  diarization: boolean;
  liveDiarization: boolean;
  /** Transcribes several tracks in one call and keeps them apart. */
  multichannel: boolean;
  maxSpeakers: number | null;
  wordTimestamps: boolean;
  /** ISO 639 codes the model supports; empty means it does not say. */
  languages: string[];
  languageDetection: boolean;
  keyterms: boolean;
  /** Provider-side matching against registered voices. */
  speakerLibrary: boolean;
  maxDurationSeconds: number | null;
  maxFileBytes: number | null;
};

export const RECORDING_EVENT_TYPES = [
  "recording.started",
  "recording.finished",
  "recording.transcript.ready",
  "recording.transcript.failed",
  "recording.transcript.current_changed",
  "recording.speakers.updated",
  "recording.deleted",
] as const;
export type RecordingEventType = (typeof RECORDING_EVENT_TYPES)[number];

/**
 * The `data` of a recording webhook event. Events carry ids, states and
 * numbers only, never a title, audio or transcript text, so a receiver reads
 * the recording through the API with its own authority.
 */
export type RecordingEventData = {
  recordingId: string;
  ownerSubjectId: string;
  visibility: RecordingVisibility;
  externalRef: string | null;
  state: RecordingState;
  durationMilliseconds?: number;
  versionId?: string;
  versionNumber?: number;
  providerId?: string;
  model?: string;
  segmentCount?: number;
  languages?: string[];
  errorCode?: string | null;
  previousVersionId?: string | null;
};

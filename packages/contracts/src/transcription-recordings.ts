import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const TranscriptionRecordingErrorCode = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "permission_denied",
    "not_supported",
    "network",
    "provider",
    "policy_blocked",
    "timeout",
    "cancelled",
    "unavailable",
    "too_large",
    "invalid_audio",
    "unknown",
    "insufficient_credits",
    "allowance_exhausted",
    "monthly_model_cost_limit",
    /** The workspace is EU-only and no speech-to-text route here is EU. */
    "region_restricted",
  ]),
);
export type TranscriptionRecordingErrorCode = z.infer<typeof TranscriptionRecordingErrorCode>;

export const TranscriptionRecordingState = /* @__PURE__ */ defineSchema(() =>
  z.enum(["uploading", "segmenting", "ready", "transcribing", "complete", "failed", "discarded"]),
);
export type TranscriptionRecordingState = z.infer<typeof TranscriptionRecordingState>;

export const TranscriptionRecordingSegmentState = /* @__PURE__ */ defineSchema(() =>
  z.enum(["preparing", "pending", "transcribing", "complete", "failed"]),
);
export type TranscriptionRecordingSegmentState = z.infer<typeof TranscriptionRecordingSegmentState>;

export const ClientResumableVoiceInputConfig = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      maxDurationSeconds: primitives.positiveInteger.max(8 * 60 * 60),
      maxSizeBytes: primitives.positiveInteger.max(512 * 1024 * 1024),
      maxChunkSizeBytes: primitives.positiveInteger.max(25 * 1024 * 1024),
      providerSegmentSeconds: z.number().int().positive().max(600),
    })
    .strict(),
);
export type ClientResumableVoiceInputConfig = z.infer<typeof ClientResumableVoiceInputConfig>;

export const CreateTranscriptionRecordingRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      recordingId: primitives.uuid,
      mimeType: primitives.string.trim().min(1).max(128),
    })
    .strict(),
);
export type CreateTranscriptionRecordingRequest = z.infer<
  typeof CreateTranscriptionRecordingRequest
>;

export const FinalizeTranscriptionRecordingRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      chunkCount: z.number().int().positive().max(100_000),
      totalBytes: primitives.positiveInteger.max(512 * 1024 * 1024),
      totalDurationMilliseconds: primitives.positiveInteger.max(8 * 60 * 60 * 1_000),
    })
    .strict(),
);
export type FinalizeTranscriptionRecordingRequest = z.infer<
  typeof FinalizeTranscriptionRecordingRequest
>;

export const TranscriptionRecordingChunk = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      chunkNumber: primitives.nonnegativeInteger,
      byteLength: primitives.positiveInteger,
      sha256: primitives.string.regex(/^[0-9a-f]{64}$/),
      startMilliseconds: primitives.nonnegativeInteger,
      durationMilliseconds: primitives.nonnegativeInteger,
      deduplicated: primitives.boolean,
    })
    .strict(),
);
export type TranscriptionRecordingChunk = z.infer<typeof TranscriptionRecordingChunk>;

export const TranscriptionRecordingSegment = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      segmentNumber: primitives.nonnegativeInteger,
      state: TranscriptionRecordingSegmentState,
      startMilliseconds: primitives.nonnegativeInteger,
      durationMilliseconds: primitives.positiveInteger,
      byteLength: primitives.positiveInteger,
      errorCode: TranscriptionRecordingErrorCode.nullable(),
      retryable: primitives.boolean,
    })
    .strict(),
);
export type TranscriptionRecordingSegment = z.infer<typeof TranscriptionRecordingSegment>;

export const TranscriptionRecording = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: primitives.uuid,
      workspaceId: primitives.uuid,
      mimeType: primitives.string.trim().min(1).max(128),
      state: TranscriptionRecordingState,
      nextChunkNumber: primitives.nonnegativeInteger,
      chunkCount: primitives.nonnegativeInteger,
      totalBytes: primitives.nonnegativeInteger,
      totalDurationMilliseconds: primitives.nonnegativeInteger,
      segmentCount: primitives.nonnegativeInteger,
      completedSegmentCount: primitives.nonnegativeInteger,
      transcriptText: z.string().max(1_000_000).nullable(),
      languages: z.array(primitives.string.trim().min(1).max(64)).max(64),
      errorCode: TranscriptionRecordingErrorCode.nullable(),
      retryable: primitives.boolean,
      objectsCleaned: primitives.boolean,
      createdAt: primitives.dateTime,
      updatedAt: primitives.dateTime,
      expiresAt: primitives.dateTime,
    })
    .strict(),
);
export type TranscriptionRecording = z.infer<typeof TranscriptionRecording>;

export const TranscriptionRecordingResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      recording: TranscriptionRecording,
      segments: z.array(TranscriptionRecordingSegment).max(1_000),
      retryAfterMilliseconds: z.number().int().positive().max(60_000).optional(),
    })
    .strict(),
);
export type TranscriptionRecordingResponse = z.infer<typeof TranscriptionRecordingResponse>;

export const TranscriptionRecordingListResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      recordings: z.array(TranscriptionRecording).max(50),
    })
    .strict(),
);
export type TranscriptionRecordingListResponse = z.infer<typeof TranscriptionRecordingListResponse>;

export const UploadTranscriptionRecordingChunkResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      recording: TranscriptionRecording,
      chunk: TranscriptionRecordingChunk,
    })
    .strict(),
);
export type UploadTranscriptionRecordingChunkResponse = z.infer<
  typeof UploadTranscriptionRecordingChunkResponse
>;

export const TRANSCRIPTION_RECORDING_MAX_DURATION_SECONDS = 2 * 60 * 60;
export const TRANSCRIPTION_RECORDING_MAX_SIZE_BYTES = 512 * 1024 * 1024;
export const TRANSCRIPTION_RECORDING_MAX_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPTION_RECORDING_PROVIDER_SEGMENT_SECONDS = 50;
export const TRANSCRIPTION_RECORDING_RECOVERY_RETRY_AFTER_MILLISECONDS = 5_000;
export const TRANSCRIPTION_RECORDING_RETENTION_SECONDS = 24 * 60 * 60;

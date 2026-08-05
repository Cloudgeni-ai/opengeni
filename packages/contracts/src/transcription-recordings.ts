import { z } from "zod";

export const TranscriptionRecordingErrorCode = z.enum([
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
]);
export type TranscriptionRecordingErrorCode = z.infer<typeof TranscriptionRecordingErrorCode>;

export const TranscriptionRecordingState = z.enum([
  "uploading",
  "segmenting",
  "ready",
  "transcribing",
  "complete",
  "failed",
  "discarded",
]);
export type TranscriptionRecordingState = z.infer<typeof TranscriptionRecordingState>;

export const TranscriptionRecordingSegmentState = z.enum([
  "preparing",
  "pending",
  "transcribing",
  "complete",
  "failed",
]);
export type TranscriptionRecordingSegmentState = z.infer<typeof TranscriptionRecordingSegmentState>;

export const ClientResumableVoiceInputConfig = z
  .object({
    maxDurationSeconds: z
      .number()
      .int()
      .positive()
      .max(8 * 60 * 60),
    maxSizeBytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    maxChunkSizeBytes: z
      .number()
      .int()
      .positive()
      .max(25 * 1024 * 1024),
    providerSegmentSeconds: z.number().int().positive().max(600),
  })
  .strict();
export type ClientResumableVoiceInputConfig = z.infer<typeof ClientResumableVoiceInputConfig>;

export const CreateTranscriptionRecordingRequest = z
  .object({
    recordingId: z.string().uuid(),
    mimeType: z.string().trim().min(1).max(128),
  })
  .strict();
export type CreateTranscriptionRecordingRequest = z.infer<
  typeof CreateTranscriptionRecordingRequest
>;

export const FinalizeTranscriptionRecordingRequest = z
  .object({
    chunkCount: z.number().int().positive().max(100_000),
    totalBytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    totalDurationMilliseconds: z
      .number()
      .int()
      .positive()
      .max(8 * 60 * 60 * 1_000),
  })
  .strict();
export type FinalizeTranscriptionRecordingRequest = z.infer<
  typeof FinalizeTranscriptionRecordingRequest
>;

export const TranscriptionRecordingChunk = z
  .object({
    chunkNumber: z.number().int().nonnegative(),
    byteLength: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    startMilliseconds: z.number().int().nonnegative(),
    durationMilliseconds: z.number().int().nonnegative(),
    deduplicated: z.boolean(),
  })
  .strict();
export type TranscriptionRecordingChunk = z.infer<typeof TranscriptionRecordingChunk>;

export const TranscriptionRecordingSegment = z
  .object({
    segmentNumber: z.number().int().nonnegative(),
    state: TranscriptionRecordingSegmentState,
    startMilliseconds: z.number().int().nonnegative(),
    durationMilliseconds: z.number().int().positive(),
    byteLength: z.number().int().positive(),
    errorCode: TranscriptionRecordingErrorCode.nullable(),
    retryable: z.boolean(),
  })
  .strict();
export type TranscriptionRecordingSegment = z.infer<typeof TranscriptionRecordingSegment>;

export const TranscriptionRecording = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    mimeType: z.string().trim().min(1).max(128),
    state: TranscriptionRecordingState,
    nextChunkNumber: z.number().int().nonnegative(),
    chunkCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    totalDurationMilliseconds: z.number().int().nonnegative(),
    segmentCount: z.number().int().nonnegative(),
    completedSegmentCount: z.number().int().nonnegative(),
    transcriptText: z.string().max(1_000_000).nullable(),
    languages: z.array(z.string().trim().min(1).max(64)).max(64),
    errorCode: TranscriptionRecordingErrorCode.nullable(),
    retryable: z.boolean(),
    objectsCleaned: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type TranscriptionRecording = z.infer<typeof TranscriptionRecording>;

export const TranscriptionRecordingResponse = z
  .object({
    recording: TranscriptionRecording,
    segments: z.array(TranscriptionRecordingSegment).max(1_000),
    retryAfterMilliseconds: z.number().int().positive().max(60_000).optional(),
  })
  .strict();
export type TranscriptionRecordingResponse = z.infer<typeof TranscriptionRecordingResponse>;

export const TranscriptionRecordingListResponse = z
  .object({
    recordings: z.array(TranscriptionRecording).max(50),
  })
  .strict();
export type TranscriptionRecordingListResponse = z.infer<typeof TranscriptionRecordingListResponse>;

export const UploadTranscriptionRecordingChunkResponse = z
  .object({
    recording: TranscriptionRecording,
    chunk: TranscriptionRecordingChunk,
  })
  .strict();
export type UploadTranscriptionRecordingChunkResponse = z.infer<
  typeof UploadTranscriptionRecordingChunkResponse
>;

export const TRANSCRIPTION_RECORDING_MAX_DURATION_SECONDS = 2 * 60 * 60;
export const TRANSCRIPTION_RECORDING_MAX_SIZE_BYTES = 512 * 1024 * 1024;
export const TRANSCRIPTION_RECORDING_MAX_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPTION_RECORDING_PROVIDER_SEGMENT_SECONDS = 50;
export const TRANSCRIPTION_RECORDING_RECOVERY_RETRY_AFTER_MILLISECONDS = 5_000;
export const TRANSCRIPTION_RECORDING_RETENTION_SECONDS = 24 * 60 * 60;

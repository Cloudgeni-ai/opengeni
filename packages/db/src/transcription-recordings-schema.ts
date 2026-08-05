import { sql } from "drizzle-orm";
import { losslessText } from "./lossless-columns";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const transcriptionRecordingStateValues = [
  "uploading",
  "segmenting",
  "ready",
  "transcribing",
  "complete",
  "failed",
  "discarded",
] as const;

export const transcriptionRecordingChunkStateValues = ["uploading", "complete"] as const;
export const transcriptionRecordingObjectKindValues = ["chunk", "segment"] as const;

export const transcriptionRecordingSegmentStateValues = [
  "preparing",
  "pending",
  "transcribing",
  "complete",
  "failed",
] as const;

export const transcriptionRecordings = pgTable(
  "transcription_recordings",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    subjectId: text("subject_id").notNull(),
    mimeType: text("mime_type").notNull(),
    state: text("state", { enum: transcriptionRecordingStateValues })
      .notNull()
      .default("uploading"),
    nextChunkNumber: integer("next_chunk_number").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    totalBytes: integer("total_bytes").notNull().default(0),
    totalDurationMilliseconds: integer("total_duration_milliseconds").notNull().default(0),
    segmentCount: integer("segment_count").notNull().default(0),
    completedSegmentCount: integer("completed_segment_count").notNull().default(0),
    transcriptText: losslessText("transcript_text"),
    languages: jsonb("languages").$type<string[]>().notNull().default([]),
    errorCode: text("error_code"),
    retryable: boolean("retryable").notNull().default(false),
    providerId: text("provider_id"),
    processingGeneration: integer("processing_generation").notNull().default(0),
    processingOwner: uuid("processing_owner"),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    objectsCleanedAt: timestamp("objects_cleaned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    exactAuthority: uniqueIndex("transcription_recordings_exact_authority_uq").on(
      table.accountId,
      table.workspaceId,
      table.subjectId,
      table.id,
    ),
    subjectCreated: index("transcription_recordings_subject_created_idx").on(
      table.workspaceId,
      table.subjectId,
      table.createdAt,
    ),
    expiry: index("transcription_recordings_expiry_idx").on(table.expiresAt, table.id),
    valuesValid: check(
      "transcription_recordings_values_check",
      sql`${table.nextChunkNumber} >= 0
        and ${table.chunkCount} >= 0
        and ${table.totalBytes} >= 0
        and ${table.totalDurationMilliseconds} >= 0
        and ${table.segmentCount} >= 0
        and ${table.completedSegmentCount} >= 0
        and ${table.completedSegmentCount} <= ${table.segmentCount}
        and octet_length(${table.subjectId}) between 1 and 1024
        and octet_length(${table.mimeType}) between 1 and 128
        and (
          ${table.providerId} is null
          or octet_length(${table.providerId}) between 1 and 128
        )`,
    ),
    processingValid: check(
      "transcription_recordings_processing_check",
      sql`(
          ${table.processingOwner} is null
          and ${table.processingStartedAt} is null
        ) or (
          ${table.processingOwner} is not null
          and ${table.processingStartedAt} is not null
        )`,
    ),
  }),
);

export const transcriptionRecordingObjects = pgTable(
  "transcription_recording_objects",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    subjectId: text("subject_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    objectKey: text("object_key").primaryKey(),
    kind: text("kind", { enum: transcriptionRecordingObjectKindValues }).notNull(),
    cleanupAfter: timestamp("cleanup_after", { withTimezone: true }).notNull(),
    cleanupClaimId: uuid("cleanup_claim_id"),
    cleanupClaimedAt: timestamp("cleanup_claimed_at", { withTimezone: true }),
    cleanedAt: timestamp("cleaned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dueCleanup: index("transcription_recording_objects_due_cleanup_idx")
      .on(table.cleanupAfter, table.objectKey)
      .where(sql`${table.cleanedAt} is null`),
    claimRecovery: index("transcription_recording_objects_claim_recovery_idx")
      .on(table.cleanupClaimedAt, table.objectKey)
      .where(sql`${table.cleanedAt} is null and ${table.cleanupClaimId} is not null`),
    valuesValid: check(
      "transcription_recording_objects_values_check",
      sql`octet_length(${table.objectKey}) between 1 and 1024
        and (
          (${table.cleanupClaimId} is null and ${table.cleanupClaimedAt} is null)
          or (${table.cleanupClaimId} is not null and ${table.cleanupClaimedAt} is not null)
        )
        and (
          ${table.cleanedAt} is null
          or (${table.cleanupClaimId} is null and ${table.cleanupClaimedAt} is null)
        )`,
    ),
  }),
);

export const transcriptionRecordingChunks = pgTable(
  "transcription_recording_chunks",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    subjectId: text("subject_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    chunkNumber: integer("chunk_number").notNull(),
    state: text("state", { enum: transcriptionRecordingChunkStateValues })
      .notNull()
      .default("uploading"),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    startMilliseconds: integer("start_milliseconds").notNull(),
    durationMilliseconds: integer("duration_milliseconds").notNull(),
    objectKey: text("object_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({
      name: "transcription_recording_chunks_pk",
      columns: [table.recordingId, table.chunkNumber],
    }),
    recordingOrder: index("transcription_recording_chunks_order_idx").on(
      table.workspaceId,
      table.recordingId,
      table.chunkNumber,
    ),
    objectKey: uniqueIndex("transcription_recording_chunks_object_key_uq").on(table.objectKey),
    valuesValid: check(
      "transcription_recording_chunks_values_check",
      sql`${table.chunkNumber} >= 0
        and ${table.byteLength} > 0
        and ${table.startMilliseconds} >= 0
        and ${table.durationMilliseconds} >= 0
        and ${table.sha256} ~ '^[0-9a-f]{64}$'
        and octet_length(${table.objectKey}) between 1 and 1024
        and (
          (${table.state} = 'uploading' and ${table.completedAt} is null)
          or (${table.state} = 'complete' and ${table.completedAt} is not null)
        )`,
    ),
  }),
);

export const transcriptionRecordingSegments = pgTable(
  "transcription_recording_segments",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    subjectId: text("subject_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    segmentNumber: integer("segment_number").notNull(),
    generation: integer("generation").notNull(),
    state: text("state", { enum: transcriptionRecordingSegmentStateValues })
      .notNull()
      .default("preparing"),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    startMilliseconds: integer("start_milliseconds").notNull(),
    durationMilliseconds: integer("duration_milliseconds").notNull(),
    objectKey: text("object_key").notNull(),
    attemptId: uuid("attempt_id"),
    attemptStartedAt: timestamp("attempt_started_at", { withTimezone: true }),
    attemptDeadlineAt: timestamp("attempt_deadline_at", { withTimezone: true }),
    transcriptText: losslessText("transcript_text"),
    languages: jsonb("languages").$type<string[]>().notNull().default([]),
    providerId: text("provider_id"),
    errorCode: text("error_code"),
    retryable: boolean("retryable").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "transcription_recording_segments_pk",
      columns: [table.recordingId, table.segmentNumber],
    }),
    recordingOrder: index("transcription_recording_segments_order_idx").on(
      table.workspaceId,
      table.recordingId,
      table.segmentNumber,
    ),
    objectKey: uniqueIndex("transcription_recording_segments_object_key_uq").on(table.objectKey),
    valuesValid: check(
      "transcription_recording_segments_values_check",
      sql`${table.segmentNumber} >= 0
        and ${table.generation} > 0
        and ${table.byteLength} > 0
        and ${table.startMilliseconds} >= 0
        and ${table.durationMilliseconds} > 0
        and ${table.sha256} ~ '^[0-9a-f]{64}$'
        and octet_length(${table.objectKey}) between 1 and 1024
        and (
          (${table.attemptId} is null
            and ${table.attemptStartedAt} is null
            and ${table.attemptDeadlineAt} is null)
          or (${table.attemptId} is not null
            and ${table.attemptStartedAt} is not null
            and ${table.attemptDeadlineAt} is not null)
        )`,
    ),
  }),
);

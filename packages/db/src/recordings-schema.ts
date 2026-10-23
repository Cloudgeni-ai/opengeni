import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Migration 0930. Visibility mirrors chats: "user_private" is Only me.
export const recordingVisibilityValues = ["user_private", "workspace_shared"] as const;
export const recordingStateValues = ["capturing", "processing", "ready", "failed"] as const;
export const recordingTrackSourceValues = ["microphone", "system", "mixed", "upload"] as const;
export const recordingChunkStateValues = ["pending", "uploaded"] as const;
export const recordingTranscriptVersionStateValues = [
  "queued",
  "processing",
  "complete",
  "failed",
] as const;
export const recordingSpeakerAssignmentSourceValues = [
  "confirmed",
  "suggested",
  "carried_over",
  "track",
] as const;
export const recordingEventTypeValues = [
  "recording.finished",
  "recording.transcript.ready",
  "recording.transcript.failed",
  "recording.deleted",
] as const;

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const recordings = pgTable(
  "recordings",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerSubjectId: text("owner_subject_id").notNull(),
    visibility: text("visibility", { enum: recordingVisibilityValues })
      .notNull()
      .default("user_private"),
    title: text("title").notNull(),
    state: text("state", { enum: recordingStateValues }).notNull().default("capturing"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    captureEndedAt: timestamp("capture_ended_at", { withTimezone: true }),
    durationMilliseconds: integer("duration_milliseconds").notNull().default(0),
    externalRef: text("external_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    transcription: jsonb("transcription").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("recordings_workspace_id_uq").on(table.workspaceId, table.id),
    index("recordings_started_idx").on(table.workspaceId, table.startedAt, table.id),
    index("recordings_external_ref_idx")
      .on(table.workspaceId, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
  ],
);

export const recordingTracks = pgTable(
  "recording_tracks",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    trackNumber: integer("track_number").notNull(),
    kind: text("kind", { enum: ["audio"] })
      .notNull()
      .default("audio"),
    source: text("source", { enum: recordingTrackSourceValues }).notNull(),
    mimeType: text("mime_type").notNull(),
    chunkCount: integer("chunk_count").notNull().default(0),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
    durationMilliseconds: integer("duration_milliseconds").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.recordingId, table.trackNumber] }),
    unique("recording_tracks_workspace_uq").on(
      table.workspaceId,
      table.recordingId,
      table.trackNumber,
    ),
  ],
);

export const recordingChunks = pgTable(
  "recording_chunks",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    trackNumber: integer("track_number").notNull(),
    chunkNumber: integer("chunk_number").notNull(),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    startMilliseconds: integer("start_milliseconds").notNull(),
    durationMilliseconds: integer("duration_milliseconds").notNull(),
    objectKey: text("object_key").notNull(),
    state: text("state", { enum: recordingChunkStateValues }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.recordingId, table.trackNumber, table.chunkNumber] }),
    uniqueIndex("recording_chunks_object_key_uq").on(table.objectKey),
  ],
);

export const recordingTranscriptVersions = pgTable(
  "recording_transcript_versions",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    state: text("state", { enum: recordingTranscriptVersionStateValues })
      .notNull()
      .default("queued"),
    isCurrent: boolean("is_current").notNull().default(false),
    languages: text("languages").array().notNull().default(sql`'{}'::text[]`),
    diarized: boolean("diarized").notNull().default(false),
    audioMilliseconds: integer("audio_milliseconds").notNull().default(0),
    segmentCount: integer("segment_count").notNull().default(0),
    requestedBySubjectId: text("requested_by_subject_id").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    processingOwner: uuid("processing_owner"),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    recoveryAfter: timestamp("recovery_after", { withTimezone: true }).notNull().defaultNow(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("recording_transcript_versions_workspace_uq").on(
      table.workspaceId,
      table.recordingId,
      table.id,
    ),
    unique("recording_transcript_versions_number_uq").on(table.recordingId, table.versionNumber),
  ],
);

export const recordingTranscriptSegments = pgTable(
  "recording_transcript_segments",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    versionId: uuid("version_id").notNull(),
    segmentIndex: integer("segment_index").notNull(),
    startMilliseconds: integer("start_milliseconds").notNull(),
    endMilliseconds: integer("end_milliseconds").notNull(),
    trackNumber: integer("track_number"),
    speakerLabel: text("speaker_label"),
    text: text("text").notNull(),
    words: jsonb("words").$type<RecordingWordTiming[] | null>(),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('simple', text)`),
  },
  (table) => [primaryKey({ columns: [table.versionId, table.segmentIndex] })],
);

/** Word timing inside a segment, in milliseconds from the recording start. */
export type RecordingWordTiming = { text: string; startMs: number; endMs: number };

export const recordingPeople = pgTable(
  "recording_people",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    displayName: text("display_name").notNull(),
    memberSubjectId: text("member_subject_id"),
    email: text("email"),
    externalRef: text("external_ref"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("recording_people_workspace_id_uq").on(table.workspaceId, table.id)],
);

export const recordingSpeakerAssignments = pgTable(
  "recording_speaker_assignments",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    versionId: uuid("version_id").notNull(),
    speakerLabel: text("speaker_label").notNull(),
    personId: uuid("person_id"),
    displayName: text("display_name"),
    source: text("source", { enum: recordingSpeakerAssignmentSourceValues }).notNull(),
    confidence: real("confidence"),
    assignedBySubjectId: text("assigned_by_subject_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.versionId, table.speakerLabel] })],
);

export const recordingSegmentSpeakerOverrides = pgTable(
  "recording_segment_speaker_overrides",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    versionId: uuid("version_id").notNull(),
    segmentIndex: integer("segment_index").notNull(),
    speakerLabel: text("speaker_label").notNull(),
    assignedBySubjectId: text("assigned_by_subject_id").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.versionId, table.segmentIndex] })],
);

export const recordingEvents = pgTable(
  "recording_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    ownerSubjectId: text("owner_subject_id").notNull(),
    visibility: text("visibility", { enum: recordingVisibilityValues }).notNull(),
    type: text("type", { enum: recordingEventTypeValues }).notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("recording_events_workspace_idx").on(table.workspaceId, table.occurredAt)],
);

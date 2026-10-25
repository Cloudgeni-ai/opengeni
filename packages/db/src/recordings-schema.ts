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
export const recordingStateValues = [
  "capturing",
  "processing",
  "ready",
  "failed",
  "deleting",
] as const;
export const recordingTrackSourceValues = [
  "microphone",
  "system",
  "mixed",
  "upload",
  // Migration 0945. A browser tab an agent recorded.
  "browser_tab",
] as const;
export const recordingTrackKindValues = ["audio", "video"] as const;
// Migration 0945. "browser": an agent's browser recording, kept out of meeting lists.
export const recordingPurposeValues = ["meeting", "browser"] as const;
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
  "recording.started",
  "recording.finished",
  "recording.transcript.ready",
  "recording.transcript.failed",
  "recording.transcript.current_changed",
  "recording.speakers.updated",
  "recording.deleted",
] as const;
export const recordingDiarizationValues = ["provider", "ours", "tracks", "none"] as const;
// Migration 0940. The kind of audio a voice was heard in.
export const recordingVoiceChannelValues = ["microphone", "call", "room"] as const;
export const recordingVoiceConsentValues = ["self", "attested"] as const;

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
    purpose: text("purpose", { enum: recordingPurposeValues }).notNull().default("meeting"),
    // Migration 0945. Why a browser recording's video could not be made.
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    state: text("state", { enum: recordingStateValues }).notNull().default("capturing"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    captureEndedAt: timestamp("capture_ended_at", { withTimezone: true }),
    durationMilliseconds: integer("duration_milliseconds").notNull().default(0),
    externalRef: text("external_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    transcription: jsonb("transcription").$type<Record<string, unknown>>().notNull().default({}),
    // Migration 0946. When the workspace retention deleted the audio.
    audioDeletedAt: timestamp("audio_deleted_at", { withTimezone: true }),
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
    kind: text("kind", { enum: recordingTrackKindValues }).notNull().default("audio"),
    source: text("source", { enum: recordingTrackSourceValues }).notNull(),
    mimeType: text("mime_type").notNull(),
    chunkCount: integer("chunk_count").notNull().default(0),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
    durationMilliseconds: integer("duration_milliseconds").notNull().default(0),
    preparedObjectKey: text("prepared_object_key"),
    preparedBytes: bigint("prepared_bytes", { mode: "number" }),
    // Migration 0945.
    preparedSha256: text("prepared_sha256"),
    videoWidth: integer("video_width"),
    videoHeight: integer("video_height"),
    videoFrameCount: integer("video_frame_count"),
    // Migration 0942. The live transcript streamed for this track, if any.
    liveProviderId: text("live_provider_id"),
    liveModel: text("live_model"),
    liveStreamedMilliseconds: integer("live_streamed_milliseconds").notNull().default(0),
    liveCostUsdMicros: bigint("live_cost_usd_micros", { mode: "number" }),
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
    languages: text("languages")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    diarized: boolean("diarized").notNull().default(false),
    diarization: text("diarization", { enum: recordingDiarizationValues }),
    audioMilliseconds: integer("audio_milliseconds").notNull().default(0),
    segmentCount: integer("segment_count").notNull().default(0),
    costUsdMicros: bigint("cost_usd_micros", { mode: "number" }),
    requestedBySubjectId: text("requested_by_subject_id").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    processingOwner: uuid("processing_owner"),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
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
    voiceConsent: text("voice_consent", { enum: recordingVoiceConsentValues }),
    voiceConsentBySubjectId: text("voice_consent_by_subject_id"),
    voiceConsentedAt: timestamp("voice_consented_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("recording_people_workspace_id_uq").on(table.workspaceId, table.id)],
);

export const recordingVoiceprints = pgTable(
  "recording_voiceprints",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    personId: uuid("person_id").notNull(),
    channel: text("channel", { enum: recordingVoiceChannelValues }).notNull(),
    model: text("model").notNull(),
    embedding: real("embedding").array().notNull(),
    speechMilliseconds: bigint("speech_milliseconds", { mode: "number" }).notNull().default(0),
    sampleCount: integer("sample_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.personId, table.channel, table.model] }),
  ],
);

export const recordingSpeakerVoices = pgTable(
  "recording_speaker_voices",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    versionId: uuid("version_id").notNull(),
    speakerLabel: text("speaker_label").notNull(),
    channel: text("channel", { enum: recordingVoiceChannelValues }).notNull(),
    model: text("model").notNull(),
    embedding: real("embedding").array().notNull(),
    speechMilliseconds: integer("speech_milliseconds").notNull(),
    learnedPersonId: uuid("learned_person_id"),
  },
  (table) => [primaryKey({ columns: [table.versionId, table.speakerLabel] })],
);

export const recordingVoiceRejections = pgTable("recording_voice_rejections", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  recordingId: uuid("recording_id").notNull(),
  personId: uuid("person_id").notNull(),
  model: text("model").notNull(),
  embedding: real("embedding").array().notNull(),
  rejectedBySubjectId: text("rejected_by_subject_id").notNull(),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }).notNull().defaultNow(),
});

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

export const recordingSegmentEdits = pgTable(
  "recording_segment_edits",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    versionId: uuid("version_id").notNull(),
    segmentIndex: integer("segment_index").notNull(),
    speakerLabel: text("speaker_label"),
    text: text("text"),
    editedBySubjectId: text("edited_by_subject_id").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.versionId, table.segmentIndex] })],
);

// Migration 0942. Finished live text per track while recording, a preview
// that is removed once the first transcript is ready.
export const recordingLiveSegments = pgTable(
  "recording_live_segments",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    trackNumber: integer("track_number").notNull(),
    segmentNumber: integer("segment_number").notNull(),
    startMilliseconds: integer("start_milliseconds").notNull(),
    endMilliseconds: integer("end_milliseconds").notNull(),
    text: text("text").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.recordingId, table.trackNumber, table.segmentNumber] }),
    index("recording_live_segments_sequence_idx").on(
      table.workspaceId,
      table.recordingId,
      table.sequence,
    ),
  ],
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

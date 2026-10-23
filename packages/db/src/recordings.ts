import type {
  Recording,
  RecordingDiarization,
  RecordingPerson,
  RecordingSpeaker,
  RecordingTrack,
  RecordingTranscriptionOptions,
  RecordingTranscriptPage,
  RecordingTranscriptSegment,
  RecordingTranscriptVersion,
  RecordingVisibility,
} from "@opengeni/contracts";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { rawRows, withWorkspaceSubjectRls, type Database } from "./database";
import * as schema from "./schema";
import type { RecordingWordTiming } from "./recordings-schema";

type RecordingRow = typeof schema.recordings.$inferSelect;
type TrackRow = typeof schema.recordingTracks.$inferSelect;
type ChunkRow = typeof schema.recordingChunks.$inferSelect;
type VersionRow = typeof schema.recordingTranscriptVersions.$inferSelect;
type PersonRow = typeof schema.recordingPeople.$inferSelect;

export type RecordingChunk = ChunkRow;

/** Who is acting: every call runs under row-level security as this subject. */
export type RecordingActor = { workspaceId: string; subjectId: string };

export class RecordingNotFoundError extends Error {
  readonly name = "RecordingNotFoundError";
  constructor(message = "Recording not found") {
    super(message);
  }
}

/** The request conflicts with what is stored (a reused id, different chunk bytes). */
export class RecordingConflictError extends Error {
  readonly name = "RecordingConflictError";
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Only the person who recorded may do this. */
export class RecordingForbiddenError extends Error {
  readonly name = "RecordingForbiddenError";
  constructor(message = "Only the person who recorded this can do that") {
    super(message);
  }
}

const toVisibility = (value: RecordingVisibility): RecordingRow["visibility"] =>
  value === "workspace" ? "workspace_shared" : "user_private";
const fromVisibility = (value: RecordingRow["visibility"]): RecordingVisibility =>
  value === "workspace_shared" ? "workspace" : "private";

function trackView(row: TrackRow): RecordingTrack {
  return {
    trackNumber: row.trackNumber,
    kind: "audio",
    source: row.source,
    mimeType: row.mimeType,
    chunkCount: row.chunkCount,
    totalBytes: Number(row.totalBytes),
    durationMilliseconds: row.durationMilliseconds,
    playable: row.preparedObjectKey !== null,
  };
}

export function recordingTranscriptVersionView(row: VersionRow): RecordingTranscriptVersion {
  return {
    id: row.id,
    recordingId: row.recordingId,
    versionNumber: row.versionNumber,
    providerId: row.providerId,
    model: row.model,
    options: row.options as RecordingTranscriptionOptions,
    state: row.state,
    isCurrent: row.isCurrent,
    languages: row.languages,
    diarized: row.diarized,
    diarization: row.diarization,
    audioMilliseconds: row.audioMilliseconds,
    segmentCount: row.segmentCount,
    costUsd: row.costUsdMicros === null ? null : Number(row.costUsdMicros) / 1_000_000,
    requestedBySubjectId: row.requestedBySubjectId,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function recordingView(
  row: RecordingRow,
  tracks: readonly TrackRow[],
  transcript: VersionRow | null,
): Recording {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerSubjectId: row.ownerSubjectId,
    visibility: fromVisibility(row.visibility),
    title: row.title,
    // Reads never return a recording being deleted; keep the type honest.
    state: row.state === "deleting" ? "failed" : row.state,
    startedAt: row.startedAt.toISOString(),
    captureEndedAt: row.captureEndedAt?.toISOString() ?? null,
    durationMilliseconds: row.durationMilliseconds,
    externalRef: row.externalRef,
    metadata: row.metadata,
    transcription: row.transcription as RecordingTranscriptionOptions,
    tracks: tracks
      .filter((track) => track.recordingId === row.id)
      .sort((left, right) => left.trackNumber - right.trackNumber)
      .map(trackView),
    transcript: transcript ? recordingTranscriptVersionView(transcript) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function personView(row: PersonRow): RecordingPerson {
  return {
    id: row.id,
    displayName: row.displayName,
    memberSubjectId: row.memberSubjectId,
    email: row.email,
    externalRef: row.externalRef,
    createdAt: row.createdAt.toISOString(),
  };
}

function defaultTitle(startedAt: Date): string {
  return `Recording ${startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

async function lockRecording(
  tx: Database,
  workspaceId: string,
  recordingId: string,
): Promise<RecordingRow> {
  const [row] = await tx
    .select()
    .from(schema.recordings)
    .where(and(eq(schema.recordings.workspaceId, workspaceId), eq(schema.recordings.id, recordingId)))
    .for("update");
  // A recording being deleted is gone for every caller but its deletion.
  if (!row || row.state === "deleting") throw new RecordingNotFoundError();
  return row;
}

async function loadViews(
  tx: Database,
  workspaceId: string,
  rows: readonly RecordingRow[],
): Promise<Recording[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [tracks, versions] = await Promise.all([
    tx
      .select()
      .from(schema.recordingTracks)
      .where(
        and(
          eq(schema.recordingTracks.workspaceId, workspaceId),
          inArray(schema.recordingTracks.recordingId, ids),
        ),
      ),
    tx
      .selectDistinctOn([schema.recordingTranscriptVersions.recordingId])
      .from(schema.recordingTranscriptVersions)
      .where(
        and(
          eq(schema.recordingTranscriptVersions.workspaceId, workspaceId),
          inArray(schema.recordingTranscriptVersions.recordingId, ids),
        ),
      )
      .orderBy(
        schema.recordingTranscriptVersions.recordingId,
        desc(schema.recordingTranscriptVersions.isCurrent),
        desc(schema.recordingTranscriptVersions.versionNumber),
      ),
  ]);
  const transcriptFor = new Map(versions.map((version) => [version.recordingId, version]));
  return rows.map((row) => recordingView(row, tracks, transcriptFor.get(row.id) ?? null));
}

async function insertEvent(
  tx: Database,
  recording: RecordingRow,
  type: (typeof schema.recordingEventTypeValues)[number],
  data: Record<string, unknown>,
): Promise<void> {
  await tx.insert(schema.recordingEvents).values({
    accountId: recording.accountId,
    workspaceId: recording.workspaceId,
    recordingId: recording.id,
    ownerSubjectId: recording.ownerSubjectId,
    visibility: recording.visibility,
    type,
    // Webhooks deliver `data` as is: ids and states, never titles or text.
    data: {
      recordingId: recording.id,
      ownerSubjectId: recording.ownerSubjectId,
      visibility: fromVisibility(recording.visibility),
      externalRef: recording.externalRef,
      state: recording.state,
      ...data,
    },
  });
}

export type CreateRecordingInput = RecordingActor & {
  accountId: string;
  recordingId: string;
  title?: string | undefined;
  visibility?: RecordingVisibility | undefined;
  startedAt?: Date | undefined;
  externalRef?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  tracks: ReadonlyArray<{
    trackNumber: number;
    source: TrackRow["source"];
    mimeType: string;
  }>;
  transcription?: RecordingTranscriptionOptions | undefined;
};

/** Create a recording in `capturing`. Creating the same id again returns it unchanged. */
export async function createRecording(
  db: Database,
  input: CreateRecordingInput,
): Promise<{ recording: Recording; created: boolean }> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const startedAt = input.startedAt ?? new Date();
    const inserted = await tx
      .insert(schema.recordings)
      .values({
        id: input.recordingId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        ownerSubjectId: input.subjectId,
        visibility: toVisibility(input.visibility ?? "private"),
        title: input.title ?? defaultTitle(startedAt),
        startedAt,
        externalRef: input.externalRef ?? null,
        metadata: input.metadata ?? {},
        transcription: input.transcription ?? {},
      })
      .onConflictDoNothing({ target: schema.recordings.id })
      .returning();
    const created = inserted.length > 0;
    if (created) {
      await tx.insert(schema.recordingTracks).values(
        input.tracks.map((track) => ({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          recordingId: input.recordingId,
          trackNumber: track.trackNumber,
          source: track.source,
          mimeType: track.mimeType,
        })),
      );
      await insertEvent(tx, inserted[0]!, "recording.started", {
        startedAt: startedAt.toISOString(),
        trackCount: input.tracks.length,
      });
    }
    const [row] = await tx
      .select()
      .from(schema.recordings)
      .where(
        and(
          eq(schema.recordings.workspaceId, input.workspaceId),
          eq(schema.recordings.id, input.recordingId),
        ),
      );
    // A reused id that belongs to another workspace or person is invisible here.
    if (!row || row.ownerSubjectId !== input.subjectId || row.state === "deleting") {
      throw new RecordingConflictError("This recording id is already used", "recording_id_taken");
    }
    const [recording] = await loadViews(tx, input.workspaceId, [row]);
    return { recording: recording!, created };
  });
}

export async function getRecording(
  db: Database,
  input: RecordingActor & { recordingId: string },
): Promise<Recording> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.recordings)
      .where(
        and(
          eq(schema.recordings.workspaceId, input.workspaceId),
          eq(schema.recordings.id, input.recordingId),
          ne(schema.recordings.state, "deleting"),
        ),
      );
    if (!row) throw new RecordingNotFoundError();
    const [recording] = await loadViews(tx, input.workspaceId, [row]);
    return recording!;
  });
}

export type ListRecordingsInput = RecordingActor & {
  /** Words to find in titles and current transcripts. */
  query?: string | undefined;
  externalRef?: string | undefined;
  /** Only recordings started before this instant (the previous page's last `startedAt`). */
  before?: { startedAt: Date; id: string } | undefined;
  limit?: number | undefined;
};

/** Newest first. Private recordings appear only to the person who recorded them. */
export async function listRecordings(
  db: Database,
  input: ListRecordingsInput,
): Promise<{ recordings: Recording[]; nextBefore: { startedAt: string; id: string } | null }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const conditions = [
      eq(schema.recordings.workspaceId, input.workspaceId),
      ne(schema.recordings.state, "deleting"),
    ];
    if (input.externalRef) conditions.push(eq(schema.recordings.externalRef, input.externalRef));
    if (input.before) {
      conditions.push(
        or(
          lt(schema.recordings.startedAt, input.before.startedAt),
          and(
            eq(schema.recordings.startedAt, input.before.startedAt),
            lt(schema.recordings.id, input.before.id),
          ),
        )!,
      );
    }
    const query = input.query?.trim();
    if (query) {
      const pattern = `%${query.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;
      conditions.push(
        or(
          sql`${schema.recordings.title} ILIKE ${pattern}`,
          sql`EXISTS (
            SELECT 1 FROM recording_transcript_segments segment
            JOIN recording_transcript_versions version
              ON version.id = segment.version_id AND version.is_current
            WHERE segment.workspace_id = ${schema.recordings.workspaceId}
              AND segment.recording_id = ${schema.recordings.id}
              AND segment.search @@ plainto_tsquery('simple', ${query})
          )`,
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(schema.recordings)
      .where(and(...conditions))
      .orderBy(desc(schema.recordings.startedAt), desc(schema.recordings.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      recordings: await loadViews(tx, input.workspaceId, page),
      nextBefore:
        rows.length > limit && last
          ? { startedAt: last.startedAt.toISOString(), id: last.id }
          : null,
    };
  });
}

export type UpdateRecordingInput = RecordingActor & {
  recordingId: string;
  title?: string | undefined;
  visibility?: RecordingVisibility | undefined;
  externalRef?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

/** Anyone who can see a recording may rename it; only its owner may share or unshare it. */
export async function updateRecording(db: Database, input: UpdateRecordingInput): Promise<Recording> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const row = await lockRecording(tx, input.workspaceId, input.recordingId);
    const visibility = input.visibility === undefined ? undefined : toVisibility(input.visibility);
    if (visibility !== undefined && visibility !== row.visibility) {
      if (row.ownerSubjectId !== input.subjectId) throw new RecordingForbiddenError();
    }
    const [updated] = await tx
      .update(schema.recordings)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(visibility === undefined ? {} : { visibility }),
        ...(input.externalRef === undefined ? {} : { externalRef: input.externalRef }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(schema.recordings.workspaceId, input.workspaceId),
          eq(schema.recordings.id, input.recordingId),
        ),
      )
      .returning();
    const [recording] = await loadViews(tx, input.workspaceId, [updated!]);
    return recording!;
  });
}

/**
 * Start deleting a recording: it disappears from every read at once, and the
 * deletion workflow then removes its media objects and its rows. Only the
 * person who recorded it may delete it. Repeating it is harmless.
 */
export async function markRecordingDeleting(
  db: Database,
  input: RecordingActor & { recordingId: string },
): Promise<{ ownerSubjectId: string }> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.recordings)
      .where(
        and(
          eq(schema.recordings.workspaceId, input.workspaceId),
          eq(schema.recordings.id, input.recordingId),
        ),
      )
      .for("update");
    if (!row) throw new RecordingNotFoundError();
    if (row.ownerSubjectId !== input.subjectId) throw new RecordingForbiddenError();
    if (row.state === "deleting") return { ownerSubjectId: row.ownerSubjectId };
    await tx
      .update(schema.recordings)
      .set({
        state: "deleting",
        captureEndedAt: row.captureEndedAt ?? sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(schema.recordings.workspaceId, input.workspaceId),
          eq(schema.recordings.id, input.recordingId),
        ),
      );
    await insertEvent(tx, row, "recording.deleted", {});
    return { ownerSubjectId: row.ownerSubjectId };
  });
}

/**
 * The media objects of a recording being deleted, for its deletion workflow.
 * Null when the recording is not being deleted (nothing to do).
 */
export async function listDeletingRecordingObjectKeys(
  db: Database,
  input: RecordingActor & { recordingId: string },
): Promise<string[] | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [row] = await tx
      .select({ state: schema.recordings.state })
      .from(schema.recordings)
      .where(
        and(
          eq(schema.recordings.workspaceId, input.workspaceId),
          eq(schema.recordings.id, input.recordingId),
        ),
      );
    if (row?.state !== "deleting") return null;
    const [chunks, tracks] = await Promise.all([
      tx
        .select({ objectKey: schema.recordingChunks.objectKey })
        .from(schema.recordingChunks)
        .where(
          and(
            eq(schema.recordingChunks.workspaceId, input.workspaceId),
            eq(schema.recordingChunks.recordingId, input.recordingId),
          ),
        ),
      tx
        .select({ objectKey: schema.recordingTracks.preparedObjectKey })
        .from(schema.recordingTracks)
        .where(
          and(
            eq(schema.recordingTracks.workspaceId, input.workspaceId),
            eq(schema.recordingTracks.recordingId, input.recordingId),
            isNotNull(schema.recordingTracks.preparedObjectKey),
          ),
        ),
    ]);
    return [
      ...chunks.map((chunk) => chunk.objectKey),
      ...tracks.flatMap((track) => (track.objectKey ? [track.objectKey] : [])),
    ];
  });
}

/** Remove a deleted recording's rows once its media is gone. */
export async function purgeDeletingRecording(
  db: Database,
  input: RecordingActor & { recordingId: string },
): Promise<boolean> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const removed = await tx
      .delete(schema.recordings)
      .where(
        and(
          eq(schema.recordings.workspaceId, input.workspaceId),
          eq(schema.recordings.id, input.recordingId),
          eq(schema.recordings.state, "deleting"),
        ),
      )
      .returning({ id: schema.recordings.id });
    return removed.length > 0;
  });
}

export type ReserveRecordingChunksInput = RecordingActor & {
  recordingId: string;
  trackNumber: number;
  chunks: ReadonlyArray<{
    chunkNumber: number;
    byteLength: number;
    sha256: string;
    startMilliseconds: number;
    durationMilliseconds: number;
  }>;
};

export function recordingChunkObjectKey(input: {
  workspaceId: string;
  recordingId: string;
  trackNumber: number;
  chunkNumber: number;
  sha256: string;
}): string {
  return `workspaces/${input.workspaceId}/recordings/${input.recordingId}/${input.trackNumber}/${input.chunkNumber}-${input.sha256}`;
}

/** Where the worker stores a track's prepared, seekable audio file. */
export function recordingPreparedTrackObjectKey(input: {
  workspaceId: string;
  recordingId: string;
  trackNumber: number;
  extension: string;
}): string {
  return `workspaces/${input.workspaceId}/recordings/${input.recordingId}/prepared/track-${input.trackNumber}.${input.extension}`;
}

/**
 * Record the worker's prepared file for a track and its measured duration.
 * The recording's duration becomes the longest prepared track.
 */
export async function setRecordingTrackPrepared(
  db: Database,
  input: RecordingActor & {
    recordingId: string;
    trackNumber: number;
    objectKey: string;
    bytes: number;
    durationMilliseconds: number;
  },
): Promise<void> {
  await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const recording = await lockRecording(tx, input.workspaceId, input.recordingId);
    const duration = Math.max(0, Math.round(input.durationMilliseconds));
    const updated = await tx
      .update(schema.recordingTracks)
      .set({
        preparedObjectKey: input.objectKey,
        preparedBytes: input.bytes,
        durationMilliseconds: duration,
      })
      .where(
        and(
          eq(schema.recordingTracks.workspaceId, input.workspaceId),
          eq(schema.recordingTracks.recordingId, input.recordingId),
          eq(schema.recordingTracks.trackNumber, input.trackNumber),
        ),
      )
      .returning({ trackNumber: schema.recordingTracks.trackNumber });
    if (updated.length === 0) throw new RecordingNotFoundError("Track not found");
    if (duration > recording.durationMilliseconds) {
      await tx
        .update(schema.recordings)
        .set({ durationMilliseconds: duration, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(schema.recordings.workspaceId, input.workspaceId),
            eq(schema.recordings.id, input.recordingId),
          ),
        );
    }
  });
}

/** A track's prepared file, for playback and re-runs. Null until the worker made it. */
export async function getRecordingTrackPreparedObject(
  db: Database,
  input: RecordingActor & { recordingId: string; trackNumber: number },
): Promise<{ objectKey: string; bytes: number } | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [row] = await tx
      .select({
        objectKey: schema.recordingTracks.preparedObjectKey,
        bytes: schema.recordingTracks.preparedBytes,
        state: schema.recordings.state,
      })
      .from(schema.recordingTracks)
      .innerJoin(
        schema.recordings,
        and(
          eq(schema.recordings.workspaceId, schema.recordingTracks.workspaceId),
          eq(schema.recordings.id, schema.recordingTracks.recordingId),
        ),
      )
      .where(
        and(
          eq(schema.recordingTracks.workspaceId, input.workspaceId),
          eq(schema.recordingTracks.recordingId, input.recordingId),
          eq(schema.recordingTracks.trackNumber, input.trackNumber),
        ),
      );
    if (!row || row.state === "deleting") throw new RecordingNotFoundError();
    if (!row.objectKey || row.bytes === null) return null;
    return { objectKey: row.objectKey, bytes: Number(row.bytes) };
  });
}

/**
 * Reserve chunk slots before their bytes are uploaded. Reserving a chunk
 * again with the same bytes returns the stored row, so clients can retry.
 */
export async function reserveRecordingChunks(
  db: Database,
  input: ReserveRecordingChunksInput,
): Promise<RecordingChunk[]> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const recording = await lockRecording(tx, input.workspaceId, input.recordingId);
    if (recording.ownerSubjectId !== input.subjectId) throw new RecordingForbiddenError();
    if (recording.state !== "capturing") {
      throw new RecordingConflictError("This recording is no longer capturing", "not_capturing");
    }
    const [track] = await tx
      .select()
      .from(schema.recordingTracks)
      .where(
        and(
          eq(schema.recordingTracks.workspaceId, input.workspaceId),
          eq(schema.recordingTracks.recordingId, input.recordingId),
          eq(schema.recordingTracks.trackNumber, input.trackNumber),
        ),
      );
    if (!track) throw new RecordingConflictError("This recording has no such track", "no_track");
    await tx
      .insert(schema.recordingChunks)
      .values(
        input.chunks.map((chunk) => ({
          accountId: recording.accountId,
          workspaceId: input.workspaceId,
          recordingId: input.recordingId,
          trackNumber: input.trackNumber,
          chunkNumber: chunk.chunkNumber,
          byteLength: chunk.byteLength,
          sha256: chunk.sha256,
          startMilliseconds: chunk.startMilliseconds,
          durationMilliseconds: chunk.durationMilliseconds,
          objectKey: recordingChunkObjectKey({
            workspaceId: input.workspaceId,
            recordingId: input.recordingId,
            trackNumber: input.trackNumber,
            chunkNumber: chunk.chunkNumber,
            sha256: chunk.sha256,
          }),
        })),
      )
      .onConflictDoNothing();
    const stored = await tx
      .select()
      .from(schema.recordingChunks)
      .where(
        and(
          eq(schema.recordingChunks.workspaceId, input.workspaceId),
          eq(schema.recordingChunks.recordingId, input.recordingId),
          eq(schema.recordingChunks.trackNumber, input.trackNumber),
          inArray(
            schema.recordingChunks.chunkNumber,
            input.chunks.map((chunk) => chunk.chunkNumber),
          ),
        ),
      );
    const byNumber = new Map(stored.map((chunk) => [chunk.chunkNumber, chunk]));
    return input.chunks.map((chunk) => {
      const row = byNumber.get(chunk.chunkNumber);
      if (!row || row.sha256 !== chunk.sha256 || row.byteLength !== chunk.byteLength) {
        throw new RecordingConflictError(
          `Chunk ${chunk.chunkNumber} was already reserved with different bytes`,
          "chunk_conflict",
        );
      }
      return row;
    });
  });
}

export async function listRecordingChunks(
  db: Database,
  input: RecordingActor & {
    recordingId: string;
    trackNumber?: number | undefined;
    chunkNumbers?: readonly number[] | undefined;
  },
): Promise<RecordingChunk[]> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const conditions = [
      eq(schema.recordingChunks.workspaceId, input.workspaceId),
      eq(schema.recordingChunks.recordingId, input.recordingId),
    ];
    if (input.trackNumber !== undefined)
      conditions.push(eq(schema.recordingChunks.trackNumber, input.trackNumber));
    if (input.chunkNumbers)
      conditions.push(inArray(schema.recordingChunks.chunkNumber, [...input.chunkNumbers]));
    return await tx
      .select()
      .from(schema.recordingChunks)
      .where(and(...conditions))
      .orderBy(asc(schema.recordingChunks.trackNumber), asc(schema.recordingChunks.chunkNumber));
  });
}

/** Mark chunks whose stored objects the caller has checked. Returns the updated rows. */
export async function markRecordingChunksUploaded(
  db: Database,
  input: RecordingActor & { recordingId: string; trackNumber: number; chunkNumbers: readonly number[] },
): Promise<RecordingChunk[]> {
  if (input.chunkNumbers.length === 0) return [];
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const recording = await lockRecording(tx, input.workspaceId, input.recordingId);
    if (recording.ownerSubjectId !== input.subjectId) throw new RecordingForbiddenError();
    if (recording.state !== "capturing") {
      throw new RecordingConflictError("This recording is no longer capturing", "not_capturing");
    }
    await tx
      .update(schema.recordingChunks)
      .set({ state: "uploaded", uploadedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(schema.recordingChunks.workspaceId, input.workspaceId),
          eq(schema.recordingChunks.recordingId, input.recordingId),
          eq(schema.recordingChunks.trackNumber, input.trackNumber),
          inArray(schema.recordingChunks.chunkNumber, [...input.chunkNumbers]),
          eq(schema.recordingChunks.state, "pending"),
        ),
      );
    return await tx
      .select()
      .from(schema.recordingChunks)
      .where(
        and(
          eq(schema.recordingChunks.workspaceId, input.workspaceId),
          eq(schema.recordingChunks.recordingId, input.recordingId),
          eq(schema.recordingChunks.trackNumber, input.trackNumber),
          inArray(schema.recordingChunks.chunkNumber, [...input.chunkNumbers]),
        ),
      )
      .orderBy(asc(schema.recordingChunks.chunkNumber));
  });
}

/** The provider and model a new transcript version uses, already resolved by the caller. */
export type RecordingTranscriptionChoice = {
  providerId: string;
  model: string;
  options: RecordingTranscriptionOptions;
};

export type FinalizeRecordingInput = RecordingActor & {
  recordingId: string;
  endedAt?: Date | undefined;
  tracks: ReadonlyArray<{ trackNumber: number; chunkCount: number }>;
  transcription: RecordingTranscriptionChoice;
  versionId: string;
};

/**
 * End capture. Every track's chunks 0..chunkCount-1 must be uploaded and no
 * other chunk may exist. Queues transcript version 1 and records
 * `recording.finished`. Finalizing again with the same counts returns the
 * existing state.
 */
export async function finalizeRecording(
  db: Database,
  input: FinalizeRecordingInput,
): Promise<{ recording: Recording; version: RecordingTranscriptVersion; finalized: boolean }> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const recording = await lockRecording(tx, input.workspaceId, input.recordingId);
    if (recording.ownerSubjectId !== input.subjectId) throw new RecordingForbiddenError();
    const tracks = await tx
      .select()
      .from(schema.recordingTracks)
      .where(
        and(
          eq(schema.recordingTracks.workspaceId, input.workspaceId),
          eq(schema.recordingTracks.recordingId, input.recordingId),
        ),
      );
    const requested = new Map(input.tracks.map((track) => [track.trackNumber, track.chunkCount]));
    if (
      requested.size !== input.tracks.length ||
      tracks.length !== requested.size ||
      tracks.some((track) => !requested.has(track.trackNumber))
    ) {
      throw new RecordingConflictError("Finalize must list every track once", "track_mismatch");
    }
    if (recording.state !== "capturing") {
      const sameCounts = tracks.every(
        (track) => track.chunkCount === requested.get(track.trackNumber),
      );
      const [version] = await tx
        .select()
        .from(schema.recordingTranscriptVersions)
        .where(
          and(
            eq(schema.recordingTranscriptVersions.workspaceId, input.workspaceId),
            eq(schema.recordingTranscriptVersions.recordingId, input.recordingId),
          ),
        )
        .orderBy(asc(schema.recordingTranscriptVersions.versionNumber))
        .limit(1);
      if (!sameCounts || !version) {
        throw new RecordingConflictError("This recording is already finalized", "already_finalized");
      }
      const [view] = await loadViews(tx, input.workspaceId, [recording]);
      return { recording: view!, version: recordingTranscriptVersionView(version), finalized: false };
    }
    const chunks = await tx
      .select({
        trackNumber: schema.recordingChunks.trackNumber,
        chunkNumber: schema.recordingChunks.chunkNumber,
        state: schema.recordingChunks.state,
        byteLength: schema.recordingChunks.byteLength,
        endMilliseconds: sql<number>`${schema.recordingChunks.startMilliseconds} + ${schema.recordingChunks.durationMilliseconds}`,
      })
      .from(schema.recordingChunks)
      .where(
        and(
          eq(schema.recordingChunks.workspaceId, input.workspaceId),
          eq(schema.recordingChunks.recordingId, input.recordingId),
        ),
      );
    let recordingDuration = 0;
    let totalChunks = 0;
    for (const track of tracks) {
      const count = requested.get(track.trackNumber)!;
      const own = chunks.filter((chunk) => chunk.trackNumber === track.trackNumber);
      const numbers = new Set(own.map((chunk) => chunk.chunkNumber));
      for (let index = 0; index < count; index += 1) {
        if (!numbers.has(index)) {
          throw new RecordingConflictError(
            `Track ${track.trackNumber} is missing chunk ${index}`,
            "missing_chunks",
          );
        }
      }
      if (own.some((chunk) => chunk.chunkNumber >= count)) {
        throw new RecordingConflictError(
          `Track ${track.trackNumber} has chunks past ${count - 1}`,
          "extra_chunks",
        );
      }
      if (own.some((chunk) => chunk.state !== "uploaded")) {
        throw new RecordingConflictError(
          `Track ${track.trackNumber} has chunks that are not uploaded`,
          "chunks_not_uploaded",
        );
      }
      const duration = own.reduce((max, chunk) => Math.max(max, Number(chunk.endMilliseconds)), 0);
      const bytes = own.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      recordingDuration = Math.max(recordingDuration, duration);
      totalChunks += count;
      await tx
        .update(schema.recordingTracks)
        .set({ chunkCount: count, totalBytes: bytes, durationMilliseconds: duration })
        .where(
          and(
            eq(schema.recordingTracks.workspaceId, input.workspaceId),
            eq(schema.recordingTracks.recordingId, input.recordingId),
            eq(schema.recordingTracks.trackNumber, track.trackNumber),
          ),
        );
    }
    if (totalChunks === 0) {
      throw new RecordingConflictError("This recording has no audio", "empty_recording");
    }
    const endedAt = input.endedAt ?? new Date();
    const [finalized] = await tx
      .update(schema.recordings)
      .set({
        state: "processing",
        captureEndedAt: endedAt < recording.startedAt ? recording.startedAt : endedAt,
        durationMilliseconds: recordingDuration,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(schema.recordings.workspaceId, input.workspaceId),
          eq(schema.recordings.id, input.recordingId),
        ),
      )
      .returning();
    const [version] = await tx
      .insert(schema.recordingTranscriptVersions)
      .values({
        id: input.versionId,
        accountId: recording.accountId,
        workspaceId: input.workspaceId,
        recordingId: input.recordingId,
        versionNumber: 1,
        providerId: input.transcription.providerId,
        model: input.transcription.model,
        options: input.transcription.options,
        requestedBySubjectId: input.subjectId,
      })
      .returning();
    await insertEvent(tx, finalized!, "recording.finished", {
      durationMilliseconds: recordingDuration,
      versionId: version!.id,
    });
    const [view] = await loadViews(tx, input.workspaceId, [finalized!]);
    return { recording: view!, version: recordingTranscriptVersionView(version!), finalized: true };
  });
}

/** Queue another transcript version over the same audio, for example with a newer model. */
export async function createRecordingTranscriptVersion(
  db: Database,
  input: RecordingActor & {
    recordingId: string;
    versionId: string;
    transcription: RecordingTranscriptionChoice;
  },
): Promise<RecordingTranscriptVersion> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const recording = await lockRecording(tx, input.workspaceId, input.recordingId);
    if (recording.state === "capturing") {
      throw new RecordingConflictError("This recording is still capturing", "still_capturing");
    }
    const [pending] = await tx
      .select({ id: schema.recordingTranscriptVersions.id })
      .from(schema.recordingTranscriptVersions)
      .where(
        and(
          eq(schema.recordingTranscriptVersions.workspaceId, input.workspaceId),
          eq(schema.recordingTranscriptVersions.recordingId, input.recordingId),
          inArray(schema.recordingTranscriptVersions.state, ["queued", "processing"]),
        ),
      )
      .limit(1);
    if (pending) {
      throw new RecordingConflictError(
        "A transcript for this recording is already being made",
        "transcript_pending",
      );
    }
    const [last] = await tx
      .select({ versionNumber: schema.recordingTranscriptVersions.versionNumber })
      .from(schema.recordingTranscriptVersions)
      .where(
        and(
          eq(schema.recordingTranscriptVersions.workspaceId, input.workspaceId),
          eq(schema.recordingTranscriptVersions.recordingId, input.recordingId),
        ),
      )
      .orderBy(desc(schema.recordingTranscriptVersions.versionNumber))
      .limit(1);
    const [version] = await tx
      .insert(schema.recordingTranscriptVersions)
      .values({
        id: input.versionId,
        accountId: recording.accountId,
        workspaceId: input.workspaceId,
        recordingId: input.recordingId,
        versionNumber: (last?.versionNumber ?? 0) + 1,
        providerId: input.transcription.providerId,
        model: input.transcription.model,
        options: input.transcription.options,
        requestedBySubjectId: input.subjectId,
      })
      .returning();
    if (recording.state === "failed") {
      await tx
        .update(schema.recordings)
        .set({ state: "processing", updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(schema.recordings.workspaceId, input.workspaceId),
            eq(schema.recordings.id, input.recordingId),
          ),
        );
    }
    return recordingTranscriptVersionView(version!);
  });
}

export async function listRecordingTranscriptVersions(
  db: Database,
  input: RecordingActor & { recordingId: string },
): Promise<RecordingTranscriptVersion[]> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [recording] = await tx
      .select({ id: schema.recordings.id })
      .from(schema.recordings)
      .where(
        and(
          eq(schema.recordings.workspaceId, input.workspaceId),
          eq(schema.recordings.id, input.recordingId),
          ne(schema.recordings.state, "deleting"),
        ),
      );
    if (!recording) throw new RecordingNotFoundError();
    const rows = await tx
      .select()
      .from(schema.recordingTranscriptVersions)
      .where(
        and(
          eq(schema.recordingTranscriptVersions.workspaceId, input.workspaceId),
          eq(schema.recordingTranscriptVersions.recordingId, input.recordingId),
        ),
      )
      .orderBy(desc(schema.recordingTranscriptVersions.versionNumber));
    return rows.map(recordingTranscriptVersionView);
  });
}

/** Everything a transcription worker needs for one version. */
export type RecordingTranscriptionJob = {
  recording: Recording;
  version: RecordingTranscriptVersion;
  chunks: RecordingChunk[];
  processingOwner: string;
};

/**
 * Lease a queued version for processing. Returns null when the version is
 * finished, gone, or leased by a live attempt. The same processing owner
 * (one workflow) may take its own lease back after a crash.
 */
export async function claimRecordingTranscriptVersion(
  db: Database,
  input: RecordingActor & {
    versionId: string;
    processingOwner: string;
    leaseSeconds: number;
  },
): Promise<RecordingTranscriptionJob | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [claimed] = await tx
      .update(schema.recordingTranscriptVersions)
      .set({
        state: "processing",
        processingOwner: input.processingOwner,
        processingStartedAt: sql`clock_timestamp()`,
        attemptCount: sql`${schema.recordingTranscriptVersions.attemptCount} + 1`,
      })
      .where(
        and(
          eq(schema.recordingTranscriptVersions.workspaceId, input.workspaceId),
          eq(schema.recordingTranscriptVersions.id, input.versionId),
          or(
            eq(schema.recordingTranscriptVersions.state, "queued"),
            and(
              eq(schema.recordingTranscriptVersions.state, "processing"),
              or(
                eq(schema.recordingTranscriptVersions.processingOwner, input.processingOwner),
                sql`${schema.recordingTranscriptVersions.processingStartedAt} < clock_timestamp() - make_interval(secs => ${input.leaseSeconds})`,
              ),
            ),
          ),
        ),
      )
      .returning();
    if (!claimed) return null;
    const [row] = await tx
      .select()
      .from(schema.recordings)
      .where(
        and(
          eq(schema.recordings.workspaceId, input.workspaceId),
          eq(schema.recordings.id, claimed.recordingId),
        ),
      );
    if (!row || row.state === "deleting") return null;
    const [recording] = await loadViews(tx, input.workspaceId, [row]);
    const chunks = await tx
      .select()
      .from(schema.recordingChunks)
      .where(
        and(
          eq(schema.recordingChunks.workspaceId, input.workspaceId),
          eq(schema.recordingChunks.recordingId, claimed.recordingId),
        ),
      )
      .orderBy(asc(schema.recordingChunks.trackNumber), asc(schema.recordingChunks.chunkNumber));
    return {
      recording: recording!,
      version: recordingTranscriptVersionView(claimed),
      chunks,
      processingOwner: input.processingOwner,
    };
  });
}

/** Give a leased version back to the queue after a retryable failure. */
export async function releaseRecordingTranscriptVersion(
  db: Database,
  input: RecordingActor & { versionId: string; processingOwner: string },
): Promise<boolean> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const released = await tx
      .update(schema.recordingTranscriptVersions)
      .set({ state: "queued", processingOwner: null, processingStartedAt: null })
      .where(
        and(
          eq(schema.recordingTranscriptVersions.workspaceId, input.workspaceId),
          eq(schema.recordingTranscriptVersions.id, input.versionId),
          eq(schema.recordingTranscriptVersions.state, "processing"),
          eq(schema.recordingTranscriptVersions.processingOwner, input.processingOwner),
        ),
      )
      .returning({ id: schema.recordingTranscriptVersions.id });
    return released.length > 0;
  });
}

export type CompletedRecordingSegment = {
  startMilliseconds: number;
  endMilliseconds: number;
  trackNumber: number | null;
  speakerLabel: string | null;
  text: string;
  words?: RecordingWordTiming[] | null | undefined;
};

/** Labels that name a whole track ("track-0") mean the same speaker in every version. */
export function isTrackSpeakerLabel(label: string): boolean {
  return /^track-[0-7]$/u.test(label);
}

type TimedLabel = {
  startMilliseconds: number;
  endMilliseconds: number;
  trackNumber: number | null;
  speakerLabel: string | null;
};

/**
 * Match a new version's diarized labels to the previous version's named
 * labels by overlapping speech on the same track. A new label takes the name
 * of the previous label it overlaps most, when that covers at least half of
 * its speech. Two new labels may map to one person (the model split them);
 * that is the same as a merge.
 */
export function matchCarriedSpeakerLabels(
  previous: readonly TimedLabel[],
  next: readonly TimedLabel[],
  namedPreviousLabels: ReadonlySet<string>,
): Map<string, string> {
  const speech = new Map<string, number>();
  const overlap = new Map<string, Map<string, number>>();
  const byTrack = new Map<number, TimedLabel[]>();
  for (const segment of previous) {
    if (!segment.speakerLabel || !namedPreviousLabels.has(segment.speakerLabel)) continue;
    const track = segment.trackNumber ?? -1;
    const list = byTrack.get(track) ?? [];
    list.push(segment);
    byTrack.set(track, list);
  }
  for (const list of byTrack.values()) {
    list.sort((left, right) => left.startMilliseconds - right.startMilliseconds);
  }
  const ordered = [...next].sort((left, right) => left.startMilliseconds - right.startMilliseconds);
  const cursor = new Map<number, number>();
  for (const segment of ordered) {
    const label = segment.speakerLabel;
    if (!label || isTrackSpeakerLabel(label)) continue;
    const length = Math.max(0, segment.endMilliseconds - segment.startMilliseconds);
    speech.set(label, (speech.get(label) ?? 0) + length);
    const track = segment.trackNumber ?? -1;
    const list = byTrack.get(track);
    if (!list) continue;
    // Previous segments ending before this one starts can never overlap a
    // later segment either, since both lists are ordered by start.
    let index = cursor.get(track) ?? 0;
    while (index < list.length && list[index]!.endMilliseconds <= segment.startMilliseconds) {
      index += 1;
    }
    cursor.set(track, index);
    for (let scan = index; scan < list.length; scan += 1) {
      const candidate = list[scan]!;
      if (candidate.startMilliseconds >= segment.endMilliseconds) break;
      const shared =
        Math.min(candidate.endMilliseconds, segment.endMilliseconds) -
        Math.max(candidate.startMilliseconds, segment.startMilliseconds);
      if (shared <= 0) continue;
      const counts = overlap.get(label) ?? new Map<string, number>();
      counts.set(candidate.speakerLabel!, (counts.get(candidate.speakerLabel!) ?? 0) + shared);
      overlap.set(label, counts);
    }
  }
  const matches = new Map<string, string>();
  for (const [label, counts] of overlap) {
    let best: [string, number] | null = null;
    for (const entry of counts) {
      if (!best || entry[1] > best[1]) best = entry;
    }
    const total = speech.get(label) ?? 0;
    if (best && total > 0 && best[1] * 2 >= total) matches.set(label, best[0]);
  }
  return matches;
}

/** Segments of a version with human speaker moves applied. */
async function effectiveTimedLabels(tx: Database, versionId: string): Promise<TimedLabel[]> {
  return await tx
    .select({
      startMilliseconds: schema.recordingTranscriptSegments.startMilliseconds,
      endMilliseconds: schema.recordingTranscriptSegments.endMilliseconds,
      trackNumber: schema.recordingTranscriptSegments.trackNumber,
      speakerLabel: sql<
        string | null
      >`coalesce(${schema.recordingSegmentEdits.speakerLabel}, ${schema.recordingTranscriptSegments.speakerLabel})`,
    })
    .from(schema.recordingTranscriptSegments)
    .leftJoin(
      schema.recordingSegmentEdits,
      and(
        eq(schema.recordingSegmentEdits.versionId, schema.recordingTranscriptSegments.versionId),
        eq(
          schema.recordingSegmentEdits.segmentIndex,
          schema.recordingTranscriptSegments.segmentIndex,
        ),
      ),
    )
    .where(eq(schema.recordingTranscriptSegments.versionId, versionId));
}

/**
 * Store a finished transcript and make it current. Names from the previous
 * current version carry over: whole-track speakers by label, diarized
 * speakers by overlapping speech.
 */
export async function completeRecordingTranscriptVersion(
  db: Database,
  input: RecordingActor & {
    versionId: string;
    processingOwner: string;
    languages: readonly string[];
    diarized: boolean;
    diarization: RecordingDiarization;
    costUsdMicros?: number | null | undefined;
    audioMilliseconds: number;
    segments: readonly CompletedRecordingSegment[];
    /** Speakers the capture itself identifies, such as the microphone's owner. */
    trackSpeakers?: ReadonlyArray<{ label: string; displayName: string; personId?: string | null }>;
  },
): Promise<RecordingTranscriptVersion | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [version] = await tx
      .select()
      .from(schema.recordingTranscriptVersions)
      .where(
        and(
          eq(schema.recordingTranscriptVersions.workspaceId, input.workspaceId),
          eq(schema.recordingTranscriptVersions.id, input.versionId),
        ),
      )
      .for("update");
    if (
      !version ||
      version.state !== "processing" ||
      version.processingOwner !== input.processingOwner
    ) {
      return null;
    }
    const recording = await lockRecording(tx, input.workspaceId, version.recordingId);
    const ordered = [...input.segments].sort(
      (left, right) =>
        left.startMilliseconds - right.startMilliseconds ||
        (left.trackNumber ?? 0) - (right.trackNumber ?? 0),
    );
    for (let offset = 0; offset < ordered.length; offset += 500) {
      await tx.insert(schema.recordingTranscriptSegments).values(
        ordered.slice(offset, offset + 500).map((segment, index) => ({
          accountId: recording.accountId,
          workspaceId: input.workspaceId,
          recordingId: recording.id,
          versionId: version.id,
          segmentIndex: offset + index,
          startMilliseconds: Math.max(0, Math.round(segment.startMilliseconds)),
          endMilliseconds: Math.max(
            Math.round(segment.startMilliseconds),
            Math.round(segment.endMilliseconds),
          ),
          trackNumber: segment.trackNumber,
          speakerLabel: segment.speakerLabel,
          text: segment.text,
          words: segment.words ?? null,
        })),
      );
    }
    const [previous] = await tx
      .select({ id: schema.recordingTranscriptVersions.id })
      .from(schema.recordingTranscriptVersions)
      .where(
        and(
          eq(schema.recordingTranscriptVersions.workspaceId, input.workspaceId),
          eq(schema.recordingTranscriptVersions.recordingId, recording.id),
          eq(schema.recordingTranscriptVersions.isCurrent, true),
        ),
      );
    if (previous) {
      await tx
        .update(schema.recordingTranscriptVersions)
        .set({ isCurrent: false })
        .where(eq(schema.recordingTranscriptVersions.id, previous.id));
    }
    const [completed] = await tx
      .update(schema.recordingTranscriptVersions)
      .set({
        state: "complete",
        isCurrent: true,
        languages: [...input.languages],
        diarized: input.diarized,
        diarization: input.diarization,
        costUsdMicros:
          input.costUsdMicros === null || input.costUsdMicros === undefined
            ? null
            : Math.max(0, Math.round(input.costUsdMicros)),
        audioMilliseconds: Math.max(0, Math.round(input.audioMilliseconds)),
        segmentCount: ordered.length,
        processingOwner: null,
        processingStartedAt: null,
        errorCode: null,
        completedAt: sql`clock_timestamp()`,
      })
      .where(eq(schema.recordingTranscriptVersions.id, version.id))
      .returning();
    const labels = new Set(
      ordered.map((segment) => segment.speakerLabel).filter((label): label is string => !!label),
    );
    const assignments = new Map<
      string,
      typeof schema.recordingSpeakerAssignments.$inferInsert
    >();
    for (const speaker of input.trackSpeakers ?? []) {
      if (!labels.has(speaker.label)) continue;
      assignments.set(speaker.label, {
        accountId: recording.accountId,
        workspaceId: input.workspaceId,
        recordingId: recording.id,
        versionId: version.id,
        speakerLabel: speaker.label,
        personId: speaker.personId ?? null,
        displayName: speaker.displayName,
        source: "track",
      });
    }
    if (previous) {
      const carried = await tx
        .select()
        .from(schema.recordingSpeakerAssignments)
        .where(eq(schema.recordingSpeakerAssignments.versionId, previous.id));
      const byPreviousLabel = new Map(
        carried.map((assignment) => [assignment.speakerLabel, assignment]),
      );
      for (const assignment of carried) {
        if (!isTrackSpeakerLabel(assignment.speakerLabel)) continue;
        if (!labels.has(assignment.speakerLabel)) continue;
        if (assignment.source !== "confirmed" && assignments.has(assignment.speakerLabel)) continue;
        assignments.set(assignment.speakerLabel, {
          accountId: recording.accountId,
          workspaceId: input.workspaceId,
          recordingId: recording.id,
          versionId: version.id,
          speakerLabel: assignment.speakerLabel,
          personId: assignment.personId,
          displayName: assignment.displayName,
          source: assignment.source === "confirmed" ? "carried_over" : assignment.source,
          assignedBySubjectId: assignment.assignedBySubjectId,
        });
      }
      // Diarized labels mean nothing across versions; match them by speech.
      const named = new Set(
        carried
          .filter(
            (assignment) =>
              !isTrackSpeakerLabel(assignment.speakerLabel) &&
              (assignment.source === "confirmed" || assignment.source === "carried_over"),
          )
          .map((assignment) => assignment.speakerLabel),
      );
      if (named.size > 0) {
        const matches = matchCarriedSpeakerLabels(
          await effectiveTimedLabels(tx, previous.id),
          ordered,
          named,
        );
        for (const [label, previousLabel] of matches) {
          if (assignments.has(label)) continue;
          const assignment = byPreviousLabel.get(previousLabel)!;
          assignments.set(label, {
            accountId: recording.accountId,
            workspaceId: input.workspaceId,
            recordingId: recording.id,
            versionId: version.id,
            speakerLabel: label,
            personId: assignment.personId,
            displayName: assignment.displayName,
            source: "carried_over",
            assignedBySubjectId: assignment.assignedBySubjectId,
          });
        }
      }
    }
    if (assignments.size > 0) {
      await tx.insert(schema.recordingSpeakerAssignments).values([...assignments.values()]);
    }
    const [ready] = await tx
      .update(schema.recordings)
      .set({
        state: "ready",
        durationMilliseconds:
          recording.durationMilliseconds > 0
            ? recording.durationMilliseconds
            : Math.max(0, Math.round(input.audioMilliseconds)),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(eq(schema.recordings.workspaceId, input.workspaceId), eq(schema.recordings.id, recording.id)),
      )
      .returning();
    await insertEvent(tx, ready!, "recording.transcript.ready", {
      versionId: version.id,
      versionNumber: version.versionNumber,
      providerId: version.providerId,
      model: version.model,
      segmentCount: ordered.length,
      languages: [...input.languages],
      previousVersionId: previous?.id ?? null,
    });
    return recordingTranscriptVersionView(completed!);
  });
}

/** Record that a version cannot be made. The recording fails only if it has no transcript. */
export async function failRecordingTranscriptVersion(
  db: Database,
  input: RecordingActor & { versionId: string; processingOwner: string; errorCode: string },
): Promise<RecordingTranscriptVersion | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [failed] = await tx
      .update(schema.recordingTranscriptVersions)
      .set({
        state: "failed",
        errorCode: input.errorCode.slice(0, 128),
        processingOwner: null,
        processingStartedAt: null,
        completedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(schema.recordingTranscriptVersions.workspaceId, input.workspaceId),
          eq(schema.recordingTranscriptVersions.id, input.versionId),
          eq(schema.recordingTranscriptVersions.state, "processing"),
          eq(schema.recordingTranscriptVersions.processingOwner, input.processingOwner),
        ),
      )
      .returning();
    if (!failed) return null;
    const recording = await lockRecording(tx, input.workspaceId, failed.recordingId);
    const [current] = await tx
      .select({ id: schema.recordingTranscriptVersions.id })
      .from(schema.recordingTranscriptVersions)
      .where(
        and(
          eq(schema.recordingTranscriptVersions.workspaceId, input.workspaceId),
          eq(schema.recordingTranscriptVersions.recordingId, failed.recordingId),
          eq(schema.recordingTranscriptVersions.isCurrent, true),
        ),
      );
    let eventRecording = recording;
    if (!current) {
      const [updated] = await tx
        .update(schema.recordings)
        .set({ state: "failed", updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(schema.recordings.workspaceId, input.workspaceId),
            eq(schema.recordings.id, failed.recordingId),
          ),
        )
        .returning();
      eventRecording = updated!;
    }
    await insertEvent(tx, eventRecording, "recording.transcript.failed", {
      versionId: failed.id,
      versionNumber: failed.versionNumber,
      providerId: failed.providerId,
      model: failed.model,
      errorCode: failed.errorCode,
    });
    return recordingTranscriptVersionView(failed);
  });
}

async function resolveVersion(
  tx: Database,
  workspaceId: string,
  recordingId: string,
  versionId: string | undefined,
): Promise<VersionRow> {
  const [recording] = await tx
    .select({ id: schema.recordings.id })
    .from(schema.recordings)
    .where(
      and(
        eq(schema.recordings.workspaceId, workspaceId),
        eq(schema.recordings.id, recordingId),
        ne(schema.recordings.state, "deleting"),
      ),
    );
  if (!recording) throw new RecordingNotFoundError();
  const conditions = [
    eq(schema.recordingTranscriptVersions.workspaceId, workspaceId),
    eq(schema.recordingTranscriptVersions.recordingId, recordingId),
  ];
  if (versionId) conditions.push(eq(schema.recordingTranscriptVersions.id, versionId));
  else conditions.push(eq(schema.recordingTranscriptVersions.isCurrent, true));
  const [version] = await tx
    .select()
    .from(schema.recordingTranscriptVersions)
    .where(and(...conditions));
  if (!version) throw new RecordingNotFoundError("Transcript not found");
  return version;
}

async function speakersFor(tx: Database, version: VersionRow): Promise<RecordingSpeaker[]> {
  const [labelRows, overrideRows, assignments] = await Promise.all([
    tx
      .selectDistinct({ label: schema.recordingTranscriptSegments.speakerLabel })
      .from(schema.recordingTranscriptSegments)
      .where(
        and(
          eq(schema.recordingTranscriptSegments.versionId, version.id),
          isNotNull(schema.recordingTranscriptSegments.speakerLabel),
        ),
      ),
    tx
      .selectDistinct({ label: schema.recordingSegmentEdits.speakerLabel })
      .from(schema.recordingSegmentEdits)
      .where(eq(schema.recordingSegmentEdits.versionId, version.id)),
    tx
      .select({
        label: schema.recordingSpeakerAssignments.speakerLabel,
        personId: schema.recordingSpeakerAssignments.personId,
        displayName: schema.recordingSpeakerAssignments.displayName,
        source: schema.recordingSpeakerAssignments.source,
        confidence: schema.recordingSpeakerAssignments.confidence,
        personName: schema.recordingPeople.displayName,
      })
      .from(schema.recordingSpeakerAssignments)
      .leftJoin(
        schema.recordingPeople,
        and(
          eq(schema.recordingPeople.workspaceId, schema.recordingSpeakerAssignments.workspaceId),
          eq(schema.recordingPeople.id, schema.recordingSpeakerAssignments.personId),
        ),
      )
      .where(eq(schema.recordingSpeakerAssignments.versionId, version.id)),
  ]);
  const labels = new Set<string>();
  for (const row of [...labelRows, ...overrideRows]) if (row.label) labels.add(row.label);
  const byLabel = new Map(assignments.map((assignment) => [assignment.label, assignment]));
  return [...labels].sort(compareSpeakerLabels).map((label, index) => {
    const assignment = byLabel.get(label);
    return {
      label,
      name: assignment?.personName ?? assignment?.displayName ?? `Speaker ${index + 1}`,
      personId: assignment?.personId ?? null,
      source: assignment?.source ?? null,
      confidence: assignment?.confidence ?? null,
    };
  });
}

function compareSpeakerLabels(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

/** One page of a transcript, with speaker names and segment overrides applied. */
export async function getRecordingTranscriptPage(
  db: Database,
  input: RecordingActor & {
    recordingId: string;
    versionId?: string | undefined;
    /** Segment index to continue after; omitted starts at the beginning. */
    after?: number | undefined;
    limit?: number | undefined;
  },
): Promise<RecordingTranscriptPage> {
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 2_000);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const version = await resolveVersion(tx, input.workspaceId, input.recordingId, input.versionId);
    const conditions = [eq(schema.recordingTranscriptSegments.versionId, version.id)];
    if (input.after !== undefined)
      conditions.push(gt(schema.recordingTranscriptSegments.segmentIndex, input.after));
    const rows = await tx
      .select({
        index: schema.recordingTranscriptSegments.segmentIndex,
        startMilliseconds: schema.recordingTranscriptSegments.startMilliseconds,
        endMilliseconds: schema.recordingTranscriptSegments.endMilliseconds,
        trackNumber: schema.recordingTranscriptSegments.trackNumber,
        speakerLabel: sql<
          string | null
        >`coalesce(${schema.recordingSegmentEdits.speakerLabel}, ${schema.recordingTranscriptSegments.speakerLabel})`,
        text: sql<string>`coalesce(${schema.recordingSegmentEdits.text}, ${schema.recordingTranscriptSegments.text})`,
        edited: sql<boolean>`${schema.recordingSegmentEdits.text} IS NOT NULL`,
      })
      .from(schema.recordingTranscriptSegments)
      .leftJoin(
        schema.recordingSegmentEdits,
        and(
          eq(
            schema.recordingSegmentEdits.versionId,
            schema.recordingTranscriptSegments.versionId,
          ),
          eq(
            schema.recordingSegmentEdits.segmentIndex,
            schema.recordingTranscriptSegments.segmentIndex,
          ),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(schema.recordingTranscriptSegments.segmentIndex))
      .limit(limit + 1);
    const segments: RecordingTranscriptSegment[] = rows.slice(0, limit);
    return {
      version: recordingTranscriptVersionView(version),
      speakers: await speakersFor(tx, version),
      segments,
      nextAfter: rows.length > limit ? (segments.at(-1)?.index ?? null) : null,
    };
  });
}

export type UpdateRecordingSpeakersInput = RecordingActor & {
  recordingId: string;
  versionId?: string | undefined;
  assignments?: ReadonlyArray<{
    label: string;
    personId?: string | null | undefined;
    name?: string | null | undefined;
  }>;
  segmentOverrides?: ReadonlyArray<{ segmentIndex: number; label: string }>;
};

/**
 * Name speakers and move segments between them. A label with neither a
 * person nor a name loses its name. Returns the version's speakers.
 */
export async function updateRecordingSpeakers(
  db: Database,
  input: UpdateRecordingSpeakersInput,
): Promise<RecordingSpeaker[]> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    await lockRecording(tx, input.workspaceId, input.recordingId);
    const version = await resolveVersion(tx, input.workspaceId, input.recordingId, input.versionId);
    if (version.state !== "complete") {
      throw new RecordingConflictError("This transcript is not finished", "transcript_not_ready");
    }
    for (const assignment of input.assignments ?? []) {
      const personId = assignment.personId ?? null;
      const name = assignment.name?.trim() || null;
      if (!personId && !name) {
        await tx
          .delete(schema.recordingSpeakerAssignments)
          .where(
            and(
              eq(schema.recordingSpeakerAssignments.versionId, version.id),
              eq(schema.recordingSpeakerAssignments.speakerLabel, assignment.label),
            ),
          );
        continue;
      }
      if (personId) {
        const [person] = await tx
          .select({ id: schema.recordingPeople.id })
          .from(schema.recordingPeople)
          .where(
            and(
              eq(schema.recordingPeople.workspaceId, input.workspaceId),
              eq(schema.recordingPeople.id, personId),
            ),
          );
        if (!person) throw new RecordingNotFoundError("Person not found");
      }
      const values = {
        personId,
        displayName: personId ? null : name,
        source: "confirmed" as const,
        confidence: null,
        assignedBySubjectId: input.subjectId,
        assignedAt: sql`clock_timestamp()`,
      };
      await tx
        .insert(schema.recordingSpeakerAssignments)
        .values({
          accountId: version.accountId,
          workspaceId: input.workspaceId,
          recordingId: input.recordingId,
          versionId: version.id,
          speakerLabel: assignment.label,
          ...values,
        })
        .onConflictDoUpdate({
          target: [
            schema.recordingSpeakerAssignments.versionId,
            schema.recordingSpeakerAssignments.speakerLabel,
          ],
          set: values,
        });
    }
    const overrides = input.segmentOverrides ?? [];
    if (overrides.length > 0) {
      const indexes = overrides.map((override) => override.segmentIndex);
      const existing = await tx
        .select({
          index: schema.recordingTranscriptSegments.segmentIndex,
          label: schema.recordingTranscriptSegments.speakerLabel,
        })
        .from(schema.recordingTranscriptSegments)
        .where(
          and(
            eq(schema.recordingTranscriptSegments.versionId, version.id),
            inArray(schema.recordingTranscriptSegments.segmentIndex, indexes),
          ),
        );
      const originalLabel = new Map(existing.map((segment) => [segment.index, segment.label]));
      for (const override of overrides) {
        if (!originalLabel.has(override.segmentIndex)) {
          throw new RecordingNotFoundError(`Segment ${override.segmentIndex} not found`);
        }
        await writeSegmentEdit(tx, version, input.subjectId, override.segmentIndex, {
          speakerLabel:
            originalLabel.get(override.segmentIndex) === override.label ? null : override.label,
        });
      }
    }
    const speakers = await speakersFor(tx, version);
    const recording = await lockRecording(tx, input.workspaceId, input.recordingId);
    await insertEvent(tx, recording, "recording.speakers.updated", {
      versionId: version.id,
      versionNumber: version.versionNumber,
    });
    return speakers;
  });
}

/**
 * Set one field of a segment's human edit; null clears that field. A row
 * left with neither a label nor text is removed, so the original shows again.
 */
async function writeSegmentEdit(
  tx: Database,
  version: VersionRow,
  subjectId: string,
  segmentIndex: number,
  patch: { speakerLabel?: string | null; text?: string | null },
): Promise<void> {
  const values = {
    ...(patch.speakerLabel !== undefined ? { speakerLabel: patch.speakerLabel } : {}),
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    editedBySubjectId: subjectId,
    editedAt: sql`clock_timestamp()`,
  };
  const [existing] = await tx
    .select()
    .from(schema.recordingSegmentEdits)
    .where(
      and(
        eq(schema.recordingSegmentEdits.versionId, version.id),
        eq(schema.recordingSegmentEdits.segmentIndex, segmentIndex),
      ),
    )
    .for("update");
  const speakerLabel =
    patch.speakerLabel !== undefined ? patch.speakerLabel : (existing?.speakerLabel ?? null);
  const text = patch.text !== undefined ? patch.text : (existing?.text ?? null);
  const where = and(
    eq(schema.recordingSegmentEdits.versionId, version.id),
    eq(schema.recordingSegmentEdits.segmentIndex, segmentIndex),
  );
  if (speakerLabel === null && text === null) {
    if (existing) await tx.delete(schema.recordingSegmentEdits).where(where);
    return;
  }
  if (existing) {
    await tx.update(schema.recordingSegmentEdits).set(values).where(where);
    return;
  }
  await tx.insert(schema.recordingSegmentEdits).values({
    accountId: version.accountId,
    workspaceId: version.workspaceId,
    recordingId: version.recordingId,
    versionId: version.id,
    segmentIndex,
    speakerLabel,
    text,
    editedBySubjectId: subjectId,
  });
}

/**
 * Correct segment text in one version. Setting a segment's text back to its
 * original, or to null, removes the correction.
 */
export async function updateRecordingSegments(
  db: Database,
  input: RecordingActor & {
    recordingId: string;
    versionId?: string | undefined;
    edits: ReadonlyArray<{ segmentIndex: number; text: string | null }>;
  },
): Promise<RecordingTranscriptSegment[]> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    await lockRecording(tx, input.workspaceId, input.recordingId);
    const version = await resolveVersion(tx, input.workspaceId, input.recordingId, input.versionId);
    if (version.state !== "complete") {
      throw new RecordingConflictError("This transcript is not finished", "transcript_not_ready");
    }
    const indexes = [...new Set(input.edits.map((edit) => edit.segmentIndex))];
    const originals = await tx
      .select({
        index: schema.recordingTranscriptSegments.segmentIndex,
        text: schema.recordingTranscriptSegments.text,
      })
      .from(schema.recordingTranscriptSegments)
      .where(
        and(
          eq(schema.recordingTranscriptSegments.versionId, version.id),
          inArray(schema.recordingTranscriptSegments.segmentIndex, indexes),
        ),
      );
    const originalText = new Map(originals.map((segment) => [segment.index, segment.text]));
    for (const edit of input.edits) {
      if (!originalText.has(edit.segmentIndex)) {
        throw new RecordingNotFoundError(`Segment ${edit.segmentIndex} not found`);
      }
      const text = edit.text === null ? null : edit.text.trim();
      await writeSegmentEdit(tx, version, input.subjectId, edit.segmentIndex, {
        text: text === null || text === originalText.get(edit.segmentIndex) ? null : text,
      });
    }
    const rows = await tx
      .select({
        index: schema.recordingTranscriptSegments.segmentIndex,
        startMilliseconds: schema.recordingTranscriptSegments.startMilliseconds,
        endMilliseconds: schema.recordingTranscriptSegments.endMilliseconds,
        trackNumber: schema.recordingTranscriptSegments.trackNumber,
        speakerLabel: sql<
          string | null
        >`coalesce(${schema.recordingSegmentEdits.speakerLabel}, ${schema.recordingTranscriptSegments.speakerLabel})`,
        text: sql<string>`coalesce(${schema.recordingSegmentEdits.text}, ${schema.recordingTranscriptSegments.text})`,
        edited: sql<boolean>`${schema.recordingSegmentEdits.text} IS NOT NULL`,
      })
      .from(schema.recordingTranscriptSegments)
      .leftJoin(
        schema.recordingSegmentEdits,
        and(
          eq(schema.recordingSegmentEdits.versionId, schema.recordingTranscriptSegments.versionId),
          eq(
            schema.recordingSegmentEdits.segmentIndex,
            schema.recordingTranscriptSegments.segmentIndex,
          ),
        ),
      )
      .where(
        and(
          eq(schema.recordingTranscriptSegments.versionId, version.id),
          inArray(schema.recordingTranscriptSegments.segmentIndex, indexes),
        ),
      )
      .orderBy(asc(schema.recordingTranscriptSegments.segmentIndex));
    return rows;
  });
}

/**
 * Make a finished version the one everyone reads. Any member who can see the
 * recording may switch it, as with re-runs.
 */
export async function setCurrentRecordingTranscriptVersion(
  db: Database,
  input: RecordingActor & { recordingId: string; versionId: string },
): Promise<RecordingTranscriptVersion> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const recording = await lockRecording(tx, input.workspaceId, input.recordingId);
    const version = await resolveVersion(tx, input.workspaceId, input.recordingId, input.versionId);
    if (version.state !== "complete") {
      throw new RecordingConflictError("This transcript is not finished", "transcript_not_ready");
    }
    if (version.isCurrent) return recordingTranscriptVersionView(version);
    const [previous] = await tx
      .update(schema.recordingTranscriptVersions)
      .set({ isCurrent: false })
      .where(
        and(
          eq(schema.recordingTranscriptVersions.workspaceId, input.workspaceId),
          eq(schema.recordingTranscriptVersions.recordingId, input.recordingId),
          eq(schema.recordingTranscriptVersions.isCurrent, true),
        ),
      )
      .returning({ id: schema.recordingTranscriptVersions.id });
    const [current] = await tx
      .update(schema.recordingTranscriptVersions)
      .set({ isCurrent: true })
      .where(eq(schema.recordingTranscriptVersions.id, version.id))
      .returning();
    await tx
      .update(schema.recordings)
      .set({ updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(schema.recordings.workspaceId, input.workspaceId),
          eq(schema.recordings.id, input.recordingId),
        ),
      );
    await insertEvent(tx, recording, "recording.transcript.current_changed", {
      versionId: version.id,
      versionNumber: version.versionNumber,
      providerId: version.providerId,
      model: version.model,
      previousVersionId: previous?.id ?? null,
    });
    return recordingTranscriptVersionView(current!);
  });
}

export async function listRecordingPeople(
  db: Database,
  input: RecordingActor & { query?: string | undefined; limit?: number | undefined },
): Promise<RecordingPerson[]> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const conditions = [eq(schema.recordingPeople.workspaceId, input.workspaceId)];
    const query = input.query?.trim();
    if (query) {
      const pattern = `%${query.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;
      conditions.push(sql`${schema.recordingPeople.displayName} ILIKE ${pattern}`);
    }
    const rows = await tx
      .select()
      .from(schema.recordingPeople)
      .where(and(...conditions))
      .orderBy(asc(schema.recordingPeople.displayName), asc(schema.recordingPeople.id))
      .limit(limit);
    return rows.map(personView);
  });
}

/**
 * Add a person to the workspace's speaker directory. A member or an
 * external reference that already has a person returns that person.
 */
export async function createRecordingPerson(
  db: Database,
  input: RecordingActor & {
    accountId: string;
    personId: string;
    displayName: string;
    email?: string | undefined;
    memberSubjectId?: string | undefined;
    externalRef?: string | undefined;
  },
): Promise<{ person: RecordingPerson; created: boolean }> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const inserted = await tx
      .insert(schema.recordingPeople)
      .values({
        id: input.personId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        displayName: input.displayName,
        email: input.email ?? null,
        memberSubjectId: input.memberSubjectId ?? null,
        externalRef: input.externalRef ?? null,
        createdBySubjectId: input.subjectId,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { person: personView(inserted[0]), created: true };
    const matches = [eq(schema.recordingPeople.id, input.personId)];
    if (input.memberSubjectId)
      matches.push(eq(schema.recordingPeople.memberSubjectId, input.memberSubjectId));
    if (input.externalRef) matches.push(eq(schema.recordingPeople.externalRef, input.externalRef));
    const [existing] = await tx
      .select()
      .from(schema.recordingPeople)
      .where(and(eq(schema.recordingPeople.workspaceId, input.workspaceId), or(...matches)))
      .limit(1);
    if (!existing) {
      throw new RecordingConflictError("This person id is already used", "person_id_taken");
    }
    return { person: personView(existing), created: false };
  });
}

/** Work the recovery sweep restarts: a transcript version or a deletion. */
export type StalledRecordingWork = {
  kind: "transcript" | "deletion";
  accountId: string;
  workspaceId: string;
  recordingId: string;
  versionId: string | null;
  ownerSubjectId: string;
};

/**
 * Transcripts and deletions whose workflow may never have started, across
 * every workspace. Identity only; the caller restarts each workflow, which
 * does nothing when it is already running.
 */
export async function listStalledRecordingWork(
  db: Database,
  limit = 50,
): Promise<StalledRecordingWork[]> {
  const rows = await rawRows<{
    kind: "transcript" | "deletion";
    account_id: string;
    workspace_id: string;
    recording_id: string;
    version_id: string | null;
    owner_subject_id: string;
  }>(db, sql`select * from opengeni_private.list_stalled_recording_work_v1(${limit})`);
  return rows.map((row) => ({
    kind: row.kind,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    recordingId: row.recording_id,
    versionId: row.version_id,
    ownerSubjectId: row.owner_subject_id,
  }));
}

import type {
  TranscriptionRecording,
  TranscriptionRecordingErrorCode,
  TranscriptionRecordingResponse,
  TranscriptionRecordingSegment,
} from "@opengeni/contracts";
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "./index";
import { withWorkspaceSubjectRls } from "./index";
import * as schema from "./schema";

type RecordingRow = typeof schema.transcriptionRecordings.$inferSelect;
type ChunkRow = typeof schema.transcriptionRecordingChunks.$inferSelect;
type SegmentRow = typeof schema.transcriptionRecordingSegments.$inferSelect;

export class TranscriptionRecordingNotFoundError extends Error {
  readonly name = "TranscriptionRecordingNotFoundError";
}

export class TranscriptionRecordingConflictError extends Error {
  readonly name = "TranscriptionRecordingConflictError";
}

export class TranscriptionRecordingStateError extends Error {
  readonly name = "TranscriptionRecordingStateError";
}

export type TranscriptionRecordingChunkReservation = {
  recording: TranscriptionRecordingResponse;
  chunk: ChunkRow;
  deduplicated: boolean;
};

export type TranscriptionRecordingAssemblyClaim = {
  recording: TranscriptionRecordingResponse;
  claimed: boolean;
  generation: number;
  owner: string | null;
  staleObjectKeys: string[];
};

export type TranscriptionRecordingSegmentClaim = {
  recording: TranscriptionRecordingResponse;
  claimed: boolean;
  attemptId: string | null;
  segment: SegmentRow | null;
};

export type TranscriptionRecordingObjectCleanupClaim = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  recordingId: string;
  objectKey: string;
  cleanupClaimId: string;
};

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function languages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function segmentFromRow(row: SegmentRow): TranscriptionRecordingSegment {
  return {
    segmentNumber: row.segmentNumber,
    state: row.state,
    startMilliseconds: row.startMilliseconds,
    durationMilliseconds: row.durationMilliseconds,
    byteLength: row.byteLength,
    errorCode: (row.errorCode as TranscriptionRecordingErrorCode | null) ?? null,
    retryable: row.retryable,
  };
}

function recordingFromRow(row: RecordingRow): TranscriptionRecording {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    mimeType: row.mimeType,
    state: row.state,
    nextChunkNumber: row.nextChunkNumber,
    chunkCount: row.chunkCount,
    totalBytes: row.totalBytes,
    totalDurationMilliseconds: row.totalDurationMilliseconds,
    segmentCount: row.segmentCount,
    completedSegmentCount: row.completedSegmentCount,
    transcriptText: row.transcriptText,
    languages: languages(row.languages),
    errorCode: (row.errorCode as TranscriptionRecordingErrorCode | null) ?? null,
    retryable: row.retryable,
    objectsCleaned: row.objectsCleanedAt !== null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    expiresAt: iso(row.expiresAt),
  };
}

async function recordingRow(
  scopedDb: Database,
  workspaceId: string,
  recordingId: string,
  lock = false,
): Promise<RecordingRow | null> {
  let query: any = scopedDb
    .select()
    .from(schema.transcriptionRecordings)
    .where(
      and(
        eq(schema.transcriptionRecordings.workspaceId, workspaceId),
        eq(schema.transcriptionRecordings.id, recordingId),
      ),
    )
    .limit(1);
  if (lock) query = query.for("update");
  const [row] = await query;
  return row ?? null;
}

async function detailForRow(
  scopedDb: Database,
  row: RecordingRow,
): Promise<TranscriptionRecordingResponse> {
  const segmentRows = await scopedDb
    .select()
    .from(schema.transcriptionRecordingSegments)
    .where(
      and(
        eq(schema.transcriptionRecordingSegments.workspaceId, row.workspaceId),
        eq(schema.transcriptionRecordingSegments.recordingId, row.id),
      ),
    )
    .orderBy(asc(schema.transcriptionRecordingSegments.segmentNumber))
    .limit(1_001);
  if (segmentRows.length > 1_000) {
    throw new Error("Transcription recording exceeded the segment projection limit");
  }
  return {
    recording: recordingFromRow(row),
    segments: segmentRows.map(segmentFromRow),
  };
}

async function requiredRecordingRow(
  scopedDb: Database,
  workspaceId: string,
  recordingId: string,
  lock = false,
): Promise<RecordingRow> {
  const row = await recordingRow(scopedDb, workspaceId, recordingId, lock);
  if (!row) throw new TranscriptionRecordingNotFoundError("Recording not found");
  return row;
}

export function transcriptionRecordingChunkObjectKey(input: {
  accountId: string;
  workspaceId: string;
  recordingId: string;
  chunkNumber: number;
  sha256: string;
}): string {
  return [
    "transcription-recordings",
    input.accountId,
    input.workspaceId,
    input.recordingId,
    "chunks",
    `${input.chunkNumber.toString().padStart(8, "0")}-${input.sha256}.bin`,
  ].join("/");
}

export function transcriptionRecordingSegmentObjectKey(input: {
  accountId: string;
  workspaceId: string;
  recordingId: string;
  generation: number;
  segmentNumber: number;
  sha256: string;
}): string {
  return [
    "transcription-recordings",
    input.accountId,
    input.workspaceId,
    input.recordingId,
    "segments",
    input.generation.toString().padStart(8, "0"),
    `${input.segmentNumber.toString().padStart(8, "0")}-${input.sha256}.wav`,
  ].join("/");
}

export async function createTranscriptionRecording(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    recordingId: string;
    mimeType: string;
    expiresAt: Date;
  },
): Promise<TranscriptionRecordingResponse> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    await scopedDb
      .insert(schema.transcriptionRecordings)
      .values({
        id: input.recordingId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        mimeType: input.mimeType,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing();
    const row = await recordingRow(scopedDb, input.workspaceId, input.recordingId);
    if (!row) {
      throw new TranscriptionRecordingConflictError("Recording id is already in use");
    }
    if (row.mimeType !== input.mimeType) {
      throw new TranscriptionRecordingConflictError(
        "Recording id is already bound to different metadata",
      );
    }
    return await detailForRow(scopedDb, row);
  });
}

export async function getTranscriptionRecording(
  db: Database,
  input: { workspaceId: string; subjectId: string; recordingId: string },
): Promise<TranscriptionRecordingResponse> {
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (scopedDb) =>
      await detailForRow(
        scopedDb,
        await requiredRecordingRow(scopedDb, input.workspaceId, input.recordingId),
      ),
  );
}

export async function listTranscriptionRecordings(
  db: Database,
  input: { workspaceId: string; subjectId: string; limit?: number },
): Promise<TranscriptionRecording[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.transcriptionRecordings)
      .where(
        and(
          eq(schema.transcriptionRecordings.workspaceId, input.workspaceId),
          ne(schema.transcriptionRecordings.state, "discarded"),
          gt(schema.transcriptionRecordings.expiresAt, new Date()),
        ),
      )
      .orderBy(
        desc(schema.transcriptionRecordings.createdAt),
        desc(schema.transcriptionRecordings.id),
      )
      .limit(limit);
    return rows.map(recordingFromRow);
  });
}

function sameChunk(
  row: ChunkRow,
  input: {
    byteLength: number;
    sha256: string;
    startMilliseconds: number;
    durationMilliseconds: number;
  },
): boolean {
  return (
    row.byteLength === input.byteLength &&
    row.sha256 === input.sha256 &&
    row.startMilliseconds === input.startMilliseconds &&
    row.durationMilliseconds === input.durationMilliseconds
  );
}

export async function reserveTranscriptionRecordingChunk(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    recordingId: string;
    chunkNumber: number;
    byteLength: number;
    sha256: string;
    startMilliseconds: number;
    durationMilliseconds: number;
    maxTotalBytes: number;
    maxDurationMilliseconds: number;
  },
): Promise<TranscriptionRecordingChunkReservation> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const recording = await requiredRecordingRow(
      scopedDb,
      input.workspaceId,
      input.recordingId,
      true,
    );
    if (recording.state !== "uploading") {
      throw new TranscriptionRecordingStateError("Recording is no longer accepting chunks");
    }
    if (recording.expiresAt.getTime() <= Date.now()) {
      throw new TranscriptionRecordingStateError("Recording has expired");
    }
    const [existing] = await scopedDb
      .select()
      .from(schema.transcriptionRecordingChunks)
      .where(
        and(
          eq(schema.transcriptionRecordingChunks.recordingId, input.recordingId),
          eq(schema.transcriptionRecordingChunks.chunkNumber, input.chunkNumber),
        ),
      )
      .limit(1)
      .for("update");
    if (existing) {
      if (!sameChunk(existing, input)) {
        throw new TranscriptionRecordingConflictError("Chunk metadata or hash conflicts");
      }
      return {
        recording: await detailForRow(scopedDb, recording),
        chunk: existing,
        deduplicated: existing.state === "complete",
      };
    }
    if (input.chunkNumber !== recording.nextChunkNumber) {
      throw new TranscriptionRecordingConflictError(
        `Expected chunk ${recording.nextChunkNumber}, received ${input.chunkNumber}`,
      );
    }
    if (input.startMilliseconds !== recording.totalDurationMilliseconds) {
      throw new TranscriptionRecordingConflictError(
        `Expected chunk start ${recording.totalDurationMilliseconds}, received ${input.startMilliseconds}`,
      );
    }
    if (recording.totalBytes + input.byteLength > input.maxTotalBytes) {
      throw new TranscriptionRecordingStateError("Recording exceeds the byte limit");
    }
    if (
      recording.totalDurationMilliseconds + input.durationMilliseconds >
      input.maxDurationMilliseconds
    ) {
      throw new TranscriptionRecordingStateError("Recording exceeds the duration limit");
    }
    const objectKey = transcriptionRecordingChunkObjectKey(input);
    await scopedDb.insert(schema.transcriptionRecordingObjects).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      recordingId: input.recordingId,
      objectKey,
      kind: "chunk",
      cleanupAfter: recording.expiresAt,
    });
    const [chunk] = await scopedDb
      .insert(schema.transcriptionRecordingChunks)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        recordingId: input.recordingId,
        chunkNumber: input.chunkNumber,
        byteLength: input.byteLength,
        sha256: input.sha256,
        startMilliseconds: input.startMilliseconds,
        durationMilliseconds: input.durationMilliseconds,
        objectKey,
      })
      .returning();
    if (!chunk) throw new Error("Chunk reservation did not return a row");
    return {
      recording: await detailForRow(scopedDb, recording),
      chunk,
      deduplicated: false,
    };
  });
}

export async function completeTranscriptionRecordingChunk(
  db: Database,
  input: { workspaceId: string; subjectId: string; recordingId: string; chunkNumber: number },
): Promise<TranscriptionRecordingChunkReservation> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    let recording = await requiredRecordingRow(
      scopedDb,
      input.workspaceId,
      input.recordingId,
      true,
    );
    const [chunk] = await scopedDb
      .select()
      .from(schema.transcriptionRecordingChunks)
      .where(
        and(
          eq(schema.transcriptionRecordingChunks.recordingId, input.recordingId),
          eq(schema.transcriptionRecordingChunks.chunkNumber, input.chunkNumber),
        ),
      )
      .limit(1)
      .for("update");
    if (!chunk) throw new TranscriptionRecordingNotFoundError("Chunk not found");
    if (chunk.state === "complete") {
      return {
        recording: await detailForRow(scopedDb, recording),
        chunk,
        deduplicated: true,
      };
    }
    if (recording.state !== "uploading" || recording.nextChunkNumber !== input.chunkNumber) {
      throw new TranscriptionRecordingStateError("Chunk completion is no longer current");
    }
    const now = new Date();
    const [completedChunk] = await scopedDb
      .update(schema.transcriptionRecordingChunks)
      .set({ state: "complete", completedAt: now })
      .where(
        and(
          eq(schema.transcriptionRecordingChunks.recordingId, input.recordingId),
          eq(schema.transcriptionRecordingChunks.chunkNumber, input.chunkNumber),
          eq(schema.transcriptionRecordingChunks.state, "uploading"),
        ),
      )
      .returning();
    if (!completedChunk) throw new TranscriptionRecordingStateError("Chunk completion was lost");
    const [updated] = await scopedDb
      .update(schema.transcriptionRecordings)
      .set({
        nextChunkNumber: input.chunkNumber + 1,
        chunkCount: recording.chunkCount + 1,
        totalBytes: recording.totalBytes + chunk.byteLength,
        totalDurationMilliseconds: recording.totalDurationMilliseconds + chunk.durationMilliseconds,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.transcriptionRecordings.id, input.recordingId),
          eq(schema.transcriptionRecordings.nextChunkNumber, input.chunkNumber),
          eq(schema.transcriptionRecordings.state, "uploading"),
        ),
      )
      .returning();
    if (!updated) throw new TranscriptionRecordingStateError("Recording chunk fence was lost");
    recording = updated;
    return {
      recording: await detailForRow(scopedDb, recording),
      chunk: completedChunk,
      deduplicated: false,
    };
  });
}

export async function claimTranscriptionRecordingAssembly(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    recordingId: string;
    owner: string;
    chunkCount: number;
    totalBytes: number;
    totalDurationMilliseconds: number;
    staleBefore: Date;
  },
): Promise<TranscriptionRecordingAssemblyClaim> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    let recording = await requiredRecordingRow(
      scopedDb,
      input.workspaceId,
      input.recordingId,
      true,
    );
    if (recording.state === "discarded") {
      throw new TranscriptionRecordingStateError("Recording was discarded");
    }
    if (recording.expiresAt.getTime() <= Date.now()) {
      throw new TranscriptionRecordingStateError("Recording has expired");
    }
    if (recording.segmentCount > 0 || recording.state === "complete") {
      return {
        recording: await detailForRow(scopedDb, recording),
        claimed: false,
        generation: recording.processingGeneration,
        owner: recording.processingOwner,
        staleObjectKeys: [],
      };
    }
    if (
      recording.state === "segmenting" &&
      recording.processingStartedAt &&
      recording.processingStartedAt >= input.staleBefore
    ) {
      return {
        recording: await detailForRow(scopedDb, recording),
        claimed: false,
        generation: recording.processingGeneration,
        owner: recording.processingOwner,
        staleObjectKeys: [],
      };
    }
    if (recording.state === "failed" && !recording.retryable) {
      return {
        recording: await detailForRow(scopedDb, recording),
        claimed: false,
        generation: recording.processingGeneration,
        owner: null,
        staleObjectKeys: [],
      };
    }
    if (
      recording.chunkCount !== input.chunkCount ||
      recording.nextChunkNumber !== input.chunkCount ||
      recording.totalBytes !== input.totalBytes ||
      recording.totalDurationMilliseconds !== input.totalDurationMilliseconds
    ) {
      throw new TranscriptionRecordingConflictError(
        "Finalization totals do not match upload truth",
      );
    }
    const chunks = await scopedDb
      .select({
        chunkNumber: schema.transcriptionRecordingChunks.chunkNumber,
        state: schema.transcriptionRecordingChunks.state,
      })
      .from(schema.transcriptionRecordingChunks)
      .where(eq(schema.transcriptionRecordingChunks.recordingId, input.recordingId))
      .orderBy(asc(schema.transcriptionRecordingChunks.chunkNumber));
    if (
      chunks.length !== input.chunkCount ||
      chunks.some((chunk, index) => chunk.chunkNumber !== index || chunk.state !== "complete")
    ) {
      throw new TranscriptionRecordingConflictError("Recording chunks are incomplete");
    }
    const staleSegments = await scopedDb
      .delete(schema.transcriptionRecordingSegments)
      .where(eq(schema.transcriptionRecordingSegments.recordingId, input.recordingId))
      .returning({ objectKey: schema.transcriptionRecordingSegments.objectKey });
    if (staleSegments.length > 0) {
      await scopedDb
        .update(schema.transcriptionRecordingObjects)
        .set({ cleanupAfter: new Date() })
        .where(
          inArray(
            schema.transcriptionRecordingObjects.objectKey,
            staleSegments.map((entry) => entry.objectKey),
          ),
        );
    }
    const generation = recording.processingGeneration + 1;
    const now = new Date();
    const [updated] = await scopedDb
      .update(schema.transcriptionRecordings)
      .set({
        state: "segmenting",
        processingGeneration: generation,
        processingOwner: input.owner,
        processingStartedAt: now,
        segmentCount: 0,
        completedSegmentCount: 0,
        transcriptText: null,
        languages: [],
        errorCode: null,
        retryable: false,
        objectsCleanedAt: null,
        updatedAt: now,
      })
      .where(eq(schema.transcriptionRecordings.id, input.recordingId))
      .returning();
    if (!updated) throw new TranscriptionRecordingStateError("Assembly claim was lost");
    recording = updated;
    return {
      recording: await detailForRow(scopedDb, recording),
      claimed: true,
      generation,
      owner: input.owner,
      staleObjectKeys: staleSegments.map((entry) => entry.objectKey),
    };
  });
}

export async function listTranscriptionRecordingChunks(
  db: Database,
  input: { workspaceId: string; subjectId: string; recordingId: string },
): Promise<ChunkRow[]> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    await requiredRecordingRow(scopedDb, input.workspaceId, input.recordingId);
    return await scopedDb
      .select()
      .from(schema.transcriptionRecordingChunks)
      .where(eq(schema.transcriptionRecordingChunks.recordingId, input.recordingId))
      .orderBy(asc(schema.transcriptionRecordingChunks.chunkNumber));
  });
}

export async function reserveTranscriptionRecordingSegment(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    recordingId: string;
    owner: string;
    generation: number;
    segmentNumber: number;
    byteLength: number;
    sha256: string;
    startMilliseconds: number;
    durationMilliseconds: number;
  },
): Promise<SegmentRow> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const recording = await requiredRecordingRow(
      scopedDb,
      input.workspaceId,
      input.recordingId,
      true,
    );
    if (
      recording.state !== "segmenting" ||
      recording.processingGeneration !== input.generation ||
      recording.processingOwner !== input.owner
    ) {
      throw new TranscriptionRecordingStateError("Assembly generation is no longer current");
    }
    const rows = await scopedDb
      .select({ segmentNumber: schema.transcriptionRecordingSegments.segmentNumber })
      .from(schema.transcriptionRecordingSegments)
      .where(eq(schema.transcriptionRecordingSegments.recordingId, input.recordingId))
      .orderBy(asc(schema.transcriptionRecordingSegments.segmentNumber));
    if (
      rows.length !== input.segmentNumber ||
      rows.some((row, index) => row.segmentNumber !== index)
    ) {
      throw new TranscriptionRecordingConflictError("Segment sequence is not contiguous");
    }
    const objectKey = transcriptionRecordingSegmentObjectKey(input);
    await scopedDb.insert(schema.transcriptionRecordingObjects).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      recordingId: input.recordingId,
      objectKey,
      kind: "segment",
      cleanupAfter: recording.expiresAt,
    });
    const [segment] = await scopedDb
      .insert(schema.transcriptionRecordingSegments)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        recordingId: input.recordingId,
        segmentNumber: input.segmentNumber,
        generation: input.generation,
        byteLength: input.byteLength,
        sha256: input.sha256,
        startMilliseconds: input.startMilliseconds,
        durationMilliseconds: input.durationMilliseconds,
        objectKey,
      })
      .returning();
    if (!segment) throw new Error("Segment reservation did not return a row");
    return segment;
  });
}

export async function completeTranscriptionRecordingSegmentPreparation(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    recordingId: string;
    owner: string;
    generation: number;
    segmentNumber: number;
  },
): Promise<void> {
  await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const recording = await requiredRecordingRow(
      scopedDb,
      input.workspaceId,
      input.recordingId,
      true,
    );
    if (
      recording.state !== "segmenting" ||
      recording.processingGeneration !== input.generation ||
      recording.processingOwner !== input.owner
    ) {
      throw new TranscriptionRecordingStateError("Assembly generation is no longer current");
    }
    const [updated] = await scopedDb
      .update(schema.transcriptionRecordingSegments)
      .set({ state: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(schema.transcriptionRecordingSegments.recordingId, input.recordingId),
          eq(schema.transcriptionRecordingSegments.segmentNumber, input.segmentNumber),
          eq(schema.transcriptionRecordingSegments.generation, input.generation),
          eq(schema.transcriptionRecordingSegments.state, "preparing"),
        ),
      )
      .returning({ segmentNumber: schema.transcriptionRecordingSegments.segmentNumber });
    if (!updated) throw new TranscriptionRecordingStateError("Segment preparation was lost");
  });
}

export async function completeTranscriptionRecordingAssembly(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    recordingId: string;
    owner: string;
    generation: number;
  },
): Promise<TranscriptionRecordingResponse> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const recording = await requiredRecordingRow(
      scopedDb,
      input.workspaceId,
      input.recordingId,
      true,
    );
    if (
      recording.state !== "segmenting" ||
      recording.processingGeneration !== input.generation ||
      recording.processingOwner !== input.owner
    ) {
      throw new TranscriptionRecordingStateError("Assembly generation is no longer current");
    }
    const segments = await scopedDb
      .select()
      .from(schema.transcriptionRecordingSegments)
      .where(eq(schema.transcriptionRecordingSegments.recordingId, input.recordingId))
      .orderBy(asc(schema.transcriptionRecordingSegments.segmentNumber));
    if (
      segments.length === 0 ||
      segments.some(
        (segment, index) =>
          segment.segmentNumber !== index ||
          segment.generation !== input.generation ||
          segment.state !== "pending",
      )
    ) {
      throw new TranscriptionRecordingStateError("Prepared segments are incomplete");
    }
    const [updated] = await scopedDb
      .update(schema.transcriptionRecordings)
      .set({
        state: "ready",
        segmentCount: segments.length,
        completedSegmentCount: 0,
        processingOwner: null,
        processingStartedAt: null,
        errorCode: null,
        retryable: false,
        updatedAt: new Date(),
      })
      .where(eq(schema.transcriptionRecordings.id, input.recordingId))
      .returning();
    if (!updated) throw new TranscriptionRecordingStateError("Assembly completion was lost");
    return await detailForRow(scopedDb, updated);
  });
}

export async function failTranscriptionRecordingAssembly(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    recordingId: string;
    owner: string;
    generation: number;
    errorCode: TranscriptionRecordingErrorCode;
    retryable: boolean;
  },
): Promise<TranscriptionRecordingResponse> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [updated] = await scopedDb
      .update(schema.transcriptionRecordings)
      .set({
        state: "failed",
        errorCode: input.errorCode,
        retryable: input.retryable,
        processingOwner: null,
        processingStartedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.transcriptionRecordings.id, input.recordingId),
          eq(schema.transcriptionRecordings.workspaceId, input.workspaceId),
          eq(schema.transcriptionRecordings.state, "segmenting"),
          eq(schema.transcriptionRecordings.processingGeneration, input.generation),
          eq(schema.transcriptionRecordings.processingOwner, input.owner),
        ),
      )
      .returning();
    if (!updated) throw new TranscriptionRecordingStateError("Assembly failure was stale");
    if (!input.retryable) {
      await scopedDb
        .update(schema.transcriptionRecordingObjects)
        .set({ cleanupAfter: new Date() })
        .where(eq(schema.transcriptionRecordingObjects.recordingId, input.recordingId));
    }
    return await detailForRow(scopedDb, updated);
  });
}

export async function claimNextTranscriptionRecordingSegment(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    recordingId: string;
    attemptId: string;
    providerId: string;
    staleBefore: Date;
  },
): Promise<TranscriptionRecordingSegmentClaim> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    let recording = await requiredRecordingRow(
      scopedDb,
      input.workspaceId,
      input.recordingId,
      true,
    );
    if (recording.state === "complete" || recording.state === "discarded") {
      return {
        recording: await detailForRow(scopedDb, recording),
        claimed: false,
        attemptId: null,
        segment: null,
      };
    }
    if (recording.segmentCount === 0 || recording.state === "uploading") {
      throw new TranscriptionRecordingStateError("Recording has not been finalized");
    }
    if (recording.expiresAt.getTime() <= Date.now()) {
      throw new TranscriptionRecordingStateError("Recording has expired");
    }
    const [active] = await scopedDb
      .select()
      .from(schema.transcriptionRecordingSegments)
      .where(
        and(
          eq(schema.transcriptionRecordingSegments.recordingId, input.recordingId),
          eq(schema.transcriptionRecordingSegments.state, "transcribing"),
        ),
      )
      .orderBy(asc(schema.transcriptionRecordingSegments.segmentNumber))
      .limit(1)
      .for("update");
    if (active?.attemptStartedAt && active.attemptStartedAt >= input.staleBefore) {
      return {
        recording: await detailForRow(scopedDb, recording),
        claimed: false,
        attemptId: active.attemptId,
        segment: active,
      };
    }
    if (active) {
      await scopedDb
        .update(schema.transcriptionRecordingSegments)
        .set({
          state: "failed",
          attemptId: null,
          attemptStartedAt: null,
          errorCode: "timeout",
          retryable: true,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.transcriptionRecordingSegments.recordingId, input.recordingId),
            eq(schema.transcriptionRecordingSegments.segmentNumber, active.segmentNumber),
            eq(schema.transcriptionRecordingSegments.attemptId, active.attemptId!),
          ),
        );
    }
    const [candidate] = await scopedDb
      .select()
      .from(schema.transcriptionRecordingSegments)
      .where(
        and(
          eq(schema.transcriptionRecordingSegments.recordingId, input.recordingId),
          or(
            eq(schema.transcriptionRecordingSegments.state, "pending"),
            and(
              eq(schema.transcriptionRecordingSegments.state, "failed"),
              eq(schema.transcriptionRecordingSegments.retryable, true),
            ),
          ),
        ),
      )
      .orderBy(asc(schema.transcriptionRecordingSegments.segmentNumber))
      .limit(1)
      .for("update");
    if (!candidate) {
      return {
        recording: await detailForRow(scopedDb, recording),
        claimed: false,
        attemptId: null,
        segment: null,
      };
    }
    const providerId = recording.providerId ?? candidate.providerId ?? input.providerId;
    if (
      recording.providerId &&
      candidate.providerId &&
      recording.providerId !== candidate.providerId
    ) {
      throw new TranscriptionRecordingStateError("Recording provider pin is inconsistent");
    }
    const now = new Date();
    const [claimed] = await scopedDb
      .update(schema.transcriptionRecordingSegments)
      .set({
        state: "transcribing",
        attemptId: input.attemptId,
        attemptStartedAt: now,
        errorCode: null,
        retryable: false,
        providerId,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.transcriptionRecordingSegments.recordingId, input.recordingId),
          eq(schema.transcriptionRecordingSegments.segmentNumber, candidate.segmentNumber),
          eq(schema.transcriptionRecordingSegments.state, candidate.state),
        ),
      )
      .returning();
    if (!claimed) throw new TranscriptionRecordingStateError("Segment claim was lost");
    const [updatedRecording] = await scopedDb
      .update(schema.transcriptionRecordings)
      .set({
        state: "transcribing",
        processingOwner: input.attemptId,
        processingStartedAt: now,
        providerId,
        errorCode: null,
        retryable: false,
        updatedAt: now,
      })
      .where(eq(schema.transcriptionRecordings.id, input.recordingId))
      .returning();
    if (!updatedRecording) throw new TranscriptionRecordingStateError("Recording claim was lost");
    recording = updatedRecording;
    return {
      recording: await detailForRow(scopedDb, recording),
      claimed: true,
      attemptId: input.attemptId,
      segment: claimed,
    };
  });
}

export function assembleTranscriptionSegments(
  segments: readonly Pick<SegmentRow, "segmentNumber" | "transcriptText" | "languages">[],
): { text: string; languages: string[] } {
  const ordered = [...segments].sort((left, right) => left.segmentNumber - right.segmentNumber);
  const text = ordered
    .map((segment) => segment.transcriptText?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
  const seen = new Set<string>();
  const combinedLanguages: string[] = [];
  for (const segment of ordered) {
    for (const language of languages(segment.languages)) {
      const normalized = language.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      combinedLanguages.push(normalized);
    }
  }
  return { text, languages: combinedLanguages };
}

export async function completeTranscriptionRecordingSegment(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    recordingId: string;
    segmentNumber: number;
    attemptId: string;
    text: string;
    languages: string[];
    providerId: string;
  },
): Promise<TranscriptionRecordingResponse> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const recording = await requiredRecordingRow(
      scopedDb,
      input.workspaceId,
      input.recordingId,
      true,
    );
    if (recording.state !== "transcribing" || recording.processingOwner !== input.attemptId) {
      throw new TranscriptionRecordingStateError("Segment completion was stale");
    }
    const now = new Date();
    const [completed] = await scopedDb
      .update(schema.transcriptionRecordingSegments)
      .set({
        state: "complete",
        attemptId: null,
        attemptStartedAt: null,
        transcriptText: input.text,
        languages: input.languages,
        providerId: input.providerId,
        errorCode: null,
        retryable: false,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.transcriptionRecordingSegments.recordingId, input.recordingId),
          eq(schema.transcriptionRecordingSegments.segmentNumber, input.segmentNumber),
          eq(schema.transcriptionRecordingSegments.state, "transcribing"),
          eq(schema.transcriptionRecordingSegments.attemptId, input.attemptId),
        ),
      )
      .returning();
    if (!completed) throw new TranscriptionRecordingStateError("Segment completion was stale");
    const segments = await scopedDb
      .select()
      .from(schema.transcriptionRecordingSegments)
      .where(eq(schema.transcriptionRecordingSegments.recordingId, input.recordingId))
      .orderBy(asc(schema.transcriptionRecordingSegments.segmentNumber));
    const completedCount = segments.filter((segment) => segment.state === "complete").length;
    const allComplete = completedCount === segments.length && segments.length > 0;
    const assembled = allComplete ? assembleTranscriptionSegments(segments) : null;
    const [updated] = await scopedDb
      .update(schema.transcriptionRecordings)
      .set({
        state: allComplete ? "complete" : "ready",
        completedSegmentCount: completedCount,
        transcriptText: assembled?.text ?? null,
        languages: assembled?.languages ?? [],
        processingOwner: null,
        processingStartedAt: null,
        errorCode: null,
        retryable: false,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.transcriptionRecordings.id, input.recordingId),
          eq(schema.transcriptionRecordings.processingOwner, input.attemptId),
        ),
      )
      .returning();
    if (!updated) throw new TranscriptionRecordingStateError("Recording completion was stale");
    if (allComplete) {
      await scopedDb
        .update(schema.transcriptionRecordingObjects)
        .set({ cleanupAfter: now })
        .where(eq(schema.transcriptionRecordingObjects.recordingId, input.recordingId));
    }
    return await detailForRow(scopedDb, updated);
  });
}

export async function failTranscriptionRecordingSegment(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    recordingId: string;
    segmentNumber: number;
    attemptId: string;
    errorCode: TranscriptionRecordingErrorCode;
    retryable: boolean;
  },
): Promise<TranscriptionRecordingResponse> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const recording = await requiredRecordingRow(
      scopedDb,
      input.workspaceId,
      input.recordingId,
      true,
    );
    if (recording.state !== "transcribing" || recording.processingOwner !== input.attemptId) {
      throw new TranscriptionRecordingStateError("Segment failure was stale");
    }
    const now = new Date();
    const [failed] = await scopedDb
      .update(schema.transcriptionRecordingSegments)
      .set({
        state: "failed",
        attemptId: null,
        attemptStartedAt: null,
        errorCode: input.errorCode,
        retryable: input.retryable,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.transcriptionRecordingSegments.recordingId, input.recordingId),
          eq(schema.transcriptionRecordingSegments.segmentNumber, input.segmentNumber),
          eq(schema.transcriptionRecordingSegments.state, "transcribing"),
          eq(schema.transcriptionRecordingSegments.attemptId, input.attemptId),
        ),
      )
      .returning();
    if (!failed) throw new TranscriptionRecordingStateError("Segment failure was stale");
    const [updated] = await scopedDb
      .update(schema.transcriptionRecordings)
      .set({
        state: "failed",
        processingOwner: null,
        processingStartedAt: null,
        errorCode: input.errorCode,
        retryable: input.retryable,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.transcriptionRecordings.id, input.recordingId),
          eq(schema.transcriptionRecordings.processingOwner, input.attemptId),
        ),
      )
      .returning();
    if (!updated) throw new TranscriptionRecordingStateError("Recording failure was stale");
    if (!input.retryable) {
      await scopedDb
        .update(schema.transcriptionRecordingObjects)
        .set({ cleanupAfter: now })
        .where(eq(schema.transcriptionRecordingObjects.recordingId, input.recordingId));
    }
    return await detailForRow(scopedDb, updated);
  });
}

export async function transcriptionRecordingObjectKeys(
  db: Database,
  input: { workspaceId: string; subjectId: string; recordingId: string },
): Promise<string[]> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    await requiredRecordingRow(scopedDb, input.workspaceId, input.recordingId);
    const objects = await scopedDb
      .select({ objectKey: schema.transcriptionRecordingObjects.objectKey })
      .from(schema.transcriptionRecordingObjects)
      .where(
        and(
          eq(schema.transcriptionRecordingObjects.recordingId, input.recordingId),
          isNull(schema.transcriptionRecordingObjects.cleanedAt),
        ),
      )
      .orderBy(asc(schema.transcriptionRecordingObjects.objectKey));
    return objects.map((entry) => entry.objectKey);
  });
}

async function settleTranscriptionRecordingObjectsCleaned(
  scopedDb: Database,
  recording: RecordingRow,
): Promise<RecordingRow> {
  const [remaining] = await scopedDb
    .select({ objectKey: schema.transcriptionRecordingObjects.objectKey })
    .from(schema.transcriptionRecordingObjects)
    .where(
      and(
        eq(schema.transcriptionRecordingObjects.recordingId, recording.id),
        isNull(schema.transcriptionRecordingObjects.cleanedAt),
      ),
    )
    .limit(1);
  if (remaining) return recording;
  const expired = recording.expiresAt.getTime() <= Date.now();
  const terminal =
    recording.state === "complete" ||
    recording.state === "discarded" ||
    (recording.state === "failed" && !recording.retryable);
  if (!expired && !terminal) return recording;
  const now = new Date();
  const [updated] = await scopedDb
    .update(schema.transcriptionRecordings)
    .set({
      ...(expired
        ? {
            state: "discarded" as const,
            processingOwner: null,
            processingStartedAt: null,
            errorCode: null,
            retryable: false,
          }
        : {}),
      objectsCleanedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.transcriptionRecordings.id, recording.id))
    .returning();
  if (!updated) throw new TranscriptionRecordingStateError("Object cleanup settlement was lost");
  return updated;
}

export async function markTranscriptionRecordingObjectCleaned(
  db: Database,
  input: { workspaceId: string; subjectId: string; recordingId: string; objectKey: string },
): Promise<TranscriptionRecordingResponse> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    let recording = await requiredRecordingRow(
      scopedDb,
      input.workspaceId,
      input.recordingId,
      true,
    );
    const [object] = await scopedDb
      .select()
      .from(schema.transcriptionRecordingObjects)
      .where(
        and(
          eq(schema.transcriptionRecordingObjects.recordingId, input.recordingId),
          eq(schema.transcriptionRecordingObjects.objectKey, input.objectKey),
        ),
      )
      .limit(1)
      .for("update");
    if (!object) throw new TranscriptionRecordingNotFoundError("Recording object not found");
    if (!object.cleanedAt) {
      const now = new Date();
      const [updated] = await scopedDb
        .update(schema.transcriptionRecordingObjects)
        .set({
          cleanupClaimId: null,
          cleanupClaimedAt: null,
          cleanedAt: now,
        })
        .where(eq(schema.transcriptionRecordingObjects.objectKey, input.objectKey))
        .returning({ objectKey: schema.transcriptionRecordingObjects.objectKey });
      if (!updated) throw new TranscriptionRecordingStateError("Object cleanup was lost");
    }
    recording = await settleTranscriptionRecordingObjectsCleaned(scopedDb, recording);
    return await detailForRow(scopedDb, recording);
  });
}

export async function markTranscriptionRecordingObjectsCleaned(
  db: Database,
  input: { workspaceId: string; subjectId: string; recordingId: string },
): Promise<TranscriptionRecordingResponse> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    let recording = await requiredRecordingRow(
      scopedDb,
      input.workspaceId,
      input.recordingId,
      true,
    );
    const [remaining] = await scopedDb
      .select({ objectKey: schema.transcriptionRecordingObjects.objectKey })
      .from(schema.transcriptionRecordingObjects)
      .where(
        and(
          eq(schema.transcriptionRecordingObjects.recordingId, input.recordingId),
          isNull(schema.transcriptionRecordingObjects.cleanedAt),
        ),
      )
      .limit(1);
    if (remaining) {
      throw new TranscriptionRecordingStateError("Recording objects are not cleaned");
    }
    recording = await settleTranscriptionRecordingObjectsCleaned(scopedDb, recording);
    if (!recording.objectsCleanedAt) {
      throw new TranscriptionRecordingStateError("Recording is not terminal");
    }
    return await detailForRow(scopedDb, recording);
  });
}

export async function discardTranscriptionRecording(
  db: Database,
  input: { workspaceId: string; subjectId: string; recordingId: string },
): Promise<TranscriptionRecordingResponse> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const row = await requiredRecordingRow(scopedDb, input.workspaceId, input.recordingId, true);
    if (row.state === "discarded") return await detailForRow(scopedDb, row);
    const [updated] = await scopedDb
      .update(schema.transcriptionRecordings)
      .set({
        state: "discarded",
        processingOwner: null,
        processingStartedAt: null,
        errorCode: null,
        retryable: false,
        updatedAt: new Date(),
      })
      .where(eq(schema.transcriptionRecordings.id, input.recordingId))
      .returning();
    if (!updated) throw new TranscriptionRecordingStateError("Discard was lost");
    await scopedDb
      .update(schema.transcriptionRecordingObjects)
      .set({ cleanupAfter: new Date() })
      .where(eq(schema.transcriptionRecordingObjects.recordingId, input.recordingId));
    return await detailForRow(scopedDb, updated);
  });
}

export async function claimDueTranscriptionRecordingObjectCleanup(
  db: Database,
  input: { graceMs: number; claimTimeoutMs: number; limit: number },
): Promise<TranscriptionRecordingObjectCleanupClaim[]> {
  if (
    !Number.isSafeInteger(input.graceMs) ||
    input.graceMs < 0 ||
    !Number.isSafeInteger(input.claimTimeoutMs) ||
    input.claimTimeoutMs < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0
  ) {
    throw new Error("Invalid transcription recording cleanup claim bounds");
  }
  type ClaimRow = {
    account_id: string;
    workspace_id: string;
    subject_id: string;
    recording_id: string;
    object_key: string;
    cleanup_claim_id: string;
  };
  const rows = await db.execute<ClaimRow>(sql`
    select account_id, workspace_id, subject_id, recording_id, object_key, cleanup_claim_id
    from opengeni_private.claim_due_transcription_recording_object_cleanup(
      ${input.graceMs},
      ${input.claimTimeoutMs},
      ${input.limit}
    )
  `);
  return rows.map((row: ClaimRow) => ({
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    subjectId: row.subject_id,
    recordingId: row.recording_id,
    objectKey: row.object_key,
    cleanupClaimId: row.cleanup_claim_id,
  }));
}

export async function completeDueTranscriptionRecordingObjectCleanup(
  db: Database,
  input: TranscriptionRecordingObjectCleanupClaim,
): Promise<boolean> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    let recording = await requiredRecordingRow(
      scopedDb,
      input.workspaceId,
      input.recordingId,
      true,
    );
    const [object] = await scopedDb
      .select()
      .from(schema.transcriptionRecordingObjects)
      .where(
        and(
          eq(schema.transcriptionRecordingObjects.recordingId, input.recordingId),
          eq(schema.transcriptionRecordingObjects.objectKey, input.objectKey),
        ),
      )
      .limit(1)
      .for("update");
    if (!object) return false;
    if (object.cleanedAt) return true;
    if (object.cleanupClaimId !== input.cleanupClaimId) return false;
    const now = new Date();
    const [updated] = await scopedDb
      .update(schema.transcriptionRecordingObjects)
      .set({ cleanupClaimId: null, cleanupClaimedAt: null, cleanedAt: now })
      .where(
        and(
          eq(schema.transcriptionRecordingObjects.objectKey, input.objectKey),
          eq(schema.transcriptionRecordingObjects.cleanupClaimId, input.cleanupClaimId),
        ),
      )
      .returning({ objectKey: schema.transcriptionRecordingObjects.objectKey });
    if (!updated) return false;
    recording = await settleTranscriptionRecordingObjectsCleaned(scopedDb, recording);
    return Boolean(recording.objectsCleanedAt || object.cleanedAt || updated);
  });
}

export async function purgeExpiredTranscriptionRecordings(
  db: Database,
  input: { graceMs: number; limit: number },
): Promise<number> {
  if (
    !Number.isSafeInteger(input.graceMs) ||
    input.graceMs < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0
  ) {
    throw new Error("Invalid transcription recording purge bounds");
  }
  type PurgeRow = { purged_count: number };
  const [row] = await db.execute<PurgeRow>(sql`
    select opengeni_private.purge_expired_transcription_recordings(
      ${input.graceMs},
      ${input.limit}
    ) as purged_count
  `);
  return Number(row?.purged_count ?? 0);
}

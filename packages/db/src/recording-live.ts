import type { RecordingLiveSegment } from "@opengeni/contracts";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { withWorkspaceSubjectRls, type Database } from "./database";
import {
  RecordingConflictError,
  RecordingForbiddenError,
  RecordingNotFoundError,
  type RecordingActor,
} from "./recordings";
import * as schema from "./schema";

/**
 * The live transcript preview. While a recording is captured, its recorder
 * streams each track to a live speech model and saves the finished stretches
 * of text here, so every device viewing the meeting can follow along. The
 * preview ends when the first transcript is ready, which removes the text.
 */

type RecordingRow = typeof schema.recordings.$inferSelect;

async function lockOwnRecording(
  tx: Database,
  input: RecordingActor & { recordingId: string },
): Promise<RecordingRow> {
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
  if (!row || row.state === "deleting") throw new RecordingNotFoundError();
  if (row.ownerSubjectId !== input.subjectId) throw new RecordingForbiddenError();
  return row;
}

function trackWhere(input: { workspaceId: string; recordingId: string; trackNumber: number }) {
  return and(
    eq(schema.recordingTracks.workspaceId, input.workspaceId),
    eq(schema.recordingTracks.recordingId, input.recordingId),
    eq(schema.recordingTracks.trackNumber, input.trackNumber),
  );
}

/**
 * Note that a track streams to a live model. Only the person recording may,
 * and only while the recording is being captured.
 */
export async function startRecordingLiveTrack(
  db: Database,
  input: RecordingActor & {
    recordingId: string;
    trackNumber: number;
    providerId: string;
    model: string;
  },
): Promise<{ language: string | null }> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const recording = await lockOwnRecording(tx, input);
    if (recording.purpose !== "meeting") {
      throw new RecordingConflictError("Only a meeting has a live transcript", "not_a_meeting");
    }
    if (recording.state !== "capturing") {
      throw new RecordingConflictError(
        "A live transcript can only start while recording",
        "not_capturing",
      );
    }
    const [track] = await tx
      .update(schema.recordingTracks)
      .set({ liveProviderId: input.providerId, liveModel: input.model })
      .where(trackWhere(input))
      .returning({ trackNumber: schema.recordingTracks.trackNumber });
    if (!track) throw new RecordingNotFoundError("Track not found");
    const language = (recording.transcription as { language?: unknown }).language;
    return { language: typeof language === "string" ? language : null };
  });
}

export type AppendRecordingLiveSegmentsInput = RecordingActor & {
  recordingId: string;
  trackNumber: number;
  /** All audio streamed for this track so far; the stored total never shrinks. */
  streamedMilliseconds: number;
  /** Estimated cost of `streamedMilliseconds` at the live model's list price. */
  costUsdMicros: number | null;
  segments: ReadonlyArray<{
    segmentNumber: number;
    startMilliseconds: number;
    endMilliseconds: number;
    text: string;
  }>;
};

/**
 * Save finished live text. A segment number already saved keeps its first
 * copy. Once a transcript is ready the preview is over and nothing is saved.
 */
export async function appendRecordingLiveSegments(
  db: Database,
  input: AppendRecordingLiveSegmentsInput,
): Promise<{ saved: number; ended: boolean }> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const recording = await lockOwnRecording(tx, input);
    if (recording.state !== "capturing" && recording.state !== "processing") {
      return { saved: 0, ended: recording.state === "ready" };
    }
    const [track] = await tx
      .update(schema.recordingTracks)
      .set({
        liveStreamedMilliseconds: sql`greatest(${schema.recordingTracks.liveStreamedMilliseconds}, ${input.streamedMilliseconds})`,
        liveCostUsdMicros: sql`case when ${input.streamedMilliseconds} >= ${schema.recordingTracks.liveStreamedMilliseconds} then ${input.costUsdMicros}::bigint else ${schema.recordingTracks.liveCostUsdMicros} end`,
      })
      .where(and(trackWhere(input), sql`${schema.recordingTracks.liveModel} is not null`))
      .returning({ trackNumber: schema.recordingTracks.trackNumber });
    if (!track) {
      throw new RecordingConflictError(
        "This track has no live transcript; start a live session first",
        "no_live_session",
      );
    }
    if (input.segments.length === 0) return { saved: 0, ended: false };
    const saved = await tx
      .insert(schema.recordingLiveSegments)
      .values(
        input.segments.map((segment) => ({
          accountId: recording.accountId,
          workspaceId: input.workspaceId,
          recordingId: input.recordingId,
          trackNumber: input.trackNumber,
          segmentNumber: segment.segmentNumber,
          startMilliseconds: segment.startMilliseconds,
          endMilliseconds: segment.endMilliseconds,
          text: segment.text,
        })),
      )
      .onConflictDoNothing()
      .returning({ segmentNumber: schema.recordingLiveSegments.segmentNumber });
    return { saved: saved.length, ended: false };
  });
}

/** Live text saved after `after`, oldest first, for anyone who can see the recording. */
export async function listRecordingLiveSegments(
  db: Database,
  input: RecordingActor & { recordingId: string; after?: number | undefined; limit?: number },
): Promise<{ segments: RecordingLiveSegment[]; after: number; ended: boolean }> {
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 1_000);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [recording] = await tx
      .select({ state: schema.recordings.state })
      .from(schema.recordings)
      .where(
        and(
          eq(schema.recordings.workspaceId, input.workspaceId),
          eq(schema.recordings.id, input.recordingId),
        ),
      );
    if (!recording || recording.state === "deleting") throw new RecordingNotFoundError();
    const after = Math.max(0, input.after ?? 0);
    const rows = await tx
      .select()
      .from(schema.recordingLiveSegments)
      .where(
        and(
          eq(schema.recordingLiveSegments.workspaceId, input.workspaceId),
          eq(schema.recordingLiveSegments.recordingId, input.recordingId),
          gt(schema.recordingLiveSegments.sequence, after),
        ),
      )
      .orderBy(asc(schema.recordingLiveSegments.sequence))
      .limit(limit);
    return {
      segments: rows.map((row) => ({
        trackNumber: row.trackNumber,
        segmentNumber: row.segmentNumber,
        startMilliseconds: row.startMilliseconds,
        endMilliseconds: row.endMilliseconds,
        text: row.text,
        sequence: row.sequence,
      })),
      after: rows.at(-1)?.sequence ?? after,
      ended: recording.state === "ready",
    };
  });
}

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
  /**
   * How the track's live model is paid, asked under the recording lock with
   * the model the track streams to: whether its audio is charged in credits,
   * and otherwise the estimated cost of `streamedMilliseconds` at its list
   * price (which counts toward a usage allowance that prices unbilled use).
   * Audio charged in credits stores no list-price cost, so it never counts
   * against an allowance twice.
   */
  pricing: (live: RecordingLiveModel) => {
    chargedInCredits: boolean;
    costUsdMicros: number | null;
  };
  segments: ReadonlyArray<{
    segmentNumber: number;
    startMilliseconds: number;
    endMilliseconds: number;
    text: string;
  }>;
};

export type RecordingLiveModel = { providerId: string; model: string };

export type AppendRecordingLiveSegmentsResult = {
  saved: number;
  ended: boolean;
  /** The model the track streams to, read under the lock; null once the preview ended. */
  live: RecordingLiveModel | null;
  /** How far this call moved the track's stored streamed total. */
  addedMilliseconds: number;
  /**
   * The streamed audio not yet charged, from the track's charged mark to its
   * stored total, when it is charged in credits. Charge it, then move the
   * mark with {@link markRecordingLiveCharged}; until then every save
   * returns it again (grown by what streamed since).
   */
  charge: { fromMilliseconds: number; toMilliseconds: number } | null;
};

/**
 * Save finished live text. A segment number already saved keeps its first
 * copy. Once a transcript is ready the preview is over and nothing is saved.
 * The recording row lock orders a recording's appends, so the stored total
 * only grows and `addedMilliseconds` counts each millisecond once however
 * often a client retries.
 */
export async function appendRecordingLiveSegments(
  db: Database,
  input: AppendRecordingLiveSegmentsInput,
): Promise<AppendRecordingLiveSegmentsResult> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const recording = await lockOwnRecording(tx, input);
    if (recording.state !== "capturing" && recording.state !== "processing") {
      return {
        saved: 0,
        ended: recording.state === "ready",
        live: null,
        addedMilliseconds: 0,
        charge: null,
      };
    }
    const [before] = await tx
      .select({
        providerId: schema.recordingTracks.liveProviderId,
        model: schema.recordingTracks.liveModel,
        streamed: schema.recordingTracks.liveStreamedMilliseconds,
        charged: schema.recordingTracks.liveChargedMilliseconds,
      })
      .from(schema.recordingTracks)
      .where(trackWhere(input))
      // The charged mark moves outside this lock (markRecordingLiveCharged),
      // so the track row is read locked: a mark being moved is seen moved.
      .for("update");
    if (!before?.providerId || !before.model) {
      throw new RecordingConflictError(
        "This track has no live transcript; start a live session first",
        "no_live_session",
      );
    }
    const live = { providerId: before.providerId, model: before.model };
    const { chargedInCredits, costUsdMicros } = input.pricing(live);
    const streamedBefore = Number(before.streamed);
    const streamed = Math.max(streamedBefore, input.streamedMilliseconds);
    // Nothing charged yet: charging starts at what had streamed before it
    // (an older release's or a time credits weren't billed).
    const chargedUpTo = before.charged ?? streamedBefore;
    await tx
      .update(schema.recordingTracks)
      .set({
        liveStreamedMilliseconds: streamed,
        ...(chargedInCredits
          ? { liveChargedMilliseconds: chargedUpTo }
          : input.streamedMilliseconds >= streamedBefore
            ? { liveCostUsdMicros: costUsdMicros }
            : {}),
      })
      .where(trackWhere(input));
    const result = {
      live,
      addedMilliseconds: streamed - streamedBefore,
      charge:
        chargedInCredits && streamed > chargedUpTo
          ? { fromMilliseconds: chargedUpTo, toMilliseconds: streamed }
          : null,
    };
    if (input.segments.length === 0) return { saved: 0, ended: false, ...result };
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
    return { saved: saved.length, ended: false, ...result };
  });
}

/**
 * Note that a track's streamed audio up to `toMilliseconds` is charged. The
 * mark only moves forward, so a late or repeated call changes nothing.
 */
export async function markRecordingLiveCharged(
  db: Database,
  input: RecordingActor & { recordingId: string; trackNumber: number; toMilliseconds: number },
): Promise<void> {
  await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    await tx
      .update(schema.recordingTracks)
      .set({
        liveChargedMilliseconds: sql`greatest(coalesce(${schema.recordingTracks.liveChargedMilliseconds}, 0), ${input.toMilliseconds}::integer)`,
      })
      .where(trackWhere(input));
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

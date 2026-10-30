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
 * How far a track's live sessions may run ahead of the audio its recorder
 * reports, when that audio is charged in credits. The audio goes from the
 * device straight to the provider, so the recorder's own total is the meter;
 * these bounds keep a recorder that doesn't report (or under-reports) from
 * getting more sessions, and never refuse one that reports honestly, however
 * it pauses or stays silent.
 *
 * Time is measured between the recorder's reports, so a pause never counts.
 * The recorder reports its total about every minute while streaming, when it
 * pauses and resumes, and before asking for another session. The time up to
 * a report of more audio counts (at most {@link LIVE_REPORT_GAP_MAX_MILLISECONDS}
 * of it, as an honest recorder reports far more often while streaming); the
 * time up to a report of no more audio (a pause, or a session that never
 * connected) doesn't. A session the recorder never reported on before asking
 * for another counts all its time up to that request, and as unreported.
 *
 * A track gets no more sessions once:
 * - {@link LIVE_UNREPORTED_GRANTS_MAX} of its sessions went unreported;
 * - it had {@link LIVE_GRANTS_FREE} sessions, one more for each
 *   {@link LIVE_GRANT_EARNED_PER_MILLISECONDS} of audio it reported, and at
 *   most {@link LIVE_GRANTS_MAX};
 * - or the time its sessions covered is ahead of its reported audio by more
 *   than {@link LIVE_BEHIND_SLACK_MILLISECONDS} plus
 *   {@link LIVE_BEHIND_SLACK_FRACTION} of that time.
 */
export const LIVE_UNREPORTED_GRANTS_MAX = 4;
export const LIVE_GRANTS_FREE = 20;
export const LIVE_GRANT_EARNED_PER_MILLISECONDS = 5 * 60_000;
export const LIVE_GRANTS_MAX = 100;
export const LIVE_BEHIND_SLACK_MILLISECONDS = 10 * 60_000;
export const LIVE_BEHIND_SLACK_FRACTION = 0.25;
export const LIVE_REPORT_GAP_MAX_MILLISECONDS = 3 * 60_000;

/** Why a track gets no more live sessions, or null when it may have one. */
export function liveGrantRefusal(input: {
  /** Sessions granted for the track so far. */
  grants: number;
  /** Sessions of the track the recorder never reported on. */
  unreportedGrants: number;
  /** Audio the recorder reported streaming for the track. */
  streamedMilliseconds: number;
  /** Time counted against the reported audio (see above). */
  coveredMilliseconds: number;
}): "live_grant_limit" | "live_streamed_behind" | null {
  if (input.unreportedGrants >= LIVE_UNREPORTED_GRANTS_MAX) return "live_grant_limit";
  const allowed = Math.min(
    LIVE_GRANTS_MAX,
    LIVE_GRANTS_FREE + Math.floor(input.streamedMilliseconds / LIVE_GRANT_EARNED_PER_MILLISECONDS),
  );
  if (input.grants >= allowed) return "live_grant_limit";
  const covered = input.coveredMilliseconds;
  if (
    covered - input.streamedMilliseconds >
    LIVE_BEHIND_SLACK_MILLISECONDS + LIVE_BEHIND_SLACK_FRACTION * covered
  ) {
    return "live_streamed_behind";
  }
  return null;
}

/** The one message for a track refused more live sessions. */
export const LIVE_GRANT_REFUSED_MESSAGE =
  "The live transcript stopped for this track. The recording continues and is transcribed when it ends.";

/**
 * Note that a track streams to a live model, counting the session granted.
 * Only the person recording may, and only while the recording is being
 * captured. When the track's audio is charged in credits (`bounded`), a
 * track whose sessions run far ahead of the audio it reports gets no more
 * (see {@link liveGrantRefusal}).
 */
export async function startRecordingLiveTrack(
  db: Database,
  input: RecordingActor & {
    recordingId: string;
    trackNumber: number;
    providerId: string;
    model: string;
    /** The track's audio is charged in credits, so its sessions are bounded. */
    bounded?: boolean;
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
    const [current] = await tx
      .select({
        streamed: schema.recordingTracks.liveStreamedMilliseconds,
        grants: schema.recordingTracks.liveGrants,
        covered: schema.recordingTracks.liveCoveredMilliseconds,
        unreported: schema.recordingTracks.liveUnreportedGrants,
        // The latest session, which this request ends: whether the recorder
        // reported on it, and the time since the last grant or report (null
        // when no session is open).
        latestReported: sql<
          boolean | null
        >`${schema.recordingTracks.liveReportedAt} >= ${schema.recordingTracks.liveGrantedAt}`,
        sinceCounted: sql<
          number | null
        >`case when ${schema.recordingTracks.liveGrantedAt} is not null then (extract(epoch from clock_timestamp() - ${schema.recordingTracks.liveCountedAt}) * 1000)::float8 end`,
      })
      .from(schema.recordingTracks)
      .where(trackWhere(input))
      .for("update");
    if (!current) throw new RecordingNotFoundError("Track not found");
    // A session never reported on counts all its time and as unreported; a
    // reported one counts the time since its last report, as a report would.
    const open = current.sinceCounted !== null;
    const reported = current.latestReported === true;
    const tail = open ? Math.max(0, Number(current.sinceCounted)) : 0;
    const covered =
      Number(current.covered ?? 0) +
      (reported ? Math.min(tail, LIVE_REPORT_GAP_MAX_MILLISECONDS) : tail);
    const unreported = (current.unreported ?? 0) + (open && !reported ? 1 : 0);
    if (input.bounded) {
      const refusal = liveGrantRefusal({
        grants: current.grants ?? 0,
        unreportedGrants: unreported,
        streamedMilliseconds: Number(current.streamed),
        coveredMilliseconds: covered,
      });
      if (refusal) throw new RecordingConflictError(LIVE_GRANT_REFUSED_MESSAGE, refusal);
    }
    const [track] = await tx
      .update(schema.recordingTracks)
      .set({
        liveProviderId: input.providerId,
        liveModel: input.model,
        liveGrants: sql`coalesce(${schema.recordingTracks.liveGrants}, 0) + 1`,
        liveGrantedAt: sql`clock_timestamp()`,
        liveCountedAt: sql`clock_timestamp()`,
        liveCoveredMilliseconds: Math.round(covered),
        liveUnreportedGrants: unreported,
      })
      .where(trackWhere(input))
      .returning({ trackNumber: schema.recordingTracks.trackNumber });
    if (!track) throw new RecordingNotFoundError("Track not found");
    const language = (recording.transcription as { language?: unknown }).language;
    return { language: typeof language === "string" ? language : null };
  });
}

/**
 * Take back a session counted by {@link startRecordingLiveTrack} that the
 * provider never started, so a provider outage doesn't use up the track's
 * sessions, and no time is counted for it.
 */
export async function releaseRecordingLiveGrant(
  db: Database,
  input: RecordingActor & { recordingId: string; trackNumber: number },
): Promise<void> {
  await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    await tx
      .update(schema.recordingTracks)
      .set({
        liveGrants: sql`greatest(coalesce(${schema.recordingTracks.liveGrants}, 0) - 1, 0)`,
        liveGrantedAt: null,
        liveCountedAt: null,
      })
      .where(trackWhere(input));
  });
}

/** A stretch of a track's streamed audio, in milliseconds from its start. */
export type RecordingLiveRange = { fromMilliseconds: number; toMilliseconds: number };

export type AppendRecordingLiveSegmentsInput = RecordingActor & {
  recordingId: string;
  trackNumber: number;
  /** All audio streamed for this track so far; the stored total never shrinks. */
  streamedMilliseconds: number;
  /**
   * How the track's live model is paid, asked under the recording lock with
   * the model the track streams to.
   *
   * `listPriceMicros` prices audio at the model's list price; the track
   * stores the list price of everything streamed, which a usage allowance
   * that prices unbilled use counts, less the list price of audio charged in
   * credits, so charged audio never counts twice.
   *
   * `charge`, when the audio is charged in credits, records the charge for
   * the range from the track's charged mark to its new stored total inside
   * this transaction (its usage receipt), and the mark moves with it: the
   * range is charged once however saves overlap or retry, and a failed
   * charge fails the save (nothing of it commits) for the client to retry.
   */
  pricing: (live: RecordingLiveModel) => {
    listPriceMicros: ((milliseconds: number) => number) | null;
    charge: ((tx: Database, range: RecordingLiveRange) => Promise<void>) | null;
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
   * The range this call charged (its receipt committed with the save); its
   * credit debit follows the commit, and a debit that fails is applied from
   * the receipt later.
   */
  charged: RecordingLiveRange | null;
};

/**
 * Save finished live text. A segment number already saved keeps its first
 * copy. Once a transcript is ready the preview is over and nothing is saved.
 * The recording row lock orders a recording's appends, so the stored total
 * only grows, and `addedMilliseconds` counts and `charge` charges each
 * millisecond once however often or concurrently a client retries.
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
        charged: null,
      };
    }
    const [before] = await tx
      .select({
        providerId: schema.recordingTracks.liveProviderId,
        model: schema.recordingTracks.liveModel,
        streamed: schema.recordingTracks.liveStreamedMilliseconds,
        charged: schema.recordingTracks.liveChargedMilliseconds,
        chargedCost: schema.recordingTracks.liveChargedCostUsdMicros,
      })
      .from(schema.recordingTracks)
      .where(trackWhere(input))
      .for("update");
    if (!before?.providerId || !before.model) {
      throw new RecordingConflictError(
        "This track has no live transcript; start a live session first",
        "no_live_session",
      );
    }
    const live = { providerId: before.providerId, model: before.model };
    const { listPriceMicros, charge } = input.pricing(live);
    const streamedBefore = Number(before.streamed);
    const streamed = Math.max(streamedBefore, input.streamedMilliseconds);
    // Nothing charged yet: charging starts at what had streamed before it
    // (an older release's or a time credits weren't billed).
    const chargedUpTo = before.charged ?? streamedBefore;
    const charged =
      charge && streamed > chargedUpTo
        ? { fromMilliseconds: chargedUpTo, toMilliseconds: streamed }
        : null;
    if (charge && charged) await charge(tx, charged);
    const chargedCost =
      charged && listPriceMicros
        ? Number(before.chargedCost ?? 0) +
          Math.max(0, listPriceMicros(charged.toMilliseconds) - listPriceMicros(chargedUpTo))
        : null;
    await tx
      .update(schema.recordingTracks)
      .set({
        liveStreamedMilliseconds: streamed,
        // A report of more audio counts the time since the last grant or
        // report; any report ends what is counted, so a pause never counts
        // (see liveGrantRefusal).
        liveReportedAt: sql`clock_timestamp()`,
        liveCountedAt: sql`clock_timestamp()`,
        ...(streamed > streamedBefore
          ? {
              liveCoveredMilliseconds: sql`coalesce(${schema.recordingTracks.liveCoveredMilliseconds}, 0) + coalesce(least(
                extract(epoch from clock_timestamp() - ${schema.recordingTracks.liveCountedAt}) * 1000,
                ${LIVE_REPORT_GAP_MAX_MILLISECONDS}
              ), 0)::bigint`,
            }
          : {}),
        // Audio streamed to a model not charged in credits counts at list
        // price instead, so once charging began the mark moves past it too.
        ...(charge
          ? { liveChargedMilliseconds: charged?.toMilliseconds ?? chargedUpTo }
          : before.charged !== null
            ? { liveChargedMilliseconds: Math.max(before.charged, streamed) }
            : {}),
        // The charged list price moves in the same statement as the total's,
        // so the allowance trigger sees only what isn't charged.
        ...(chargedCost !== null ? { liveChargedCostUsdMicros: chargedCost } : {}),
        ...(listPriceMicros && input.streamedMilliseconds >= streamedBefore
          ? { liveCostUsdMicros: listPriceMicros(streamed) }
          : {}),
      })
      .where(trackWhere(input));
    const result = { live, addedMilliseconds: streamed - streamedBefore, charged };
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

import { and, eq, sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, withWorkspaceSubjectRls, type Database } from "./database";
import { automationsListenTo } from "./event-trigger-listening";
import {
  recordEventDeliveryInTransaction,
  type RecordEventDeliveryInput,
  type RecordEventDeliveryResult,
} from "./event-triggers";
import * as schema from "./schema";

// Migration 0935. A source whose events Opengeni reads from the app's change
// history (Gmail) has one feed: its reading position. The feed pump claims due
// feeds, reads what changed as the source's owner while an automation listens,
// and records it through the ordinary event intake, advancing the position in
// the same transaction.

type FeedRow = typeof schema.eventSourceFeeds.$inferSelect;

export type EventSourceFeedRecord = {
  sourceId: string;
  accountId: string;
  workspaceId: string;
  cursor: string | null;
  gapPending: boolean;
  nextActionAt: Date;
  failures: number;
  failingSince: Date | null;
  lastError: string | null;
  lastSuccessAt: Date | null;
};

function mapFeed(row: FeedRow): EventSourceFeedRecord {
  return {
    sourceId: row.sourceId,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    cursor: row.cursor,
    gapPending: row.gapPending,
    nextActionAt: row.nextActionAt,
    failures: row.failures,
    failingSince: row.failingSince,
    lastError: row.lastError,
    lastSuccessAt: row.lastSuccessAt,
  };
}

function feedIs(workspaceId: string, sourceId: string) {
  return and(
    eq(schema.eventSourceFeeds.workspaceId, workspaceId),
    eq(schema.eventSourceFeeds.sourceId, sourceId),
  );
}

/** Identity-only inventory of feeds whose next read is due; every read after it is workspace-scoped. */
export async function listDueEventSourceFeeds(
  db: Database,
  limit = 32,
): Promise<Array<{ sourceId: string; workspaceId: string }>> {
  const rows = await rawRows<{ source_id: string; workspace_id: string }>(
    db,
    sql`select * from opengeni_private.list_due_event_source_feeds_v1(${limit})`,
  );
  return rows.map((row) => ({ sourceId: row.source_id, workspaceId: row.workspace_id }));
}

export type ClaimedEventSourceFeed = {
  feed: EventSourceFeedRecord;
  /** False when no runnable automation listens to the source: do not read it. */
  wanted: boolean;
};

/**
 * Lease a due feed for one read. Another pump holding the lease, or a read
 * that is no longer due, makes this a no-op (null).
 */
export async function claimEventSourceFeed(
  db: Database,
  workspaceId: string,
  sourceId: string,
  leaseMs: number,
): Promise<ClaimedEventSourceFeed | null> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.eventSourceFeeds)
        .set({
          leaseUntil: sql`now() + make_interval(secs => ${Math.max(1, leaseMs) / 1000}::double precision)`,
        })
        .where(
          and(
            feedIs(workspaceId, sourceId),
            sql`${schema.eventSourceFeeds.nextActionAt} <= now()`,
            sql`(${schema.eventSourceFeeds.leaseUntil} is null or ${schema.eventSourceFeeds.leaseUntil} <= now())`,
          ),
        )
        .returning();
      if (!row) return null;
      const [wanted] = await rawRows<{ wanted: boolean }>(
        tx,
        sql`select ${automationsListenTo(workspaceId, sql`${row.sourceId}::uuid`)} as wanted`,
      );
      return { feed: mapFeed(row), wanted: wanted?.wanted === true };
    }),
  );
}

export type EventSourceFeedStepResult = {
  /** Undefined keeps the stored value. */
  cursor?: string | null;
  gapPending?: boolean;
  nextActionAt: Date;
  outcome: { kind: "success" } | { kind: "failure"; error: string };
};

/** Store a read's result and release the lease. */
export async function finishEventSourceFeedStep(
  db: Database,
  workspaceId: string,
  sourceId: string,
  result: EventSourceFeedStepResult,
): Promise<EventSourceFeedRecord | null> {
  const success = result.outcome.kind === "success";
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .update(schema.eventSourceFeeds)
      .set({
        ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
        ...(result.gapPending !== undefined ? { gapPending: result.gapPending } : {}),
        nextActionAt: result.nextActionAt,
        leaseUntil: null,
        ...(success
          ? { failures: 0, failingSince: null, lastError: null, lastSuccessAt: sql`now()` }
          : {
              failures: sql`${schema.eventSourceFeeds.failures} + 1`,
              failingSince: sql`coalesce(${schema.eventSourceFeeds.failingSince}, now())`,
              lastError:
                result.outcome.kind === "failure"
                  ? result.outcome.error.slice(0, 500) || "The read failed"
                  : null,
            }),
        updatedAt: sql`now()`,
      })
      .where(feedIs(workspaceId, sourceId))
      .returning();
    return row ? mapFeed(row) : null;
  });
}

export type RecordEventSourceFeedDeliveryInput = {
  workspaceId: string;
  sourceId: string;
  delivery: Omit<RecordEventDeliveryInput, "streamKey" | "accountId" | "workspaceId" | "sourceId">;
  /** The position after this delivery. */
  cursor: string;
};

/**
 * Record what a read found and advance the feed's position in one
 * transaction, so a crash never stores events without their position or the
 * reverse. A pending gap marks the first newly stored event.
 */
export async function recordEventSourceFeedDelivery(
  db: Database,
  input: RecordEventSourceFeedDeliveryInput,
): Promise<(RecordEventDeliveryResult & { feed: EventSourceFeedRecord }) | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.eventSourceFeeds)
        .where(feedIs(input.workspaceId, input.sourceId))
        .for("update")
        .limit(1);
      if (!row) return null;
      const events = input.delivery.events.map((event, index) => ({
        ...event,
        gapBefore: event.gapBefore || (row.gapPending && index === 0),
      }));
      const recorded = await recordEventDeliveryInTransaction(tx, {
        ...input.delivery,
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        sourceId: row.sourceId,
        events,
      });
      const [updated] = await tx
        .update(schema.eventSourceFeeds)
        .set({
          cursor: input.cursor,
          gapPending: row.gapPending && recorded.eventIds.length === 0,
          updatedAt: sql`now()`,
        })
        .where(feedIs(input.workspaceId, input.sourceId))
        .returning();
      return { ...recorded, feed: mapFeed(updated ?? row) };
    }),
  );
}

/** A source's feed, for its owner's view of how reading it goes. */
export async function getEventSourceFeed(
  db: Database,
  workspaceId: string,
  sourceId: string,
): Promise<EventSourceFeedRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.eventSourceFeeds)
      .where(feedIs(workspaceId, sourceId))
      .limit(1);
    return row ? mapFeed(row) : null;
  });
}

/** One recording fact as a "This workspace" source reads it. */
export type WorkspaceRecordingEvent = {
  id: string;
  recordingId: string;
  type: string;
  /** What workspace webhooks send as `data`: ids, states and counts. */
  data: Record<string, unknown>;
  occurredAt: Date;
  /** The recording's title and purpose; null once the recording is deleted. */
  title: string | null;
  purpose: string | null;
};

export type WorkspaceRecordingEventsRead = {
  events: WorkspaceRecordingEvent[];
  /** The database clock when it read, the next read's position. */
  readAt: Date;
};

/**
 * The recording events a person may see that a source has not stored yet,
 * oldest first, written after `since`. It reads as that person, so their own
 * recordings and those shared with the workspace are all it ever sees.
 * Events are stamped when they are written rather than when they commit, so
 * callers pass a `since` well before their last read and rely on the
 * "not stored yet" filter for what they already have.
 */
export async function listWorkspaceRecordingEventsForSource(
  db: Database,
  input: {
    workspaceId: string;
    sourceId: string;
    subjectId: string;
    since: Date;
    limit: number;
  },
): Promise<WorkspaceRecordingEventsRead> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const rows = await rawRows<{
      id: string;
      recording_id: string;
      type: string;
      data: Record<string, unknown>;
      occurred_at: Date | string;
      title: string | null;
      purpose: string | null;
    }>(
      tx,
      sql`select event.id, event.recording_id, event.type, event.data, event.occurred_at,
          recording.title, recording.purpose
        from recording_events event
        left join recordings recording
          on recording.workspace_id = event.workspace_id and recording.id = event.recording_id
        where event.workspace_id = ${input.workspaceId}
          and event.occurred_at > ${input.since.toISOString()}::timestamptz
          and not exists (
            select 1 from inbound_events stored
            where stored.source_id = ${input.sourceId}::uuid and stored.stream_key = ''
              and stored.external_id = event.id::text)
        order by event.occurred_at, event.id
        limit ${Math.max(1, Math.min(input.limit, 500))}`,
    );
    const [clock] = await rawRows<{ now: Date | string }>(tx, sql`select clock_timestamp() as now`);
    const asDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));
    return {
      events: rows.map((row) => ({
        id: row.id,
        recordingId: row.recording_id,
        type: row.type,
        data: row.data,
        occurredAt: asDate(row.occurred_at),
        title: row.title,
        purpose: row.purpose,
      })),
      readAt: asDate(clock!.now),
    };
  });
}

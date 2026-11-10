import {
  SESSION_ARCHIVE_STOP_REASON,
  type SessionEvent,
  type SessionEventType,
} from "@opengeni/contracts";
import { and, asc, eq, gt, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import {
  rawRows,
  withRlsContext,
  withSessionActivityRlsContext,
  withWorkspaceSessionActivityRls,
  type Database,
} from "./database";
import { fromPostgresLosslessJson, withLosslessContentWriteVersion } from "./lossless-json";
import { withBoundSessionEventPayloads } from "./session-event-write-bounds";
import * as schema from "./schema";
import { lockSessionEventWriteRows } from "./session-control";

/**
 * Idle-session archive (see docs/session-storage-lifecycle.md).
 *
 * Lifecycle on the session row: live -> archiving -> archived. `archiving` is
 * entered under the session's write lock after re-checking eligibility; from
 * that moment the database refuses new turns, history and machine inputs, so a
 * message cannot race the archive. The worker exports the session to a bundle,
 * uploads and verifies it, records the manifest (`archived`), and only then
 * purges the bulky tables. Turns, attempts, goals and readable timeline events
 * stay, so readers and durable references are unchanged.
 */

export const SESSION_ARCHIVE_FORMAT = "opengeni.session-archive" as const;
export const SESSION_ARCHIVE_FORMAT_VERSION = 1 as const;
export const SESSION_ARCHIVE_TRANSCRIPT_FORMAT = "opengeni.session-transcript" as const;

/** Purge order respects every foreign key between these tables. */
export const SESSION_ARCHIVE_PURGE_TABLES = [
  "session_realtime_entries",
  "session_system_updates",
  "session_history_items",
  "session_attempt_codemode_calls",
  "session_attempt_tool_catalogs",
  "session_attempt_model_context_snapshots",
  "session_content_blobs",
  "session_pending_tool_calls",
  "session_events",
] as const;
export type SessionArchivePurgeTable = (typeof SESSION_ARCHIVE_PURGE_TABLES)[number];

/** Event types purged after archiving; every other type stays readable. */
export const SESSION_ARCHIVE_PURGED_EVENT_TYPES = [
  "agent.message.delta",
  "agent.reasoning.delta",
  "sandbox.command.output.delta",
  "terminal.pty.output.delta",
  "agent.model.request",
  "system.update.pending",
  "system.update.delivered",
  "system.update.settled",
  "turn.startup.phase.started",
  "turn.startup.phase.completed",
  "codex.credential.selected",
  "turn.event.rejected_late",
] as const;

type KeyColumn = { column: string; cast: string };
export type SessionArchiveExportTable = {
  table: string;
  /** Bundle order; unique per session. */
  keys: KeyColumn[];
  /**
   * A uuid column with its own unique index (the primary key). The table is
   * paged by a prefetched, ordered list of these ids instead of a keyset cursor.
   * Tables without one page by keyset on a single key that leads a unique
   * (workspace_id, session_id, key) index.
   */
  idColumn?: string;
};

/**
 * Everything the bundle carries, in bundle order, read so that every page is an
 * index seek and a very long session exports in linear time.
 *
 * Export reads run under row-level security, where PostgreSQL only uses
 * leakproof comparisons as index conditions; numeric and row comparisons are
 * not leakproof and become a filter after the policy that re-reads every
 * earlier row. A multi-column cursor also only bounds its first column. So
 * tables ordered by several keys, or by a numeric key, page by id list (see
 * readSessionArchiveTablePages), and keyset tables use one integer, uuid, text
 * or timestamptz key that an index on (workspace_id, session_id, key) seeks.
 */
export const SESSION_ARCHIVE_EXPORT_TABLES: readonly SessionArchiveExportTable[] = [
  {
    table: "session_turns",
    keys: [{ column: "position", cast: "bigint" }, uuidKey("id")],
    idColumn: "id",
  },
  {
    table: "session_turn_attempts",
    keys: [{ column: "turn_id", cast: "uuid" }, uuidKey("id")],
    idColumn: "id",
  },
  { table: "session_goals", keys: [uuidKey("id")], idColumn: "id" },
  { table: "session_goal_revisions", keys: [uuidKey("id")], idColumn: "id" },
  { table: "session_events", keys: [{ column: "sequence", cast: "integer" }] },
  {
    table: "session_history_items",
    keys: [{ column: "position", cast: "numeric" }, uuidKey("id")],
    idColumn: "id",
  },
  { table: "session_system_updates", keys: [{ column: "dedupe_key", cast: "text" }] },
  { table: "session_realtime_entries", keys: [uuidKey("id")], idColumn: "id" },
  {
    table: "session_attempt_codemode_calls",
    keys: [
      { column: "turn_id", cast: "uuid" },
      { column: "created_at", cast: "timestamptz" },
      uuidKey("operation_id"),
    ],
    idColumn: "operation_id",
  },
  {
    table: "session_attempt_tool_catalogs",
    keys: [{ column: "turn_id", cast: "uuid" }, uuidKey("attempt_id")],
    idColumn: "attempt_id",
  },
  {
    table: "session_attempt_model_context_snapshots",
    keys: [{ column: "captured_at", cast: "timestamptz" }, uuidKey("attempt_id")],
    idColumn: "attempt_id",
  },
  { table: "session_content_blobs", keys: [{ column: "digest", cast: "text" }] },
  {
    table: "session_pending_tool_calls",
    keys: [{ column: "turn_id", cast: "uuid" }, uuidKey("id")],
    idColumn: "id",
  },
  // Read through its own archive-only definer (visible only to its initiator).
  { table: "preference_registry_snapshots", keys: [uuidKey("id")] },
];

function uuidKey(column: string): KeyColumn {
  return { column, cast: "uuid" };
}

export type SessionArchiveScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
};

export type SessionArchiveObject = { key: string; bytes: number; sha256: string };

/**
 * Fresh object keys for one archive write. Every write uses a new archive id,
 * so a published key is never overwritten; the secret history scrub writes
 * its rewritten objects under new keys the same way.
 */
export function sessionArchiveObjectKeys(scope: SessionArchiveScope, archiveId: string) {
  const prefix = `session-archives/${scope.workspaceId}/${scope.sessionId}/${archiveId}`;
  return {
    bundle: `${prefix}/bundle.jsonl.zst`,
    transcript: `${prefix}/transcript.jsonl.zst`,
  };
}

export type SessionArchiveManifest = {
  format: typeof SESSION_ARCHIVE_FORMAT;
  version: typeof SESSION_ARCHIVE_FORMAT_VERSION;
  /** Every object this archive owns; deleted with the session. */
  objectKeys: string[];
  bundle: SessionArchiveObject;
  transcript: SessionArchiveObject & { events: number };
  /** Bundle digest, duplicated at top level for database invariants. */
  sha256: string;
  rowCounts: Record<string, number>;
  createdAt: string;
};

export type SessionRetention = {
  keepLive: boolean;
  archive: {
    state: "archiving" | "archived";
    archivedAt: string | null;
    /** Someone asked to restore it; its content is being put back. */
    restoring?: true | undefined;
  } | null;
};

export function sessionRetentionFromRow(row: {
  keepLive: boolean;
  contentArchiveState: string | null;
  contentArchivedAt: Date | null;
  contentRestoreRequestedAt?: Date | null;
}): SessionRetention {
  return {
    keepLive: row.keepLive,
    archive:
      row.contentArchiveState === "archiving" || row.contentArchiveState === "archived"
        ? {
            state: row.contentArchiveState,
            archivedAt: row.contentArchivedAt?.toISOString() ?? null,
            ...(row.contentArchiveState === "archived" && row.contentRestoreRequestedAt
              ? { restoring: true as const }
              : {}),
          }
        : null,
  };
}

export async function listSessionArchiveCandidates(
  db: Database,
  input: { idleSeconds: number; limit: number },
): Promise<SessionArchiveScope[]> {
  const rows = await rawRows<{ account_id: string; workspace_id: string; session_id: string }>(
    db,
    sql`select account_id, workspace_id, session_id
      from opengeni_private.session_archive_candidates(${Math.floor(input.idleSeconds)}, ${input.limit})`,
  );
  return rows.map((row) => ({
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
  }));
}

/**
 * `restoring`: a stored chat whose restore was requested a while ago and is
 * not done yet (its workflow may have been lost); the pass finishes it.
 */
export type UnfinishedSessionArchive = SessionArchiveScope & {
  state: "archiving" | "archived" | "restoring";
};

export async function listUnfinishedSessionArchives(
  db: Database,
  input: { staleSeconds: number; limit: number },
): Promise<UnfinishedSessionArchive[]> {
  const rows = await rawRows<{
    account_id: string;
    workspace_id: string;
    session_id: string;
    state: "archiving" | "archived" | "restoring";
  }>(
    db,
    sql`select account_id, workspace_id, session_id, state
      from opengeni_private.session_archive_unfinished(${Math.floor(input.staleSeconds)}, ${input.limit})`,
  );
  return rows.map((row) => ({
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    state: row.state,
  }));
}

/**
 * Enter `archiving` if the session is still eligible under its write lock.
 * Returns false (and changes nothing) when it became active or ineligible.
 */
export async function beginSessionArchive(
  db: Database,
  scope: SessionArchiveScope,
  input: { idleSeconds: number; objectKeys: string[] },
): Promise<boolean> {
  return await withSessionActivityRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await lockSessionEventWriteRows(tx, {
          workspaceId: scope.workspaceId,
          controlLock: "share",
          sessionIds: [scope.sessionId],
        });
        // Locked before the recheck, so a restore or unarchive of this chat
        // either commits first (and the recheck sees it) or waits for us.
        await rawRows(
          tx,
          sql`select id from sessions
            where workspace_id = ${scope.workspaceId}::uuid and id = ${scope.sessionId}::uuid
            for no key update`,
        );
        const eligible = await rawRows<{ session_id: string }>(
          tx,
          sql`select session_id from opengeni_private.session_archive_candidates(
            ${Math.floor(input.idleSeconds)}, 1, ${scope.sessionId}::uuid)`,
        );
        if (eligible.length !== 1) return false;
        // A wake still waiting to reach the chat's workflow (for example the
        // one cancelling its work) must be delivered first: once archiving
        // starts, the outbox row can no longer be updated, and the dispatcher
        // claims rows in batches, so one such row would hold back every wake.
        const [pendingWake] = await rawRows<{ pending: boolean }>(
          tx,
          sql`select exists (
            select 1 from ${schema.sessionWorkflowWakeOutbox}
            where workspace_id = ${scope.workspaceId}::uuid
              and session_id = ${scope.sessionId}::uuid
              and wake_revision > delivered_revision
          ) as pending`,
        );
        if (pendingWake?.pending) return false;
        const updated = await tx
          .update(schema.sessions)
          .set({
            contentArchiveState: "archiving",
            contentArchiveStartedAt: new Date(),
            // A restore marker only matters while the chat is live.
            contentRestoreRequestedAt: null,
            contentArchive: {
              format: SESSION_ARCHIVE_FORMAT,
              version: SESSION_ARCHIVE_FORMAT_VERSION,
              objectKeys: input.objectKeys,
            },
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, scope.workspaceId),
              eq(schema.sessions.id, scope.sessionId),
              isNull(schema.sessions.contentArchiveState),
            ),
          )
          .returning({ id: schema.sessions.id });
        return updated.length === 1;
      }),
  );
}

export async function completeSessionArchive(
  db: Database,
  scope: SessionArchiveScope,
  manifest: SessionArchiveManifest,
): Promise<boolean> {
  return await withSessionActivityRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) => {
      const updated = await scoped
        .update(schema.sessions)
        .set({
          contentArchiveState: "archived",
          contentArchivedAt: new Date(),
          contentArchive: manifest as unknown as Record<string, unknown>,
          // The idle archiver archives a chat for everyone as it stores it.
          archivedAt: sql`coalesce(${schema.sessions.archivedAt}, now())`,
        })
        .where(
          and(
            eq(schema.sessions.workspaceId, scope.workspaceId),
            eq(schema.sessions.id, scope.sessionId),
            eq(schema.sessions.contentArchiveState, "archiving"),
          ),
        )
        .returning({ id: schema.sessions.id });
      return updated.length === 1;
    },
  );
}

/** Abandon an unfinished archive; its planned objects are queued for deletion. */
export async function abandonSessionArchive(
  db: Database,
  scope: SessionArchiveScope,
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) => {
      const [row] = await rawRows<{ abandoned: boolean }>(
        scoped,
        sql`select opengeni_private.abandon_session_content_archive(
          ${scope.workspaceId}::uuid, ${scope.sessionId}::uuid) as abandoned`,
      );
      return row?.abandoned === true;
    },
  );
}

/**
 * One keyset page of raw rows as exact JSON text, in bundle order. Rows are
 * rendered with row_to_json, not to_jsonb: a row whose jsonb columns together
 * exceed jsonb's 256 MB object limit (for example a huge retained tool output
 * stored twice) still renders as JSON text, and column order is preserved.
 */
export async function readSessionArchiveRows(
  db: Database,
  scope: SessionArchiveScope,
  spec: SessionArchiveExportTable,
  input: { after: string[] | null; limit: number },
): Promise<{ rows: string[]; last: string[] | null }> {
  if (spec.table === "preference_registry_snapshots") {
    // Visible only to each snapshot's initiating human under RLS; read through
    // the archive-only definer instead of the workspace context.
    const rows = await rawRows<{ id: string; row_json: string }>(
      db,
      sql`select id::text as id, row_json
        from opengeni_private.session_archive_preference_snapshot_rows(
          ${scope.workspaceId}::uuid, ${scope.sessionId}::uuid,
          ${input.after?.[0] ?? null}::uuid, ${input.limit})`,
    );
    const lastRow = rows.at(-1);
    return { rows: rows.map((row) => row.row_json), last: lastRow ? [lastRow.id] : null };
  }
  return await withRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) => {
      const rows = await rawRows<Record<string, string>>(
        scoped,
        sessionArchiveExportSql.keysetPage(scope, spec, input),
      );
      const lastRow = rows.at(-1);
      return {
        rows: rows.map((row) => row.row!),
        last: lastRow ? spec.keys.map((_, index) => lastRow[`k${index}`]!) : null,
      };
    },
  );
}

function keyColumns(spec: SessionArchiveExportTable): SQL[] {
  return spec.keys.map((key) => sql`t.${sql.identifier(key.column)}`);
}

function sessionRows(scope: SessionArchiveScope): SQL {
  return sql`t.account_id = ${scope.accountId}::uuid
    and t.workspace_id = ${scope.workspaceId}::uuid
    and t.session_id = ${scope.sessionId}::uuid`;
}

function idColumnOf(spec: SessionArchiveExportTable): SQL {
  if (!spec.idColumn) throw new Error(`session archive export: ${spec.table} has no id column`);
  return sql`t.${sql.identifier(spec.idColumn)}`;
}

/**
 * The export's page queries, run under the workspace's row-level security
 * context. Exported so tests can check their plans.
 */
export const sessionArchiveExportSql = {
  /** One keyset page, with each row's key values as text for the next cursor. */
  keysetPage(
    scope: SessionArchiveScope,
    spec: SessionArchiveExportTable,
    input: { after: string[] | null; limit: number },
  ): SQL {
    const keys = keyColumns(spec);
    const keyText = sql.join(
      keys.map((key, index) => sql`${key}::text as ${sql.identifier(`k${index}`)}`),
      sql`, `,
    );
    const after = input.after
      ? keysetAfter(
          keys,
          spec.keys.map((key, index) => sql`${input.after![index]}::${sql.raw(key.cast)}`),
        )
      : sql`true`;
    return sql`select row_to_json(t)::text as row, ${keyText}
      from ${sql.identifier(spec.table)} t
      where ${sessionRows(scope)} and ${after}
      order by ${sql.join(keys, sql`, `)}
      limit ${input.limit}`;
  },
  /** Every row id of the session's rows, in bundle order. */
  idList(scope: SessionArchiveScope, spec: SessionArchiveExportTable): SQL {
    return sql`select ${idColumnOf(spec)}::text as id
      from ${sql.identifier(spec.table)} t
      where ${sessionRows(scope)}
      order by ${sql.join(keyColumns(spec), sql`, `)}`;
  },
  /** The rows with these ids, in bundle order, found by primary key. */
  idPage(scope: SessionArchiveScope, spec: SessionArchiveExportTable, ids: string[]): SQL {
    return sql`select row_to_json(t)::text as row
      from ${sql.identifier(spec.table)} t
      where ${idColumnOf(spec)} = any(${`{${ids.join(",")}}`}::uuid[]) and ${sessionRows(scope)}
      order by ${sql.join(keyColumns(spec), sql`, `)}`;
  },
};

/**
 * `(k0, k1, ...) > (v0, v1, ...)` spelled column by column. Under row-level
 * security PostgreSQL only uses leakproof comparisons as index conditions or
 * before the policy; a row comparison is not leakproof, while the per-column
 * operators of the export key types are. The leading `k0 >= v0` gives the index
 * a lower bound.
 */
function keysetAfter(keys: SQL[], values: SQL[]): SQL {
  const last = keys.length - 1;
  let tail = sql`${keys[last]} > ${values[last]}`;
  for (let index = last - 1; index >= 0; index -= 1) {
    tail = sql`(${keys[index]} > ${values[index]} or (${keys[index]} = ${values[index]} and ${tail}))`;
  }
  return last === 0 ? tail : sql`${keys[0]} >= ${values[0]} and ${tail}`;
}

/**
 * Every row of one export table, as exact JSON text in bundle order, in pages
 * of at most `pageRows`. Each page is a bounded, indexed read, so exporting a
 * session with hundreds of thousands of rows stays linear. Tables marked
 * with an `idColumn` first read their ordered ids in one pass, then fetch each
 * page by primary key; the session is frozen while archiving, and a row that
 * disappears in between fails the export rather than shortening the bundle.
 */
export async function* readSessionArchiveTablePages(
  db: Database,
  scope: SessionArchiveScope,
  spec: SessionArchiveExportTable,
  input: { pageRows: number },
): AsyncGenerator<string[]> {
  if (!spec.idColumn) {
    let after: string[] | null = null;
    for (;;) {
      const page = await readSessionArchiveRows(db, scope, spec, {
        after,
        limit: input.pageRows,
      });
      if (page.rows.length > 0) yield page.rows;
      if (page.rows.length < input.pageRows) return;
      after = page.last;
    }
  }
  const context = { accountId: scope.accountId, workspaceId: scope.workspaceId };
  const ids = await withRlsContext(db, context, async (scoped) =>
    (await rawRows<{ id: string }>(scoped, sessionArchiveExportSql.idList(scope, spec))).map(
      (row) => row.id,
    ),
  );
  for (let start = 0; start < ids.length; start += input.pageRows) {
    const pageIds = ids.slice(start, start + input.pageRows);
    const rows = await withRlsContext(db, context, async (scoped) =>
      (
        await rawRows<{ row: string }>(scoped, sessionArchiveExportSql.idPage(scope, spec, pageIds))
      ).map((row) => row.row),
    );
    if (rows.length !== pageIds.length) {
      throw new Error(
        `session archive export: ${spec.table} returned ${rows.length} of ${pageIds.length} rows; the session changed while archiving`,
      );
    }
    yield rows;
  }
}

/**
 * One page of the readable transcript in the public SessionEvent shape: every
 * event type that stays in the timeline after archiving.
 */
export async function readSessionArchiveTranscriptEvents(
  db: Database,
  scope: SessionArchiveScope,
  input: { afterSequence: number; limit: number },
): Promise<SessionEvent[]> {
  return await withRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) => {
      const rows = await scoped
        .select()
        .from(schema.sessionEvents)
        .where(
          and(
            eq(schema.sessionEvents.workspaceId, scope.workspaceId),
            eq(schema.sessionEvents.sessionId, scope.sessionId),
            gt(schema.sessionEvents.sequence, input.afterSequence),
            notInArray(schema.sessionEvents.type, [...SESSION_ARCHIVE_PURGED_EVENT_TYPES]),
          ),
        )
        .orderBy(asc(schema.sessionEvents.sequence))
        .limit(input.limit);
      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        sequence: row.sequence,
        type: row.type as SessionEventType,
        payload: fromPostgresLosslessJson(row.payload, row.payloadCodecVersion),
        occurredAt: row.occurredAt.toISOString(),
        clientEventId: row.clientEventId,
        turnId: row.turnId,
        turnGeneration: row.turnGeneration,
        turnAttemptId: row.turnAttemptId,
        turnAssociation: row.turnAssociation as SessionEvent["turnAssociation"],
        duplicateOfEventId: row.duplicateOfEventId,
        duplicateReason: row.duplicateReason,
      }));
    },
  );
}

/** The `session_events` columns of a row the bundle export rendered with row_to_json. */
type SessionEventExportRow = {
  id: string;
  workspace_id: string;
  session_id: string;
  sequence: number;
  type: string;
  payload: unknown;
  payload_codec_version: number | null;
  occurred_at: string;
  client_event_id: string | null;
  turn_id: string | null;
  turn_generation: number | null;
  turn_attempt_id: string | null;
  turn_association: string | null;
  duplicate_of_event_id: string | null;
  duplicate_reason: string | null;
};

const SESSION_ARCHIVE_PURGED_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  SESSION_ARCHIVE_PURGED_EVENT_TYPES,
);

/**
 * The transcript event for one exported `session_events` row (its exact
 * row_to_json text, as the bundle carries it), or null when the type is purged
 * and so not part of the transcript. Equal to what
 * {@link readSessionArchiveTranscriptEvents} returns for the same row, so the
 * archive writes the transcript from the rows the bundle already read.
 */
export function sessionArchiveTranscriptEvent(row: string): SessionEvent | null {
  const event = JSON.parse(row) as SessionEventExportRow;
  if (SESSION_ARCHIVE_PURGED_EVENT_TYPE_SET.has(event.type)) return null;
  return {
    id: event.id,
    workspaceId: event.workspace_id,
    sessionId: event.session_id,
    sequence: event.sequence,
    type: event.type as SessionEventType,
    payload: fromPostgresLosslessJson(event.payload, event.payload_codec_version),
    // The same instant, truncated to milliseconds, as the driver's Date.
    occurredAt: new Date(event.occurred_at).toISOString(),
    clientEventId: event.client_event_id,
    turnId: event.turn_id,
    turnGeneration: event.turn_generation,
    turnAttemptId: event.turn_attempt_id,
    turnAssociation: event.turn_association as SessionEvent["turnAssociation"],
    duplicateOfEventId: event.duplicate_of_event_id,
    duplicateReason: event.duplicate_reason,
  };
}

export async function readSessionArchiveSessionRow(
  db: Database,
  scope: SessionArchiveScope,
): Promise<string> {
  return await withRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) => {
      const [row] = await rawRows<{ row: string }>(
        scoped,
        sql`select row_to_json(s)::text as row from sessions s
          where s.workspace_id = ${scope.workspaceId}::uuid and s.id = ${scope.sessionId}::uuid`,
      );
      if (!row) throw new Error("Archived session row is not visible");
      return row.row;
    },
  );
}

/**
 * Purge one bounded batch per call until every table is empty. Returns the
 * rows deleted in this call; zero means the purge is complete and recorded.
 *
 * Tables are purged in order. A call stops at the first table that still had
 * a full batch and reports it as `nextTable`; passing that back as
 * `fromTable` resumes there instead of calling every already-empty table
 * before it again. The purge is only recorded complete after a call that
 * starts at the first table and finds nothing in any table.
 */
export async function purgeArchivedSessionContent(
  db: Database,
  scope: SessionArchiveScope,
  input: { batchSize: number; fromTable?: number },
): Promise<{ deleted: number; complete: boolean; nextTable: number }> {
  const fromTable = Math.min(
    Math.max(Math.trunc(input.fromTable ?? 0), 0),
    SESSION_ARCHIVE_PURGE_TABLES.length,
  );
  let deleted = 0;
  for (let index = fromTable; index < SESSION_ARCHIVE_PURGE_TABLES.length; index += 1) {
    const table = SESSION_ARCHIVE_PURGE_TABLES[index]!;
    const count = await withRlsContext(
      db,
      { accountId: scope.accountId, workspaceId: scope.workspaceId },
      async (scoped) => {
        const [row] = await rawRows<{ deleted: number }>(
          scoped,
          sql`select opengeni_private.purge_archived_session_content(
            ${scope.workspaceId}::uuid, ${scope.sessionId}::uuid, ${table}, ${input.batchSize}
          ) as deleted`,
        );
        return Number(row?.deleted ?? 0);
      },
    );
    deleted += count;
    if (count >= input.batchSize) return { deleted, complete: false, nextTable: index };
  }
  // Rows were deleted, or tables before fromTable were skipped: one more pass
  // over every table confirms nothing is left.
  if (deleted > 0 || fromTable > 0) return { deleted, complete: false, nextTable: 0 };
  await withSessionActivityRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) =>
      await scoped
        .update(schema.sessions)
        .set({ contentArchivePurgedAt: new Date() })
        .where(
          and(
            eq(schema.sessions.workspaceId, scope.workspaceId),
            eq(schema.sessions.id, scope.sessionId),
            eq(schema.sessions.contentArchiveState, "archived"),
            isNull(schema.sessions.contentArchivePurgedAt),
          ),
        ),
  );
  return { deleted, complete: true, nextTable: 0 };
}

export type SessionArchiveObjectDeletion = {
  objectKey: string;
  workspaceId: string;
  sessionId: string;
};

export async function claimSessionArchiveObjectDeletions(
  db: Database,
  input: { claimTimeoutSeconds: number; limit: number },
): Promise<SessionArchiveObjectDeletion[]> {
  const rows = await rawRows<{ object_key: string; workspace_id: string; session_id: string }>(
    db,
    sql`select object_key, workspace_id, session_id
      from opengeni_private.claim_session_archive_object_deletions(
        ${input.claimTimeoutSeconds}, ${input.limit})`,
  );
  return rows.map((row) => ({
    objectKey: row.object_key,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
  }));
}

export async function completeSessionArchiveObjectDeletion(
  db: Database,
  objectKey: string,
): Promise<boolean> {
  const [row] = await rawRows<{ completed: boolean }>(
    db,
    sql`select opengeni_private.complete_session_archive_object_deletion(${objectKey}) as completed`,
  );
  return row?.completed === true;
}

export { SessionArchivedError } from "./session-archive-errors";

export type SetSessionKeepLiveResult =
  | { status: "updated"; retention: SessionRetention }
  | { status: "not_found" }
  | { status: "archived" };

/**
 * Set or clear the per-session keep-live exemption. Callers authorize the
 * session first (`session.retention.write`); this is the workspace-scoped write.
 */
export async function setSessionKeepLive(
  db: Database,
  input: { workspaceId: string; sessionId: string; keepLive: boolean },
): Promise<SetSessionKeepLiveResult> {
  return await withWorkspaceSessionActivityRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [row] = await tx
          .select({
            keepLive: schema.sessions.keepLive,
            contentArchiveState: schema.sessions.contentArchiveState,
            contentArchivedAt: schema.sessions.contentArchivedAt,
            archivedAt: schema.sessions.archivedAt,
          })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("no key update")
          .limit(1);
        if (!row) return { status: "not_found" as const };
        if (row.contentArchiveState !== null || row.archivedAt !== null)
          return { status: "archived" as const };
        if (row.keepLive !== input.keepLive) {
          await tx
            .update(schema.sessions)
            .set({ keepLive: input.keepLive })
            .where(
              and(
                eq(schema.sessions.workspaceId, input.workspaceId),
                eq(schema.sessions.id, input.sessionId),
              ),
            );
        }
        return {
          status: "updated" as const,
          retention: sessionRetentionFromRow({ ...row, keepLive: input.keepLive }),
        };
      }),
  );
}

/**
 * Seconds after Archive during which Undo returns the chat exactly as it was.
 */
export const SESSION_ARCHIVE_UNDO_SECONDS = 10;
/** Undo is accepted a little past the window, for the request's own latency. */
const SESSION_ARCHIVE_UNDO_GRACE_SECONDS = 3;
/**
 * Seconds after Archive when storing may start: only once Undo is no longer
 * accepted, so a late Undo never races the store. session_archive_candidates
 * in migration 1213 uses the same thirteen seconds.
 */
export const SESSION_ARCHIVE_STORE_AFTER_SECONDS =
  SESSION_ARCHIVE_UNDO_SECONDS + SESSION_ARCHIVE_UNDO_GRACE_SECONDS;

/**
 * Days a person's own message keeps a sub-chat "in use": a sub-chat someone
 * talks to directly is a chat they rely on (for example a long-running owner
 * an agent started), not a finished worker.
 */
export const SESSION_ARCHIVE_SUB_CHAT_IN_USE_DAYS = 14;

/** Why a sub-chat counts as in use (see {@link SessionArchiveBlocker}). */
export type SessionArchiveActiveReason = "running" | "waiting" | "goal" | "messaged";

/**
 * What keeps a chat live, so Archive refuses. Keep-live, a repeating
 * automation, a site sign-in and an import are on purpose and must be
 * removed first. `active_sub_chat` is a sub-chat still in use (running,
 * waiting for input, working on an active goal, or messaged by a person in
 * the last {@link SESSION_ARCHIVE_SUB_CHAT_IN_USE_DAYS} days): Archive would
 * stop it, so the caller must confirm each one by id.
 */
export type SessionArchiveBlocker =
  | {
      kind: "keep_live" | "scheduled_task" | "site_sign_in" | "imported";
      sessionId: string;
    }
  | {
      kind: "active_sub_chat";
      sessionId: string;
      title: string | null;
      reason: SessionArchiveActiveReason;
    };

export class SessionArchiveBlockedError extends Error {
  readonly code = "session_archive_blocked";
  constructor(readonly blockers: SessionArchiveBlocker[]) {
    super(sessionArchiveBlockedMessage(blockers));
    this.name = "SessionArchiveBlockedError";
  }
}

const ACTIVE_REASON_TEXT: Record<SessionArchiveActiveReason, string> = {
  running: "running",
  waiting: "waiting for input",
  goal: "working on a goal",
  messaged: "messaged by a person recently",
};

/** How many active sub-chats the refusal names one by one. */
const ACTIVE_SUB_CHATS_NAMED = 20;

/** One plain sentence per kind of blocker, saying what to change. */
export function sessionArchiveBlockedMessage(blockers: SessionArchiveBlocker[]): string {
  const active = blockers.filter((blocker) => blocker.kind === "active_sub_chat");
  const kinds = new Set(blockers.map((blocker) => blocker.kind));
  const reasons: string[] = [];
  if (kinds.has("keep_live"))
    reasons.push('"Keep this chat active" is on. Turn it off in the chat\'s Settings tab first.');
  if (kinds.has("scheduled_task"))
    reasons.push(
      "A scheduled task runs in this chat. Delete the task or let it start new chats first.",
    );
  if (kinds.has("site_sign_in"))
    reasons.push("A site sign-in keeps itself signed in through this chat. Remove it first.");
  if (kinds.has("imported")) reasons.push("Imported chats are already stored read-only.");
  if (active.length > 0) {
    const named = active
      .slice(0, ACTIVE_SUB_CHATS_NAMED)
      .map(
        (blocker) =>
          `${blocker.title?.trim() ? `"${blocker.title.trim()}"` : "Untitled chat"} (${blocker.sessionId}, ${ACTIVE_REASON_TEXT[blocker.reason]})`,
      );
    const more =
      active.length > ACTIVE_SUB_CHATS_NAMED
        ? `, and ${active.length - ACTIVE_SUB_CHATS_NAMED} more`
        : "";
    reasons.push(
      `${active.length} ${active.length === 1 ? "sub-chat is" : "sub-chats are"} still in use: ${named.join("; ")}${more}. ` +
        "Archiving would stop them along with this chat. To archive them too, repeat the request " +
        "with confirmActiveSubChats listing their ids; otherwise leave this chat as it is.",
    );
  }
  return `This chat can't be archived. ${reasons.join(" ")}`;
}

export class SessionArchiveFinalError extends Error {
  readonly code = "session_archive_final";
  constructor() {
    super(
      "This chat is archived and can no longer be restored. Start a new chat to continue its work.",
    );
    this.name = "SessionArchiveFinalError";
  }
}

/**
 * The chat is being moved to long-term storage right now, or the work its
 * Archive stopped is still settling; restoring waits for that.
 */
export class SessionArchiveBusyError extends Error {
  readonly code = "session_archive_busy";
  constructor(
    message = "This chat is being moved to long-term storage right now. Try restoring it again in a minute.",
  ) {
    super(message);
    this.name = "SessionArchiveBusyError";
  }
}

/** A sub-chat is restored with the archived chat that started it. */
export class SessionArchiveRestoreRootError extends Error {
  readonly code = "session_archive_restore_root";
  constructor(readonly rootSessionId: string) {
    super(
      `This chat was archived with the chat that started it. Restore that chat (${rootSessionId}) instead.`,
    );
    this.name = "SessionArchiveRestoreRootError";
  }
}

export type SessionArchiveRequest = {
  /** The chat and every sub-chat it started, all archived together. */
  sessionIds: string[];
  archivedAt: Date;
  /** Undo returns the chat as it was until this moment. */
  undoUntil: Date;
  /** Storing may start at this moment, once Undo is no longer accepted. */
  storeAfter: Date;
  /** The chat was archived already; nothing changed. */
  alreadyArchived: boolean;
};

async function lockSessionTree(
  tx: Database,
  scope: { workspaceId: string; sessionId: string },
): Promise<string[]> {
  const tree = await rawRows<{ id: string }>(
    tx,
    sql`with recursive tree(id) as (
        select ${scope.sessionId}::uuid
        union
        select child.id from sessions child join tree on child.parent_session_id = tree.id
        where child.workspace_id = ${scope.workspaceId}::uuid
      )
      select id from tree order by id`,
  );
  const sessionIds = tree.map((row) => row.id);
  await lockSessionEventWriteRows(tx, {
    workspaceId: scope.workspaceId,
    controlLock: "share",
    sessionIds,
  });
  return sessionIds;
}

/**
 * The sub-chats among `sessionIds` that are still in use, in a stable order:
 * running or holding running commands, waiting for input or an answer,
 * working on an active goal, or messaged directly by a person recently.
 */
async function readActiveSubChats(
  tx: Database,
  scope: { workspaceId: string; sessionIds: string[]; now: Date },
): Promise<Extract<SessionArchiveBlocker, { kind: "active_sub_chat" }>[]> {
  if (scope.sessionIds.length === 0) return [];
  const ids = sql.join(
    scope.sessionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const messagedSince = new Date(
    scope.now.getTime() - SESSION_ARCHIVE_SUB_CHAT_IN_USE_DAYS * 24 * 60 * 60 * 1_000,
  );
  const rows = await rawRows<{
    session_id: string;
    title: string | null;
    reason: SessionArchiveActiveReason | null;
  }>(
    tx,
    sql`select s.id as session_id, s.title,
        case
          when s.status not in ('idle', 'failed', 'cancelled') or s.active_turn_id is not null
            or exists (select 1 from session_turns t
              where t.workspace_id = s.workspace_id and t.session_id = s.id
                and t.status in ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity'))
            or exists (select 1 from session_background_commands b
              where b.workspace_id = s.workspace_id and b.session_id = s.id
                and b.state in ('running', 'stopping'))
            then 'running'
          when s.input_wait_until is not null
            or exists (select 1 from session_human_input_requests h
              where h.workspace_id = s.workspace_id and h.session_id = s.id and h.status = 'pending')
            then 'waiting'
          when exists (select 1 from session_goals g
              where g.workspace_id = s.workspace_id and g.session_id = s.id and g.status = 'active')
            then 'goal'
          -- A prompt a person sent directly (the same predicate as
          -- sessionTurnHumanPromptSql): not an agent, schedule or automation.
          when exists (select 1 from session_turns t
              where t.workspace_id = s.workspace_id and t.session_id = s.id
                and t.initiator_kind = 'subject' and t.source in ('user', 'api')
                and t.surface is distinct from 'agent'
                and t.created_at >= ${messagedSince.toISOString()}::timestamptz)
            then 'messaged'
        end as reason
      from sessions s
      where s.workspace_id = ${scope.workspaceId}::uuid and s.id in (${ids})
      order by s.created_at, s.id`,
  );
  return rows
    .filter((row) => row.reason !== null)
    .map((row) => ({
      kind: "active_sub_chat" as const,
      sessionId: row.session_id,
      title: row.title,
      reason: row.reason!,
    }));
}

/**
 * Archive a chat and its sub-chats for everyone: from now on they are listed
 * as archived, and once the undo window has passed and nothing runs in them,
 * the archiver moves their content to long-term storage and they become
 * read-only for good. Refuses with {@link SessionArchiveBlockedError} when
 * something keeps the chat live on purpose. Callers authorize session control
 * first; stopping the chat's running work is theirs too.
 */
export async function requestSessionArchive(
  db: Database,
  scope: SessionArchiveScope & {
    subjectId: string;
    /**
     * Sub-chats in use that the caller saw and chose to archive too. Archive
     * refuses while any sub-chat in use is not listed here.
     */
    confirmActiveSubChats?: readonly string[];
  },
  now: Date = new Date(),
): Promise<SessionArchiveRequest | null> {
  return await withSessionActivityRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const sessionIds = await lockSessionTree(tx, scope);
        const rows = await tx
          .select({
            id: schema.sessions.id,
            keepLive: schema.sessions.keepLive,
            imported: schema.sessions.importedArchiveImportId,
            archivedAt: schema.sessions.archivedAt,
            contentArchiveState: schema.sessions.contentArchiveState,
            parentSessionId: schema.sessions.parentSessionId,
          })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, scope.workspaceId),
              inArray(schema.sessions.id, sessionIds),
            ),
          );
        const root = rows.find((row) => row.id === scope.sessionId);
        // Sub-chats are archived with the chat that started them.
        if (!root || root.parentSessionId !== null) return null;
        if (root.archivedAt !== null || root.contentArchiveState !== null) {
          const archivedAt = root.archivedAt ?? now;
          return {
            sessionIds,
            archivedAt,
            undoUntil: new Date(archivedAt.getTime() + SESSION_ARCHIVE_UNDO_SECONDS * 1_000),
            storeAfter: new Date(
              archivedAt.getTime() + SESSION_ARCHIVE_STORE_AFTER_SECONDS * 1_000,
            ),
            alreadyArchived: true,
          };
        }
        const live = rows.filter((row) => row.contentArchiveState === null);
        const blockers: SessionArchiveBlocker[] = [];
        for (const row of live) {
          if (row.keepLive) blockers.push({ kind: "keep_live", sessionId: row.id });
          if (row.imported !== null) blockers.push({ kind: "imported", sessionId: row.id });
        }
        const liveIds = live.map((row) => row.id);
        if (liveIds.length > 0) {
          // The archiver's own rule, except one-time automations ("wake me
          // when", run or not), which are retired when the undo window ends
          // (see retireArchivedChatWaits). A private schedule another member
          // owns is not visible here; the archiver then waits for it instead.
          const ids = sql.join(
            liveIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          );
          const bound = await rawRows<{
            session_id: string;
            kind: "scheduled_task" | "site_sign_in";
          }>(
            tx,
            sql`select distinct task.reusable_session_id as session_id, 'scheduled_task' as kind
                from scheduled_tasks task
                left join scheduled_task_event_settings settings on settings.task_id = task.id
                where task.workspace_id = ${scope.workspaceId}::uuid and task.deleted_at is null
                  and task.reusable_session_id in (${ids})
                  and not (task.run_mode = 'existing_session' and (
                    settings.once
                    or (settings.task_id is null and task.schedule ->> 'type' = 'once')))
              union
              select distinct maintenance_session_id, 'site_sign_in'
                from site_auth_connections
                where workspace_id = ${scope.workspaceId}::uuid
                  and maintenance_session_id in (${ids})`,
          );
          for (const row of bound) blockers.push({ kind: row.kind, sessionId: row.session_id });
        }
        if (blockers.length === 0) {
          // Sub-chats still in use: stopping them must be a choice the
          // caller made after seeing which they are, not a side effect.
          const confirmed = new Set(scope.confirmActiveSubChats ?? []);
          const active = await readActiveSubChats(tx, {
            workspaceId: scope.workspaceId,
            sessionIds: liveIds.filter((id) => id !== scope.sessionId),
            now,
          });
          // Every one is named again, so one confirmation can cover them all.
          if (active.some((row) => !confirmed.has(row.sessionId))) blockers.push(...active);
        }
        if (blockers.length > 0) throw new SessionArchiveBlockedError(blockers);
        await tx
          .update(schema.sessions)
          .set({ archivedAt: now, archiveRequestedBy: scope.subjectId })
          .where(
            and(
              eq(schema.sessions.workspaceId, scope.workspaceId),
              inArray(schema.sessions.id, liveIds),
              isNull(schema.sessions.archivedAt),
            ),
          );
        return {
          sessionIds,
          archivedAt: now,
          undoUntil: new Date(now.getTime() + SESSION_ARCHIVE_UNDO_SECONDS * 1_000),
          storeAfter: new Date(now.getTime() + SESSION_ARCHIVE_STORE_AFTER_SECONDS * 1_000),
          alreadyArchived: false,
        };
      }),
  );
}

/**
 * Undo an Archive within its window: the chat and its sub-chats are live and
 * listed again, exactly as before. Throws {@link SessionArchiveFinalError}
 * once the window has passed or storing has begun. Returns false when the
 * chat was not archived (nothing to undo).
 */
export async function undoSessionArchive(
  db: Database,
  scope: SessionArchiveScope,
  now: Date = new Date(),
): Promise<boolean | null> {
  return await withSessionActivityRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const sessionIds = await lockSessionTree(tx, scope);
        const [root] = await tx
          .select({
            archivedAt: schema.sessions.archivedAt,
            contentArchiveState: schema.sessions.contentArchiveState,
          })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, scope.workspaceId),
              eq(schema.sessions.id, scope.sessionId),
            ),
          )
          .limit(1);
        if (!root) return null;
        if (root.contentArchiveState !== null) throw new SessionArchiveFinalError();
        if (root.archivedAt === null) return false;
        const windowEnds = root.archivedAt.getTime() + SESSION_ARCHIVE_STORE_AFTER_SECONDS * 1_000;
        if (now.getTime() > windowEnds) throw new SessionArchiveFinalError();
        // Only what this Archive marked: a sub-chat stored on its own stays so.
        await tx
          .update(schema.sessions)
          .set({ archivedAt: null, archiveRequestedBy: null })
          .where(
            and(
              eq(schema.sessions.workspaceId, scope.workspaceId),
              inArray(schema.sessions.id, sessionIds),
              eq(schema.sessions.archivedAt, root.archivedAt),
              isNull(schema.sessions.contentArchiveState),
            ),
          );
        return true;
      }),
  );
}

export type SessionUnarchiveResult = {
  /**
   * `undone`: within the undo window, exactly as before the Archive.
   * `restored`: nothing was stored yet, and the chats are live again.
   * `restoring`: some chats were in long-term storage; their content is put
   * back by {@link restoreArchivedSessionContent} (the others are live
   * already). `not_archived`: nothing to do.
   */
  outcome: "not_archived" | "undone" | "restored" | "restoring";
  /** The stored chats whose content is being restored. */
  restoringSessionIds: string[];
};

/**
 * Bring an archived chat back, at any time: within the undo window this is
 * the exact undo; after it, the chat and the sub-chats archived with it are
 * live again, and those already in long-term storage are queued for their
 * content to be restored from the stored bundle. Throws
 * {@link SessionArchiveBusyError} while one of them is being stored, and
 * {@link SessionArchiveRestoreRootError} for a sub-chat of an archived chat.
 * Callers authorize session control first and start the restore.
 */
export async function unarchiveSession(
  db: Database,
  scope: SessionArchiveScope,
  now: Date = new Date(),
): Promise<SessionUnarchiveResult | null> {
  try {
    const undone = await undoSessionArchive(db, scope, now);
    if (undone === null) return null;
    if (undone) return { outcome: "undone", restoringSessionIds: [] };
  } catch (error) {
    if (!(error instanceof SessionArchiveFinalError)) throw error;
  }
  return await withSessionActivityRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const sessionIds = await lockSessionTree(tx, scope);
        // Row locks too: the archiver's begin step locks the row before it
        // rechecks, so a chat is never stored and restored at once.
        const rows = await rawRows<{
          id: string;
          parent_session_id: string | null;
          root_session_id: string;
          archived: boolean;
          archived_with_root: boolean;
          content_archive_state: "archiving" | "archived" | null;
          stop_settling: boolean;
        }>(
          tx,
          sql`select s.id, s.parent_session_id, s.root_session_id,
              (s.archived_at is not null or s.content_archive_state is not null) as archived,
              s.archived_at is not null and s.archived_at = (
                select r.archived_at from sessions r
                where r.workspace_id = s.workspace_id and r.id = ${scope.sessionId}::uuid
              ) as archived_with_root,
              s.content_archive_state,
              s.status = 'cancelled' and s.active_turn_id is not null
                and s.direct_control_reason = ${SESSION_ARCHIVE_STOP_REASON} as stop_settling
            from sessions s
            where s.workspace_id = ${scope.workspaceId}::uuid
              and s.id in (${sql.join(
                sessionIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})
            order by s.id
            for no key update of s`,
        );
        const root = rows.find((row) => row.id === scope.sessionId);
        if (!root) return null;
        if (root.parent_session_id !== null) {
          const [top] = await rawRows<{ archived: boolean }>(
            tx,
            sql`select (archived_at is not null or content_archive_state is not null) as archived
              from sessions
              where workspace_id = ${scope.workspaceId}::uuid and id = ${root.root_session_id}::uuid`,
          );
          if (top?.archived) throw new SessionArchiveRestoreRootError(root.root_session_id);
        }
        if (!root.archived) return { outcome: "not_archived" as const, restoringSessionIds: [] };
        // The chat, and the sub-chats this same Archive took: a sub-chat
        // stored on its own earlier stays stored.
        const targets = rows.filter((row) => row.id === root.id || row.archived_with_root);
        if (targets.some((row) => row.content_archive_state === "archiving")) {
          throw new SessionArchiveBusyError();
        }
        // The work the Archive stopped is still settling: restoring now would
        // leave that chat cancelled. It settles within moments.
        if (targets.some((row) => row.stop_settling)) {
          throw new SessionArchiveBusyError(
            "This chat's work is still stopping. Try restoring it again in a moment.",
          );
        }
        const live = targets.filter((row) => row.content_archive_state === null).map((r) => r.id);
        const stored = targets
          .filter((row) => row.content_archive_state === "archived")
          .map((row) => row.id);
        if (live.length > 0) {
          await tx
            .update(schema.sessions)
            .set({ archivedAt: null, archiveRequestedBy: null })
            .where(
              and(
                eq(schema.sessions.workspaceId, scope.workspaceId),
                inArray(schema.sessions.id, live),
                isNull(schema.sessions.contentArchiveState),
              ),
            );
        }
        if (stored.length > 0) {
          await tx
            .update(schema.sessions)
            .set({ contentRestoreRequestedAt: now })
            .where(
              and(
                eq(schema.sessions.workspaceId, scope.workspaceId),
                inArray(schema.sessions.id, stored),
                eq(schema.sessions.contentArchiveState, "archived"),
              ),
            );
        }
        return {
          outcome: stored.length > 0 ? ("restoring" as const) : ("restored" as const),
          restoringSessionIds: stored,
        };
      }),
  );
}

/**
 * The chats in this chat's tree (itself included) that its Archive stopped
 * and that are live again. Archiving stops running work the way Cancel does,
 * with the archive as the reason: the chat and its sub-chats become
 * `cancelled`. Such a chat is cancelled only because it was archived, which
 * its last status change records. A chat still archived, or cancelled for
 * any other reason, is not one of them.
 */
function archiveStoppedSessionsSql(scope: SessionArchiveScope, onlyIds?: readonly string[]): SQL {
  return sql`with recursive tree(id) as (
      select id from sessions
      where workspace_id = ${scope.workspaceId}::uuid and id = ${scope.sessionId}::uuid
      union
      select child.id from sessions child join tree on child.parent_session_id = tree.id
      where child.workspace_id = ${scope.workspaceId}::uuid
    )
    select s.id, s.active_turn_id is not null as settling
    from sessions s join tree on tree.id = s.id
    where s.workspace_id = ${scope.workspaceId}::uuid
      and s.status = 'cancelled'
      and s.archived_at is null and s.content_archive_state is null
      and s.direct_control_reason = ${SESSION_ARCHIVE_STOP_REASON}
      ${
        onlyIds
          ? sql`and s.id in (${sql.join(
              onlyIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql``
      }
      and (
        select e.payload ->> 'reason' from session_events e
        where e.workspace_id = s.workspace_id and e.session_id = s.id
          and e.type = 'session.status.changed'
        order by e.sequence desc
        limit 1
      ) = ${SESSION_ARCHIVE_STOP_REASON}
    order by s.id`;
}

/**
 * Put the chats an Archive stopped back to idle once they are live again
 * (restored, or the Archive undone after it stopped them), so they take new
 * messages: each records an `idle` status change. The turn the Archive cut
 * off stays as it ended, which reads as interrupted. A chat whose stopped
 * turn is still settling is left for a later call and counted in `settling`.
 * The pause the Archive left is lifted separately, by a Resume (see
 * {@link listArchivePausedSessions}). Repeating a call changes nothing.
 */
export async function reopenArchiveStoppedSessions(
  db: Database,
  scope: SessionArchiveScope,
): Promise<{ reopened: Array<{ sessionId: string; eventIds: string[] }>; settling: number }> {
  return await withWorkspaceSessionActivityRls(db, scope.workspaceId, async (scoped) =>
    (scoped as unknown as Database).transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      const found = await rawRows<{ id: string; settling: boolean }>(
        tx,
        archiveStoppedSessionsSql(scope),
      );
      const ready = found.filter((row) => !row.settling).map((row) => row.id);
      const settling = found.length - ready.length;
      if (ready.length === 0) return { reopened: [], settling };
      const locks = await lockSessionEventWriteRows(tx, {
        rowProjection: "event",
        workspaceId: scope.workspaceId,
        controlLock: "none",
        sessionIds: ready,
      });
      // Checked again under the lock: only what is still true is changed.
      const confirmed = new Set(
        (
          await rawRows<{ id: string; settling: boolean }>(
            tx,
            archiveStoppedSessionsSql(scope, ready),
          )
        )
          .filter((row) => !row.settling)
          .map((row) => row.id),
      );
      const now = new Date();
      const reopened: Array<{ sessionId: string; eventIds: string[] }> = [];
      for (const session of locks.sessions) {
        if (!confirmed.has(session.id)) continue;
        const sequence = session.lastSequence + 1;
        const inserted = await tx
          .insert(schema.sessionEvents)
          .values(
            withLosslessContentWriteVersion(
              withBoundSessionEventPayloads([
                {
                  accountId: session.accountId,
                  workspaceId: scope.workspaceId,
                  sessionId: session.id,
                  sequence,
                  type: "session.status.changed",
                  payload: { status: "idle", reason: "restored" },
                  occurredAt: now,
                },
              ]),
              "payload",
              "payloadCodecVersion",
            ),
          )
          .returning({ id: schema.sessionEvents.id });
        await tx
          .update(schema.sessions)
          .set({ status: "idle", lastSequence: sequence, updatedAt: now })
          .where(
            and(
              eq(schema.sessions.workspaceId, scope.workspaceId),
              eq(schema.sessions.id, session.id),
            ),
          );
        reopened.push({ sessionId: session.id, eventIds: inserted.map((row) => row.id) });
      }
      return { reopened, settling };
    }),
  );
}

/**
 * The chats in this chat's tree still paused by an Archive although they are
 * live and no longer cancelled, topmost first: a Resume of each one (which
 * also lifts the pause below it) lets them run again. `pauseRevision` names
 * the pause, so a repeated Resume of the same one is recognised.
 */
export async function listArchivePausedSessions(
  db: Database,
  scope: SessionArchiveScope,
): Promise<Array<{ sessionId: string; pauseRevision: number }>> {
  const rows = await withWorkspaceSessionActivityRls(db, scope.workspaceId, async (scoped) =>
    rawRows<{ id: string; direct_pause_revision: string | number }>(
      scoped as unknown as Database,
      sql`with recursive tree(id) as (
          select id from sessions
          where workspace_id = ${scope.workspaceId}::uuid and id = ${scope.sessionId}::uuid
          union
          select child.id from sessions child join tree on child.parent_session_id = tree.id
          where child.workspace_id = ${scope.workspaceId}::uuid
        ),
        paused as (
          select s.id, s.parent_session_id, s.direct_pause_revision
          from sessions s join tree on tree.id = s.id
          where s.workspace_id = ${scope.workspaceId}::uuid
            and s.direct_control_state = 'paused'
            and s.direct_pause_revision is not null
            and s.direct_control_reason = ${SESSION_ARCHIVE_STOP_REASON}
            and s.status <> 'cancelled'
            and s.archived_at is null and s.content_archive_state is null
        )
        select p.id, p.direct_pause_revision from paused p
        where p.parent_session_id is null
          or p.parent_session_id not in (select id from paused)
        order by p.id`,
    ),
  );
  return rows.map((row) => ({
    sessionId: row.id,
    pauseRevision: Number(row.direct_pause_revision),
  }));
}

/**
 * The purged tables a restore puts back, in an order that satisfies their
 * foreign keys (the reverse of the purge order). Purged timeline events
 * (streamed fragments, request telemetry, startup timings, update
 * bookkeeping) are not put back: events can only be appended in sequence,
 * and nothing a chat needs to continue reads them.
 */
export const SESSION_ARCHIVE_RESTORE_TABLES = [...SESSION_ARCHIVE_PURGE_TABLES]
  .reverse()
  .filter(
    (table): table is Exclude<SessionArchivePurgeTable, "session_events"> =>
      table !== "session_events",
  );
export type SessionArchiveRestoreTable = (typeof SESSION_ARCHIVE_RESTORE_TABLES)[number];

/** A stored chat waiting to be restored: where its bundle is and what it must hash to. */
export type PendingSessionContentRestore = {
  bundle: SessionArchiveObject;
  sha256: string;
};

/** The stored bundle of a chat whose restore was requested, or null when there is none to do. */
export async function readPendingSessionContentRestore(
  db: Database,
  scope: SessionArchiveScope,
): Promise<PendingSessionContentRestore | null> {
  const [row] = await withRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) =>
      await scoped
        .select({
          state: schema.sessions.contentArchiveState,
          manifest: schema.sessions.contentArchive,
          requestedAt: schema.sessions.contentRestoreRequestedAt,
        })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, scope.workspaceId),
            eq(schema.sessions.id, scope.sessionId),
          ),
        )
        .limit(1),
  );
  if (!row || row.state !== "archived" || row.requestedAt === null) return null;
  const manifest = row.manifest as Partial<SessionArchiveManifest> | null;
  const bundle = manifest?.bundle;
  if (
    !bundle ||
    typeof bundle.key !== "string" ||
    typeof bundle.sha256 !== "string" ||
    typeof bundle.bytes !== "number" ||
    typeof manifest?.sha256 !== "string"
  ) {
    throw new Error("session archive manifest has no bundle to restore from");
  }
  return {
    bundle: { key: bundle.key, bytes: bundle.bytes, sha256: bundle.sha256 },
    sha256: manifest.sha256,
  };
}

/** Rows per insert statement, and the JSON text one statement carries at most. */
const RESTORE_BATCH_ROWS = 500;
const RESTORE_BATCH_CHARS = 8 * 1024 * 1024;

export type RestoreArchivedSessionContentResult =
  | { status: "restored"; rows: Record<SessionArchiveRestoreTable, number> }
  /** Nothing to restore: not stored, or no restore requested (done already). */
  | { status: "not_pending" }
  /** The stored manifest changed (a secret scrub swapped it); read it again. */
  | { status: "manifest_changed" };

/**
 * Put a stored chat's content back from its verified bundle and make it live
 * again, in one transaction: either every purged row is back and the chat is
 * live, or nothing changed. `rows(table)` yields the bundle's exact row JSON
 * for one table; rows still in the database are kept as they are. The chat's
 * stored objects are queued for deletion once it is live (migration 1261),
 * and a later Archive stores it again under new keys.
 */
export async function restoreArchivedSessionContent(
  db: Database,
  scope: SessionArchiveScope,
  input: {
    /** The manifest digest the bundle was verified against. */
    sha256: string;
    rows: (table: SessionArchiveRestoreTable) => AsyncIterable<string>;
  },
): Promise<RestoreArchivedSessionContentResult> {
  return await withSessionActivityRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await lockSessionEventWriteRows(tx, {
          workspaceId: scope.workspaceId,
          controlLock: "share",
          sessionIds: [scope.sessionId],
        });
        const [row] = await tx
          .select({
            state: schema.sessions.contentArchiveState,
            manifest: schema.sessions.contentArchive,
            requestedAt: schema.sessions.contentRestoreRequestedAt,
          })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, scope.workspaceId),
              eq(schema.sessions.id, scope.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        if (!row || row.state !== "archived" || row.requestedAt === null) {
          return { status: "not_pending" as const };
        }
        if ((row.manifest as { sha256?: unknown } | null)?.sha256 !== input.sha256) {
          return { status: "manifest_changed" as const };
        }
        // Marks this transaction as the restore of this one chat: the session
        // guard lets exactly this write leave the archived state.
        await tx.execute(
          sql`select set_config('opengeni.session_content_restore', ${scope.sessionId}, true)`,
        );
        await tx
          .update(schema.sessions)
          .set({
            contentArchiveState: null,
            contentArchiveStartedAt: null,
            contentArchivedAt: null,
            contentArchive: null,
            contentArchivePurgedAt: null,
            archivedAt: null,
            archiveRequestedBy: null,
            // From now on it marks the restore, which counts as activity.
            contentRestoreRequestedAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, scope.workspaceId),
              eq(schema.sessions.id, scope.sessionId),
            ),
          );
        await tx.execute(sql`select set_config('opengeni.session_content_restore', '', true)`);
        const counts = {} as Record<SessionArchiveRestoreTable, number>;
        for (const table of SESSION_ARCHIVE_RESTORE_TABLES) {
          counts[table] = await restoreTableRows(tx, scope, table, input.rows(table));
        }
        return { status: "restored" as const, rows: counts };
      }),
  );
}

/** Insert one table's bundle rows in bounded statements; returns how many were missing. */
async function restoreTableRows(
  tx: Database,
  scope: SessionArchiveScope,
  table: SessionArchiveRestoreTable,
  rows: AsyncIterable<string>,
): Promise<number> {
  let columns: string[] | null = null;
  let batch: string[] = [];
  let chars = 0;
  let inserted = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    columns ??= await restorableColumns(tx, table, batch[0]!);
    inserted += await insertRestoredRows(tx, scope, table, columns, batch);
    batch = [];
    chars = 0;
  };
  for await (const row of rows) {
    if (batch.length > 0 && chars + row.length > RESTORE_BATCH_CHARS) await flush();
    batch.push(row);
    chars += row.length;
    if (batch.length >= RESTORE_BATCH_ROWS) await flush();
  }
  await flush();
  return inserted;
}

/**
 * The columns to restore: the table's own writable columns that the bundle
 * carries. A column added after the bundle was written takes its default,
 * one dropped since is ignored, and generated columns are computed again.
 */
async function restorableColumns(
  tx: Database,
  table: SessionArchiveRestoreTable,
  sampleRow: string,
): Promise<string[]> {
  const rows = await rawRows<{ name: string }>(
    tx,
    sql`select a.attname as name
      from pg_catalog.pg_attribute a
      where a.attrelid = to_regclass(${table})
        and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
        and a.attname in (select json_object_keys(${sampleRow}::json))
      order by a.attnum`,
  );
  const names = rows.map((row) => row.name);
  if (!names.includes("workspace_id") || !names.includes("session_id")) {
    throw new Error(`session archive restore: ${table} rows carry no session scope`);
  }
  return names;
}

async function insertRestoredRows(
  tx: Database,
  scope: SessionArchiveScope,
  table: SessionArchiveRestoreTable,
  columns: string[],
  rows: string[],
): Promise<number> {
  const list = sql.join(
    columns.map((column) => sql.identifier(column)),
    sql`, `,
  );
  const own = sql`workspace_id = ${scope.workspaceId}::uuid and session_id = ${scope.sessionId}::uuid`;
  const [result] = await rawRows<{ total: number; own: number; inserted: number }>(
    tx,
    sql`with input as materialized (
        select ${list} from json_populate_recordset(null::${sql.identifier(table)}, ${`[${rows.join(",")}]`}::json)
      ), inserted as (
        insert into ${sql.identifier(table)} (${list})
        select ${list} from input where ${own}
        on conflict do nothing
        returning 1
      )
      select (select count(*) from input)::int as total,
        (select count(*) from input where ${own})::int as own,
        (select count(*) from inserted)::int as inserted`,
  );
  if (!result || result.total !== rows.length || result.own !== rows.length) {
    throw new Error(`session archive restore: ${table} bundle rows belong to another session`);
  }
  return result.inserted;
}

/**
 * A chat and its sub-chats (at any depth) with their archive state, for the
 * step after the undo window and for the archive pass. It follows parent
 * links from the given chat, so it also works for a sub-chat that was
 * archived on its own (for example under a chat that is stored already).
 */
export async function readSessionArchiveTree(
  db: Database,
  scope: { workspaceId: string; sessionId: string },
): Promise<
  Array<{
    id: string;
    archivedAt: Date | null;
    archiveRequestedBy: string | null;
    contentArchiveState: "archiving" | "archived" | null;
    /** Set on a stored chat waiting to be restored (and on a restored one). */
    contentRestoreRequestedAt: Date | null;
  }>
> {
  const rows = await withWorkspaceSessionActivityRls(db, scope.workspaceId, async (scoped) =>
    rawRows<{
      id: string;
      archived_at: Date | string | null;
      archive_requested_by: string | null;
      content_archive_state: "archiving" | "archived" | null;
      content_restore_requested_at: Date | string | null;
    }>(
      scoped as unknown as Database,
      sql`with recursive tree(id) as (
          select id from sessions
          where workspace_id = ${scope.workspaceId}::uuid and id = ${scope.sessionId}::uuid
          union
          select child.id from sessions child join tree on child.parent_session_id = tree.id
          where child.workspace_id = ${scope.workspaceId}::uuid
        )
        select session.id, session.archived_at, session.archive_requested_by,
          session.content_archive_state, session.content_restore_requested_at
        from sessions session join tree on tree.id = session.id
        where session.workspace_id = ${scope.workspaceId}::uuid`,
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
    archiveRequestedBy: row.archive_requested_by,
    contentArchiveState: row.content_archive_state,
    contentRestoreRequestedAt:
      row.content_restore_requested_at === null ? null : new Date(row.content_restore_requested_at),
  }));
}

/**
 * Whether any of these not-yet-stored chats still holds input it would act on
 * in a later turn: an undelivered update, an unanswered question or an input
 * wait. An archived chat never runs again, so this input keeps it from being
 * stored until its work is cancelled, which settles all three.
 */
export async function archivedSessionsHavePendingInput(
  db: Database,
  scope: { workspaceId: string; sessionIds: string[] },
): Promise<boolean> {
  if (scope.sessionIds.length === 0) return false;
  const ids = sql.join(
    scope.sessionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const [row] = await withWorkspaceSessionActivityRls(db, scope.workspaceId, async (scoped) =>
    rawRows<{ pending: boolean }>(
      scoped as unknown as Database,
      sql`select (
          exists (select 1 from sessions
            where workspace_id = ${scope.workspaceId}::uuid and id in (${ids})
              and input_wait_until is not null)
          or exists (select 1 from session_system_updates
            where workspace_id = ${scope.workspaceId}::uuid and session_id in (${ids})
              and state = 'pending')
          or exists (select 1 from session_human_input_requests
            where workspace_id = ${scope.workspaceId}::uuid and session_id in (${ids})
              and status = 'pending')
        ) as pending`,
    ),
  );
  return row?.pending === true;
}

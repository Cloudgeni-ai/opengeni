import type { SessionEvent, SessionEventType } from "@opengeni/contracts";
import { and, asc, eq, gt, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import {
  rawRows,
  withRlsContext,
  withSessionActivityRlsContext,
  withWorkspaceSessionActivityRls,
  type Database,
} from "./database";
import { fromPostgresLosslessJson } from "./lossless-json";
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
export type SessionArchiveExportTable = { table: string; keys: KeyColumn[] };

/**
 * Everything the bundle carries, in bundle order. Keyset columns follow an
 * index on (workspace_id, session_id, ...) for the large tables, so exporting a
 * very long session stays linear.
 */
export const SESSION_ARCHIVE_EXPORT_TABLES: readonly SessionArchiveExportTable[] = [
  { table: "session_turns", keys: [{ column: "position", cast: "bigint" }, uuidKey("id")] },
  {
    table: "session_turn_attempts",
    keys: [{ column: "turn_id", cast: "uuid" }, uuidKey("id")],
  },
  { table: "session_goals", keys: [uuidKey("id")] },
  { table: "session_goal_revisions", keys: [uuidKey("id")] },
  { table: "session_events", keys: [{ column: "sequence", cast: "integer" }] },
  {
    table: "session_history_items",
    keys: [{ column: "position", cast: "numeric" }, uuidKey("id")],
  },
  { table: "session_system_updates", keys: [{ column: "dedupe_key", cast: "text" }] },
  { table: "session_realtime_entries", keys: [uuidKey("id")] },
  {
    table: "session_attempt_codemode_calls",
    keys: [
      { column: "turn_id", cast: "uuid" },
      { column: "created_at", cast: "timestamptz" },
      uuidKey("operation_id"),
    ],
  },
  {
    table: "session_attempt_tool_catalogs",
    keys: [{ column: "turn_id", cast: "uuid" }, uuidKey("attempt_id")],
  },
  {
    table: "session_attempt_model_context_snapshots",
    keys: [{ column: "captured_at", cast: "timestamptz" }, uuidKey("attempt_id")],
  },
  { table: "session_content_blobs", keys: [{ column: "digest", cast: "text" }] },
  {
    table: "session_pending_tool_calls",
    keys: [{ column: "turn_id", cast: "uuid" }, uuidKey("id")],
  },
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
  archive: { state: "archiving" | "archived"; archivedAt: string | null } | null;
};

export function sessionRetentionFromRow(row: {
  keepLive: boolean;
  contentArchiveState: string | null;
  contentArchivedAt: Date | null;
}): SessionRetention {
  return {
    keepLive: row.keepLive,
    archive:
      row.contentArchiveState === "archiving" || row.contentArchiveState === "archived"
        ? {
            state: row.contentArchiveState,
            archivedAt: row.contentArchivedAt?.toISOString() ?? null,
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

export type UnfinishedSessionArchive = SessionArchiveScope & { state: "archiving" | "archived" };

export async function listUnfinishedSessionArchives(
  db: Database,
  input: { staleSeconds: number; limit: number },
): Promise<UnfinishedSessionArchive[]> {
  const rows = await rawRows<{
    account_id: string;
    workspace_id: string;
    session_id: string;
    state: "archiving" | "archived";
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
        const eligible = await rawRows<{ session_id: string }>(
          tx,
          sql`select session_id from opengeni_private.session_archive_candidates(
            ${Math.floor(input.idleSeconds)}, 1, ${scope.sessionId}::uuid)`,
        );
        if (eligible.length !== 1) return false;
        const updated = await tx
          .update(schema.sessions)
          .set({
            contentArchiveState: "archiving",
            contentArchiveStartedAt: new Date(),
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
  const keyColumns = spec.keys.map((key) => sql`t.${sql.identifier(key.column)}`);
  const order = sql.join(keyColumns, sql`, `);
  const keyText = sql.join(
    spec.keys.map(
      (key, index) => sql`t.${sql.identifier(key.column)}::text as ${sql.identifier(`k${index}`)}`,
    ),
    sql`, `,
  );
  let after: SQL = sql`true`;
  if (input.after) {
    const values = sql.join(
      spec.keys.map((key, index) => sql`${input.after![index]}::${sql.raw(key.cast)}`),
      sql`, `,
    );
    after = sql`(${order}) > (${values})`;
  }
  return await withRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId },
    async (scoped) => {
      const rows = await rawRows<Record<string, string>>(
        scoped,
        sql`select row_to_json(t)::text as row, ${keyText}
          from ${sql.identifier(spec.table)} t
          where t.workspace_id = ${scope.workspaceId}::uuid
            and t.session_id = ${scope.sessionId}::uuid
            and ${after}
          order by ${order}
          limit ${input.limit}`,
      );
      const lastRow = rows.at(-1);
      return {
        rows: rows.map((row) => row.row!),
        last: lastRow ? spec.keys.map((_, index) => lastRow[`k${index}`]!) : null,
      };
    },
  );
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
 */
export async function purgeArchivedSessionContent(
  db: Database,
  scope: SessionArchiveScope,
  input: { batchSize: number },
): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0;
  for (const table of SESSION_ARCHIVE_PURGE_TABLES) {
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
    if (count >= input.batchSize) return { deleted, complete: false };
  }
  if (deleted > 0) return { deleted, complete: false };
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
  return { deleted, complete: true };
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
        if (row.contentArchiveState !== null) return { status: "archived" as const };
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

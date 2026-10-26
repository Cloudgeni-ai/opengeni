import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

/**
 * Read-only chat share links (migration 0988). Every owner read and write runs
 * in the chat's workspace RLS context; the public read uses the share-link
 * lane, which names one share id in `opengeni.session_share_id` and sees only
 * that live row. Callers decide who may share; these functions keep one live
 * link per chat and person.
 */

export type SessionShareLinkScope = { accountId: string; workspaceId: string };

export type SessionShareLinkRecord = {
  id: string;
  shareId: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  createdBySubjectId: string;
  title: string;
  snapshot: unknown;
  snapshotThroughSequence: number;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
};

type Row = {
  id: string;
  share_id: string;
  account_id: string;
  workspace_id: string;
  session_id: string;
  created_by_subject_id: string;
  title: string;
  snapshot: unknown;
  snapshot_through_sequence: number;
  created_at: Date | string;
  updated_at: Date | string;
  revoked_at: Date | string | null;
};

const COLUMNS = sql.raw(
  "id, share_id, account_id, workspace_id, session_id, created_by_subject_id, title, snapshot, snapshot_through_sequence, created_at, updated_at, revoked_at",
);

/** The share ids this module writes and the lane accepts: base64url, 22-64 characters. */
export const SESSION_SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toRecord(row: Row): SessionShareLinkRecord {
  return {
    id: row.id,
    shareId: row.share_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    createdBySubjectId: row.created_by_subject_id,
    title: row.title,
    snapshot: typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot,
    snapshotThroughSequence: row.snapshot_through_sequence,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    revokedAt: row.revoked_at === null ? null : date(row.revoked_at),
  };
}

/**
 * Create this person's live link for a chat, or refresh its snapshot and title
 * when one exists (the link itself stays the same). `shareId` is used only
 * when a new link is created.
 */
export async function saveSessionShareLink(
  db: Database,
  scope: SessionShareLinkScope,
  input: {
    sessionId: string;
    createdBySubjectId: string;
    shareId: string;
    title: string;
    snapshot: unknown;
    snapshotThroughSequence: number;
  },
): Promise<{ link: SessionShareLinkRecord; created: boolean }> {
  if (!SESSION_SHARE_ID_PATTERN.test(input.shareId)) throw new Error("invalid share id");
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<Row & { created: boolean }>(
      tx,
      sql`insert into session_share_links (
          share_id, account_id, workspace_id, session_id, created_by_subject_id,
          title, snapshot, snapshot_through_sequence
        ) values (
          ${input.shareId}, ${scope.accountId}, ${scope.workspaceId}, ${input.sessionId},
          ${input.createdBySubjectId}, ${input.title}, ${JSON.stringify(input.snapshot)}::jsonb,
          ${input.snapshotThroughSequence}
        )
        on conflict (session_id, created_by_subject_id) where revoked_at is null
        do update set
          title = excluded.title,
          snapshot = excluded.snapshot,
          snapshot_through_sequence = excluded.snapshot_through_sequence,
          updated_at = now()
        returning ${COLUMNS}, (xmax = 0) as created`,
    );
    if (!row) throw new Error("share link was not saved");
    return { link: toRecord(row), created: row.created === true };
  });
}

/** This person's live link for a chat, if any. */
export async function getLiveSessionShareLink(
  db: Database,
  scope: SessionShareLinkScope,
  input: { sessionId: string; createdBySubjectId: string },
): Promise<SessionShareLinkRecord | null> {
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<Row>(
      tx,
      sql`select ${COLUMNS} from session_share_links
        where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}
          and created_by_subject_id = ${input.createdBySubjectId} and revoked_at is null`,
    );
    return row ? toRecord(row) : null;
  });
}

/** This person's live links in a workspace, newest first. */
export async function listLiveSessionShareLinks(
  db: Database,
  scope: SessionShareLinkScope,
  input: { createdBySubjectId: string; limit: number },
): Promise<SessionShareLinkRecord[]> {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit)));
  return await withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<Row>(
      tx,
      sql`select ${COLUMNS} from session_share_links
        where workspace_id = ${scope.workspaceId}
          and created_by_subject_id = ${input.createdBySubjectId} and revoked_at is null
        order by created_at desc, id
        limit ${limit}`,
    );
    return rows.map(toRecord);
  });
}

/** Stop this person's live link for a chat. Returns it, or null when there was none. */
export async function revokeSessionShareLink(
  db: Database,
  scope: SessionShareLinkScope,
  input: { sessionId: string; createdBySubjectId: string },
): Promise<SessionShareLinkRecord | null> {
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<Row>(
      tx,
      sql`update session_share_links set revoked_at = now(), updated_at = now()
        where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId}
          and created_by_subject_id = ${input.createdBySubjectId} and revoked_at is null
        returning ${COLUMNS}`,
    );
    return row ? toRecord(row) : null;
  });
}

/**
 * The live link a share id names, across every workspace (the share-link
 * lane). Only that row is visible; nothing else about any workspace is.
 */
export async function findLiveSessionShareLink(
  db: Database,
  shareId: string,
): Promise<SessionShareLinkRecord | null> {
  if (!SESSION_SHARE_ID_PATTERN.test(shareId)) return null;
  return await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`select set_config('opengeni.session_share_id', ${shareId}, true)`);
    const [row] = await rawRows<Row>(
      tx,
      sql`select ${COLUMNS} from session_share_links
        where share_id = ${shareId} and revoked_at is null`,
    );
    return row ? toRecord(row) : null;
  });
}

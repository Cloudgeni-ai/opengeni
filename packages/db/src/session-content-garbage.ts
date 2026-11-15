import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

/**
 * Delete session content blobs that no stored row refers to any more.
 *
 * A model-request snapshot is kept per attempt and replaced by each later
 * request of that attempt, and every request writes the body chunks the
 * session does not hold yet. Without collection the chunks only a replaced
 * snapshot named stay until the session is archived, which on long attempts is
 * most of what `session_content_blobs` holds. Collection is lossless: a blob
 * goes only when no snapshot or tool catalog of its session names it, it is
 * older than ten minutes, and the session's content lock is free (writers and
 * snapshot readers hold it shared; see `lockSessionContentShared`).
 *
 * Discovery and deletion are SECURITY DEFINER routines (migration 1359): the
 * worker cannot enumerate FORCE-RLS workspaces and the runtime may not delete
 * blobs itself. Until a migration grants them to the runtime, a pass collects
 * nothing.
 */
export const SESSION_CONTENT_GARBAGE_CANDIDATES_ROUTINE =
  "opengeni_private.session_content_garbage_candidates_v1(integer)";
export const COLLECT_SESSION_CONTENT_GARBAGE_ROUTINE =
  "opengeni_private.collect_session_content_garbage_v1(uuid, uuid, integer)";

export type SessionContentGarbageCandidate = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
};

export type SessionContentGarbageCollectionResult = {
  /** False while the deployment's database withholds the routines. */
  available: boolean;
  sessions: number;
  deleted: number;
  failed: number;
};

export async function sessionContentGarbageCollectionAvailable(db: Database): Promise<boolean> {
  const [row] = await rawRows<{ candidates: boolean | null; collect: boolean | null }>(
    db,
    sql`select
      has_function_privilege(to_regprocedure(${SESSION_CONTENT_GARBAGE_CANDIDATES_ROUTINE})::oid, 'EXECUTE') as candidates,
      has_function_privilege(to_regprocedure(${COLLECT_SESSION_CONTENT_GARBAGE_ROUTINE})::oid, 'EXECUTE') as collect`,
  );
  return row?.candidates === true && row?.collect === true;
}

export async function listSessionContentGarbageCandidates(
  db: Database,
  limit: number,
): Promise<SessionContentGarbageCandidate[]> {
  const rows = await rawRows<{ account_id: string; workspace_id: string; session_id: string }>(
    db,
    sql`select account_id, workspace_id, session_id
      from opengeni_private.session_content_garbage_candidates_v1(${limit})`,
  );
  return rows.map((row) => ({
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
  }));
}

/**
 * Delete up to `limit` unreferenced blobs of one session. Returns how many were
 * deleted; fewer than `limit` means the session is collected for now (0 also
 * when the session is busy, archived or out of scope, which records nothing).
 */
export async function collectSessionContentGarbage(
  db: Database,
  candidate: SessionContentGarbageCandidate,
  limit: number,
): Promise<number> {
  return await withRlsContext(
    db,
    { accountId: candidate.accountId, workspaceId: candidate.workspaceId },
    async (scoped) => {
      const [row] = await rawRows<{ deleted: number }>(
        scoped,
        sql`select opengeni_private.collect_session_content_garbage_v1(
          ${candidate.workspaceId}::uuid, ${candidate.sessionId}::uuid, ${limit}
        ) as deleted`,
      );
      return Number(row?.deleted ?? 0);
    },
  );
}

/**
 * One bounded collection pass over the sessions whose snapshots changed since
 * they were last collected, sessions never collected first. Each session is
 * collected in batches until it has nothing left or the deadline passes; a
 * failing session never aborts the pass and is retried by a later one.
 */
export async function collectSessionContentGarbagePass(
  db: Database,
  options: {
    deadline: number;
    now?: () => number;
    candidatesPerBatch?: number;
    blobsPerCall?: number;
    onSessionError?: (candidate: SessionContentGarbageCandidate, error: unknown) => void;
  },
): Promise<SessionContentGarbageCollectionResult> {
  const now = options.now ?? Date.now;
  const candidatesPerBatch = options.candidatesPerBatch ?? 100;
  const blobsPerCall = options.blobsPerCall ?? 2_000;
  const result: SessionContentGarbageCollectionResult = {
    available: false,
    sessions: 0,
    deleted: 0,
    failed: 0,
  };
  if (!(await sessionContentGarbageCollectionAvailable(db))) return result;
  result.available = true;
  // Candidates come back in collection order and leave the list once
  // collected, so each listing makes progress; a session that stays (busy or
  // failing) is not retried within the pass.
  const seen = new Set<string>();
  while (now() < options.deadline) {
    const listed = await listSessionContentGarbageCandidates(
      db,
      Math.min(1_000, candidatesPerBatch + seen.size),
    );
    const candidates = listed.filter((candidate) => !seen.has(candidate.sessionId));
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      if (now() >= options.deadline) break;
      seen.add(candidate.sessionId);
      result.sessions += 1;
      try {
        let deleted: number;
        do {
          deleted = await collectSessionContentGarbage(db, candidate, blobsPerCall);
          result.deleted += deleted;
        } while (deleted >= blobsPerCall && now() < options.deadline);
      } catch (error) {
        result.failed += 1;
        options.onSessionError?.(candidate, error);
      }
    }
  }
  return result;
}

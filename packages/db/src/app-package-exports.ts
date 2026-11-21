import { sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";

/**
 * Package files `app_export` stores in object storage for an agent to
 * download (docs/app-packages.md#export-file-cleanup). Each is recorded
 * before it is stored, with an expiry, and the API's sweeper deletes the
 * object and then its record once it expires. Rows hold a workspace's object
 * key only. Everything is read and written under the workspace's row-level
 * security, except `listDueAppPackageExports`, which lists due rows across
 * workspaces through a read-only policy outside any workspace context.
 */

/** A failed delete waits at least this long, doubling per attempt up to a day. */
const RETRY_BASE_SECONDS = 60;
const RETRY_MAX_SECONDS = 24 * 60 * 60;
/** A claimed row is held this long, so two sweepers don't delete the same object at once. */
const CLAIM_SECONDS = 300;

export async function recordAppPackageExport(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    objectKey: string;
    /** Seconds until it is swept; 24 hours by default. */
    ttlSeconds?: number;
  },
): Promise<{ id: string; expiresAt: Date }> {
  const ttl = Math.max(1, Math.trunc(input.ttlSeconds ?? 24 * 60 * 60));
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [row] = await rawRows<{ id: string; expires_at: Date | string }>(
      tx,
      sql`insert into app_package_exports (account_id, workspace_id, object_key, expires_at, next_attempt_at)
        values (${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.objectKey},
          now() + make_interval(secs => ${ttl}), now() + make_interval(secs => ${ttl}))
        returning id, expires_at`,
    );
    return { id: row!.id, expiresAt: new Date(row!.expires_at) };
  });
}

/**
 * The package an app was installed or last upgraded from (migration 1545),
 * or null for an app made here. Read without access checks: callers have
 * already opened the app as the person.
 */
export async function getAppPackageId(
  db: Database,
  workspaceId: string,
  appId: string,
): Promise<string | null> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const [row] = await rawRows<{ package_id: string | null }>(
      tx,
      sql`select package_id from workspace_artifacts
        where workspace_id = ${workspaceId}::uuid and id = ${appId}::uuid`,
    );
    return row?.package_id ?? null;
  });
}

/** Record the package an app came from (install, or an applied upgrade). */
export async function setAppPackageId(
  db: Database,
  workspaceId: string,
  appId: string,
  packageId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (tx) => {
    await tx.execute(
      sql`update workspace_artifacts set package_id = ${packageId}::uuid
        where workspace_id = ${workspaceId}::uuid and id = ${appId}::uuid
          and package_id is distinct from ${packageId}::uuid`,
    );
  });
}

export type DueAppPackageExport = {
  id: string;
  accountId: string;
  workspaceId: string;
};

/** Expired exports whose delete is due, across workspaces (ids only). */
export async function listDueAppPackageExports(
  db: Database,
  limit = 32,
): Promise<DueAppPackageExport[]> {
  const rows = await rawRows<{
    id: string;
    account_id: string;
    workspace_id: string;
  }>(
    db,
    sql`select id, account_id, workspace_id from app_package_exports
        where next_attempt_at <= now()
        order by next_attempt_at
        limit ${Math.max(1, Math.min(200, Math.trunc(limit)))}`,
  );
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
  }));
}

/**
 * Take one due export for deleting: its object key, or null when another
 * sweeper has it or it is gone. The claim holds it for a few minutes.
 */
export async function claimAppPackageExport(
  db: Database,
  input: { id: string; workspaceId: string },
): Promise<{ objectKey: string; attempts: number } | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [row] = await rawRows<{ object_key: string; attempts: number }>(
      tx,
      sql`update app_package_exports
          set next_attempt_at = now() + make_interval(secs => ${CLAIM_SECONDS}), attempts = attempts + 1
          where workspace_id = ${input.workspaceId}::uuid and id = ${input.id}::uuid
            and next_attempt_at <= now()
          returning object_key, attempts`,
    );
    return row ? { objectKey: row.object_key, attempts: Number(row.attempts) } : null;
  });
}

/**
 * After deleting the object: remove its record (no error), or keep it for a
 * later retry with exponential backoff and the error.
 */
export async function settleAppPackageExport(
  db: Database,
  input: {
    id: string;
    workspaceId: string;
    attempts: number;
    error?: string | null;
  },
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    if (!input.error) {
      await tx.execute(sql`delete from app_package_exports
        where workspace_id = ${input.workspaceId}::uuid and id = ${input.id}::uuid`);
      return;
    }
    const wait = Math.min(
      RETRY_MAX_SECONDS,
      RETRY_BASE_SECONDS * 2 ** Math.min(20, Math.max(0, input.attempts - 1)),
    );
    await tx.execute(sql`update app_package_exports
      set next_attempt_at = now() + make_interval(secs => ${wait}), last_error = ${input.error.slice(0, 2000)}
      where workspace_id = ${input.workspaceId}::uuid and id = ${input.id}::uuid`);
  });
}

/** A workspace's stored export keys, read before the workspace is deleted. */
export async function listAppPackageExportKeys(
  db: Database,
  workspaceId: string,
): Promise<string[]> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const rows = await rawRows<{ object_key: string }>(
      tx,
      sql`select object_key from app_package_exports where workspace_id = ${workspaceId}::uuid`,
    );
    return rows.map((row) => row.object_key);
  });
}

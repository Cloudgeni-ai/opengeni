import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, withWorkspaceRls, type Database } from "./database";

type Scope = { accountId: string; workspaceId: string };

/**
 * Where an app stored a connector's shared-account tool data: a collection
 * (`collection:<name>`) or its SQL database (`sql`). Reads of a marked target
 * need a workspace member who may use that connector themselves
 * (docs/app-server-code.md, "Stored tool data").
 */
export type SiteToolDataSource = {
  target: string;
  /** The connector's canonical server id, or `vault` for vault secrets. */
  connector: string;
  /** The account route the data came from (the connector when unknown). */
  route: string;
  /** The route is a workspace-shared account. */
  shared: boolean;
};

export const siteToolDataTarget = (kind: "collection" | "sql", name?: string): string =>
  kind === "sql" ? "sql" : `collection:${name}`;

/**
 * A reset removes only marks made at least this long before it: a write
 * that marked its target just before a reset may still land after it, so
 * such a mark stays. Writers mark right before each write (a sync before
 * each page, server code before each write call), so one page or call is
 * the window this covers.
 */
const SITE_TOOL_DATA_RESET_GRACE = sql.raw("interval '1 minute'");
export const SITE_TOOL_DATA_RESET_GRACE_MS = 60_000;

/**
 * Mark targets before the data is stored. Marks stay until a manager resets
 * the target, which removes them; a later write marks it again.
 * A write (`restart`) restarts an existing mark's time, so the reset grace is
 * measured from the mark just before that write. Keeping a mark for data
 * already stored (a sync edit) leaves its time alone, so a reset right after
 * still lifts it.
 */
export async function markSiteToolData(
  db: Database,
  scope: Scope,
  siteId: string,
  sources: readonly SiteToolDataSource[],
  options: { restart?: boolean } = {},
): Promise<void> {
  if (sources.length === 0) return;
  const onConflict = options.restart
    ? sql`on conflict (workspace_id, site_id, target, connector, route)
            do update set created_at = now()`
    : sql`on conflict do nothing`;
  await withRlsContext(db, scope, async (tx) => {
    for (const source of sources)
      await rawRows(
        tx,
        sql`insert into site_tool_data_sources
            (account_id, workspace_id, site_id, target, connector, route, shared)
          values (${scope.accountId}, ${scope.workspaceId}, ${siteId}, ${source.target},
            ${source.connector.slice(0, 256)}, ${source.route.slice(0, 256)}, ${source.shared})
          ${onConflict}`,
      );
  });
}

/** A manager reset a target's data: its earlier marks no longer count. */
export async function resetSiteToolData(
  db: Database,
  scope: Scope,
  siteId: string,
  target: string,
): Promise<void> {
  await withRlsContext(db, scope, async (tx) => {
    await rawRows(
      tx,
      sql`insert into site_tool_data_resets (account_id, workspace_id, site_id, target)
        values (${scope.accountId}, ${scope.workspaceId}, ${siteId}, ${target})
        on conflict (workspace_id, site_id, target) do update set reset_at = now()`,
    );
    // Removing the mark (not just timestamping it) lets any writer, including
    // a release that only inserts marks, mark the target again.
    await rawRows(
      tx,
      sql`delete from site_tool_data_sources
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId} and target = ${target}
          and created_at <= now() - ${SITE_TOOL_DATA_RESET_GRACE}`,
    );
  });
}

/**
 * The app's marked targets, plus each shared sync's target (from its
 * definition, so a sync saved by an earlier release counts before its next
 * run marks it; deleted ones too until their target is reset, since their
 * data stays).
 */
export async function listSiteToolDataSources(
  db: Database,
  scope: Scope,
  siteId: string,
): Promise<{
  marks: SiteToolDataSource[];
  sharedSyncActions: Array<{ action: unknown; deletedAt: Date | null }>;
  resets: Map<string, Date>;
}> {
  const { marks, resets } = await withRlsContext(db, scope, async (tx) => ({
    marks: await rawRows<{ target: string; connector: string; route: string; shared: boolean }>(
      tx,
      sql`select target, connector, route, shared from site_tool_data_sources
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
        limit 2000`,
    ),
    resets: await rawRows<{ target: string; reset_at: Date | string }>(
      tx,
      sql`select target, reset_at from site_tool_data_resets
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
        limit 2000`,
    ),
  }));
  // Read like the app's own sync list (listAppSyncTaskIds).
  const syncs = await withWorkspaceRls(db, scope.workspaceId, (tx) =>
    rawRows<{ action: unknown; deleted_at: Date | string | null }>(
      tx,
      sql`select action, deleted_at from scheduled_tasks
        where workspace_id = ${scope.workspaceId}::uuid
          and account_id = ${scope.accountId}::uuid
          and action ->> 'kind' = 'app_sync'
          and action ->> 'siteId' = ${siteId}
          and action ->> 'mode' = 'shared'
        limit 2000`,
    ),
  );
  return {
    marks: marks.map((row) => ({ ...row, shared: row.shared === true })),
    sharedSyncActions: syncs.map((row) => ({
      action: row.action,
      deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
    })),
    resets: new Map(resets.map((row) => [row.target, new Date(row.reset_at)])),
  };
}

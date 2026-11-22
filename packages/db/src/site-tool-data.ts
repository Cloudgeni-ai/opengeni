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
 * A reset clears only marks made at least this long before it: a write that
 * marked its target just before a reset may still land after it, so such a
 * mark keeps counting. Longer than any sync or server-code run.
 */
const SITE_TOOL_DATA_RESET_GRACE = sql.raw("interval '1 minute'");
export const SITE_TOOL_DATA_RESET_GRACE_MS = 60_000;

/**
 * Mark targets before the data is stored. Marks stay until a manager resets
 * the target; marking a target again after its reset refreshes the mark.
 */
export async function markSiteToolData(
  db: Database,
  scope: Scope,
  siteId: string,
  sources: readonly SiteToolDataSource[],
): Promise<void> {
  if (sources.length === 0) return;
  await withRlsContext(db, scope, async (tx) => {
    for (const source of sources)
      await rawRows(
        tx,
        sql`insert into site_tool_data_sources
            (account_id, workspace_id, site_id, target, connector, route, shared)
          values (${scope.accountId}, ${scope.workspaceId}, ${siteId}, ${source.target},
            ${source.connector.slice(0, 256)}, ${source.route.slice(0, 256)}, ${source.shared})
          on conflict (workspace_id, site_id, target, connector, route) do update
            set created_at = now()
            where exists (
              select 1 from site_tool_data_resets reset
              where reset.workspace_id = site_tool_data_sources.workspace_id
                and reset.site_id = site_tool_data_sources.site_id
                and reset.target = site_tool_data_sources.target
                and reset.reset_at - ${SITE_TOOL_DATA_RESET_GRACE} >= site_tool_data_sources.created_at)`,
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
  await withRlsContext(db, scope, (tx) =>
    rawRows(
      tx,
      sql`insert into site_tool_data_resets (account_id, workspace_id, site_id, target)
        values (${scope.accountId}, ${scope.workspaceId}, ${siteId}, ${target})
        on conflict (workspace_id, site_id, target) do update set reset_at = now()`,
    ),
  );
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
    // A mark from well before its target's latest reset no longer counts.
    marks: await rawRows<{ target: string; connector: string; route: string; shared: boolean }>(
      tx,
      sql`select mark.target, mark.connector, mark.route, mark.shared
        from site_tool_data_sources mark
        where mark.workspace_id = ${scope.workspaceId} and mark.site_id = ${siteId}
          and not exists (
            select 1 from site_tool_data_resets reset
            where reset.workspace_id = mark.workspace_id and reset.site_id = mark.site_id
              and reset.target = mark.target
              and reset.reset_at - ${SITE_TOOL_DATA_RESET_GRACE} >= mark.created_at)
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

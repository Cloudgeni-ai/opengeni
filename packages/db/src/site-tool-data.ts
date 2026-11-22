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

/** Mark targets before the data is stored; marks only grow. */
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
          on conflict do nothing`,
      );
  });
}

/**
 * The app's marked targets, plus each live shared sync's target (from its
 * definition, so a sync saved by an earlier release counts before its next
 * run marks it).
 */
export async function listSiteToolDataSources(
  db: Database,
  scope: Scope,
  siteId: string,
): Promise<{ marks: SiteToolDataSource[]; sharedSyncActions: unknown[] }> {
  const marks = await withRlsContext(db, scope, (tx) =>
    rawRows<{ target: string; connector: string; route: string; shared: boolean }>(
      tx,
      sql`select target, connector, route, shared from site_tool_data_sources
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
        limit 500`,
    ),
  );
  // Read like the app's own sync list (listAppSyncTaskIds).
  const syncs = await withWorkspaceRls(db, scope.workspaceId, (tx) =>
    rawRows<{ action: unknown }>(
      tx,
      sql`select action from scheduled_tasks
        where workspace_id = ${scope.workspaceId}::uuid
          and account_id = ${scope.accountId}::uuid
          and deleted_at is null
          and action ->> 'kind' = 'app_sync'
          and action ->> 'siteId' = ${siteId}
          and action ->> 'mode' = 'shared'
        limit 200`,
    ),
  );
  return {
    marks: marks.map((row) => ({ ...row, shared: row.shared === true })),
    sharedSyncActions: syncs.map((row) => row.action),
  };
}

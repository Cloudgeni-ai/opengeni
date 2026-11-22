import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  AppServerManifest,
  AppServerRun,
  AppServerTrigger,
  ToolGatewayIdentity,
} from "@opengeni/contracts";
import { rawRows, withRlsContext, withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

/**
 * App server code (migration 1550, docs/app-server-code.md): the runs log
 * and a version's server manifest. Every read and write runs under the
 * workspace's row-level security.
 */

type Scope = { accountId: string; workspaceId: string };

type RunRecord = {
  id: string;
  site_id: string;
  version_id: string;
  trigger: AppServerTrigger;
  target: string;
  status: "ok" | "error";
  http_status: number | null;
  duration_ms: number;
  error: string | null;
  logs: string;
  viewer_subject_id: string | null;
  created_at: Date | string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function toRun(record: RunRecord): AppServerRun {
  return {
    id: record.id,
    appId: record.site_id,
    versionId: record.version_id,
    trigger: record.trigger,
    target: record.target,
    status: record.status,
    httpStatus: record.http_status,
    durationMs: record.duration_ms,
    error: record.error,
    logs: record.logs,
    viewerSubjectId: record.viewer_subject_id,
    createdAt: new Date(record.created_at).toISOString(),
  };
}

const clip = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max));

export type AppServerRunInsert = {
  id: string;
  siteId: string;
  versionId: string;
  trigger: AppServerTrigger;
  target: string;
  status: "ok" | "error";
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
  logs: string;
  viewerSubjectId: string | null;
};

/** Record one run. Rows past the retention window for this app are pruned on the way. */
export async function recordAppServerRun(
  db: Database,
  scope: Scope,
  run: AppServerRunInsert,
  keptDays: number,
): Promise<void> {
  await withRlsContext(db, scope, async (tx) => {
    await rawRows(
      tx,
      sql`insert into app_server_runs (id, account_id, workspace_id, site_id, version_id, trigger,
          target, status, http_status, duration_ms, error, logs, viewer_subject_id)
        values (${run.id}, ${scope.accountId}, ${scope.workspaceId}, ${run.siteId}, ${run.versionId},
          ${run.trigger}, ${clip(run.target, 600)}, ${run.status},
          ${run.httpStatus !== null && run.httpStatus >= 100 && run.httpStatus <= 599 ? run.httpStatus : null},
          ${Math.max(0, Math.round(run.durationMs))},
          ${run.error === null ? null : clip(run.error, 2000)}, ${clip(run.logs, 8000)},
          ${run.viewerSubjectId})
        on conflict (id) do nothing`,
    );
    // Bounded: a few old rows per run at most, using the (workspace, site, created_at) index.
    await rawRows(
      tx,
      sql`delete from app_server_runs where id in (
          select id from app_server_runs
          where workspace_id = ${scope.workspaceId} and site_id = ${run.siteId}
            and created_at < now() - make_interval(days => ${keptDays})
          order by created_at limit 50)`,
    );
  });
}

/** Runs of one app, newest first. */
export async function listAppServerRuns(
  db: Database,
  scope: Scope,
  siteId: string,
  options: { limit: number; status?: "ok" | "error"; before?: string },
): Promise<AppServerRun[]> {
  if (!UUID.test(siteId)) return [];
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
  const before = options.before ? new Date(options.before) : null;
  return await withRlsContext(db, scope, async (tx) =>
    (
      await rawRows<RunRecord>(
        tx,
        sql`select id, site_id, version_id, trigger, target, status, http_status, duration_ms,
            error, logs, viewer_subject_id, created_at
          from app_server_runs
          where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
            ${options.status ? sql`and status = ${options.status}` : sql``}
            ${before && !Number.isNaN(before.getTime()) ? sql`and created_at < ${before.toISOString()}` : sql``}
          order by created_at desc, id desc
          limit ${limit}`,
      )
    ).map(toRun),
  );
}

/** Runs and errors of one app since `since`, and its newest error. */
export async function summarizeAppServerRuns(
  db: Database,
  scope: Scope,
  siteId: string,
  since: Date,
): Promise<{ runs: number; errors: number; lastError: { message: string; at: string } | null }> {
  if (!UUID.test(siteId)) return { runs: 0, errors: 0, lastError: null };
  return await withRlsContext(db, scope, async (tx) => {
    const [counts] = await rawRows<{ runs: number | string; errors: number | string }>(
      tx,
      sql`select count(*) as runs, count(*) filter (where status = 'error') as errors
        from app_server_runs
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
          and created_at >= ${since.toISOString()}`,
    );
    const [last] = await rawRows<{ error: string | null; created_at: Date | string }>(
      tx,
      sql`select error, created_at from app_server_runs
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
          and status = 'error' and created_at >= ${since.toISOString()}
        order by created_at desc limit 1`,
    );
    return {
      runs: Number(counts?.runs ?? 0),
      errors: Number(counts?.errors ?? 0),
      lastError: last
        ? { message: last.error ?? "Failed", at: new Date(last.created_at).toISOString() }
        : null,
    };
  });
}

/** How many runs one app started in the last minute (its rate window). */
export async function countRecentAppServerRuns(
  db: Database,
  scope: Scope,
  siteId: string,
): Promise<number> {
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{ count: number | string }>(
      tx,
      sql`select count(*) as count from app_server_runs
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
          and created_at > now() - interval '1 minute'`,
    );
    return Number(row?.count ?? 0);
  });
}

/** A version's server manifest, or null (no such version, or no server code). */
export async function getAppServerManifest(
  db: Database,
  workspaceId: string,
  siteId: string,
  versionId: string,
): Promise<AppServerManifest | null> {
  if (!UUID.test(siteId) || !UUID.test(versionId)) return null;
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ serverManifest: schema.workspaceArtifactVersions.serverManifest })
      .from(schema.workspaceArtifactVersions)
      .where(
        and(
          eq(schema.workspaceArtifactVersions.workspaceId, workspaceId),
          eq(schema.workspaceArtifactVersions.artifactId, siteId),
          eq(schema.workspaceArtifactVersions.id, versionId),
        ),
      )
      .limit(1);
    return row?.serverManifest ?? null;
  });
}

/** The server code an app currently serves, and on whose authority it runs. */
export type AppServerDeployment = {
  accountId: string;
  workspaceId: string;
  siteId: string;
  status: "active" | "archived";
  versionId: string;
  manifest: AppServerManifest | null;
  requestedTools: ToolGatewayIdentity[];
  /**
   * The person who made this version the current one (its latest publish or
   * rollback), else who created it: the code runs on their authority while
   * they still manage the app.
   */
  deployerSubjectId: string;
};

/**
 * The app's current version and its server code. With `versionId`, only
 * that version while it is still the current one (null otherwise), so a run
 * started for a version that was since replaced or rolled back stops.
 */
export async function getAppServerDeployment(
  db: Database,
  workspaceId: string,
  siteId: string,
  versionId?: string,
): Promise<AppServerDeployment | null> {
  if (!UUID.test(siteId) || (versionId !== undefined && !UUID.test(versionId))) return null;
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        accountId: schema.workspaceArtifacts.accountId,
        status: schema.workspaceArtifacts.status,
        versionId: schema.workspaceArtifactVersions.id,
        manifest: schema.workspaceArtifactVersions.serverManifest,
        requestedTools: schema.workspaceArtifactVersions.requestedTools,
        createdBySubjectId: schema.workspaceArtifactVersions.createdBySubjectId,
      })
      .from(schema.workspaceArtifacts)
      .innerJoin(
        schema.workspaceArtifactVersions,
        and(
          eq(schema.workspaceArtifactVersions.workspaceId, schema.workspaceArtifacts.workspaceId),
          eq(schema.workspaceArtifactVersions.artifactId, schema.workspaceArtifacts.id),
          eq(schema.workspaceArtifactVersions.id, schema.workspaceArtifacts.currentVersionId),
        ),
      )
      .where(
        and(
          eq(schema.workspaceArtifacts.workspaceId, workspaceId),
          eq(schema.workspaceArtifacts.id, siteId),
        ),
      )
      .limit(1);
    if (!row || (versionId !== undefined && row.versionId !== versionId)) return null;
    const [event] = await scopedDb
      .select({ actorSubjectId: schema.workspaceArtifactEvents.actorSubjectId })
      .from(schema.workspaceArtifactEvents)
      .where(
        and(
          eq(schema.workspaceArtifactEvents.workspaceId, workspaceId),
          eq(schema.workspaceArtifactEvents.artifactId, siteId),
          eq(schema.workspaceArtifactEvents.toVersionId, row.versionId),
          inArray(schema.workspaceArtifactEvents.type, ["published", "rolled_back"]),
        ),
      )
      .orderBy(desc(schema.workspaceArtifactEvents.createdAt))
      .limit(1);
    return {
      accountId: row.accountId,
      workspaceId,
      siteId,
      status: row.status,
      versionId: row.versionId,
      manifest: row.manifest ?? null,
      requestedTools: row.requestedTools ?? [],
      deployerSubjectId: event?.actorSubjectId ?? row.createdBySubjectId,
    };
  });
}

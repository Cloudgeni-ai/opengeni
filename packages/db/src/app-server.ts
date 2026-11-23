import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  AppServerManifest,
  AppServerRun,
  AppServerTrigger,
  ToolGatewayIdentity,
} from "@opengeni/contracts";
import {
  rawRows,
  withoutSessionRlsActor,
  withRlsContext,
  withWorkspaceRls,
  type Database,
} from "./database";
import * as schema from "./schema";

/**
 * App server code (migration 1554, docs/app-server-code.md): the runs log
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
  status: "running" | "ok" | "error";
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

export type AppServerRunStart = {
  id: string;
  siteId: string;
  versionId: string;
  trigger: AppServerTrigger;
  target: string;
  /** Who the run serves: `user:<subject>` or `guest:<visitor>`. */
  viewerSubjectId: string | null;
};

export type AppServerRunFinish = {
  id: string;
  siteId: string;
  status: "ok" | "error";
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
  logs: string;
};

/**
 * Start one run under the app's rate limits: at most `perApp` runs of the
 * app, and `perViewer` runs for one viewer, started in the last minute. The
 * run is inserted as `running`, so concurrent bursts count too; an advisory
 * lock per app makes the check and the insert one step.
 */
export async function startAppServerRun(
  db: Database,
  scope: Scope,
  run: AppServerRunStart,
  limits: { perApp: number; perViewer: number; perGuests: number },
): Promise<"started" | "app_limit" | "viewer_limit" | "guest_limit"> {
  return await withRlsContext(db, scope, async (tx) => {
    await rawRows(
      tx,
      sql`select pg_advisory_xact_lock(hashtextextended(${`app_server_runs:${run.siteId}`}, 0))`,
    );
    const [counts] = await rawRows<{
      app: number | string;
      viewer: number | string;
      guests: number | string;
    }>(
      tx,
      sql`select count(*) as app,
          count(*) filter (where viewer_subject_id is not distinct from ${run.viewerSubjectId}) as viewer,
          count(*) filter (where viewer_subject_id like 'guest:%') as guests
        from app_server_runs
        where workspace_id = ${scope.workspaceId} and site_id = ${run.siteId}
          and created_at > now() - interval '1 minute'`,
    );
    if (Number(counts?.app ?? 0) >= limits.perApp) return "app_limit";
    if (Number(counts?.viewer ?? 0) >= limits.perViewer) return "viewer_limit";
    if (
      run.viewerSubjectId?.startsWith("guest:") &&
      Number(counts?.guests ?? 0) >= limits.perGuests
    )
      return "guest_limit";
    await rawRows(
      tx,
      sql`insert into app_server_runs (id, account_id, workspace_id, site_id, version_id, trigger,
          target, status, duration_ms, viewer_subject_id)
        values (${run.id}, ${scope.accountId}, ${scope.workspaceId}, ${run.siteId}, ${run.versionId},
          ${run.trigger}, ${clip(run.target, 600)}, 'running', 0, ${run.viewerSubjectId})`,
    );
    return "started";
  });
}

/** End a run. Rows past the retention window in this workspace are pruned on the way. */
export async function finishAppServerRun(
  db: Database,
  scope: Scope,
  run: AppServerRunFinish,
  keptDays: number,
): Promise<void> {
  await withRlsContext(db, scope, async (tx) => {
    await rawRows(
      tx,
      sql`update app_server_runs set status = ${run.status},
          http_status = ${run.httpStatus !== null && run.httpStatus >= 100 && run.httpStatus <= 599 ? run.httpStatus : null},
          duration_ms = ${Math.max(0, Math.round(run.durationMs))},
          error = ${run.error === null ? null : clip(run.error, 2000)},
          logs = ${clip(run.logs, 8000)}
        where id = ${run.id} and workspace_id = ${scope.workspaceId} and site_id = ${run.siteId}
          and status = 'running'`,
    );
    // Bounded: a few old rows per run at most, using the (workspace, created_at) index.
    await rawRows(
      tx,
      sql`delete from app_server_runs where id in (
          select id from app_server_runs
          where workspace_id = ${scope.workspaceId}
            and created_at < now() - make_interval(days => ${keptDays})
          order by created_at limit 50)`,
    );
  });
}

/**
 * Count one call back to Opengeni against a live run: the run must be the
 * app's and version's, still `running` and inside its deadline, and under
 * `limit` calls. The API enforces this whatever the code does in its isolate.
 * Returns the run's viewer (recorded by the API at start) for per-call checks.
 */
export async function claimAppServerHostCall(
  db: Database,
  scope: Scope,
  call: { runId: string; siteId: string; versionId: string; limit: number; maxAgeMs: number },
): Promise<{ outcome: "ok" | "ended" | "limit"; viewerSubjectId: string | null }> {
  if (!UUID.test(call.runId)) return { outcome: "ended", viewerSubjectId: null };
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{ host_calls: number | string; viewer_subject_id: string | null }>(
      tx,
      sql`update app_server_runs set host_calls = host_calls + 1
        where id = ${call.runId} and workspace_id = ${scope.workspaceId}
          and site_id = ${call.siteId} and version_id = ${call.versionId}
          and status = 'running'
          and created_at > now() - make_interval(secs => ${call.maxAgeMs / 1000})
        returning host_calls, viewer_subject_id`,
    );
    if (!row) return { outcome: "ended", viewerSubjectId: null };
    return {
      outcome: Number(row.host_calls) > call.limit ? "limit" : "ok",
      viewerSubjectId: row.viewer_subject_id,
    };
  });
}

/** One run of an app, or null. */
export async function getAppServerRun(
  db: Database,
  scope: Scope,
  siteId: string,
  runId: string,
): Promise<AppServerRun | null> {
  if (!UUID.test(siteId) || !UUID.test(runId)) return null;
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<RunRecord>(
      tx,
      sql`select id, site_id, version_id, trigger, target, status, http_status, duration_ms,
          error, logs, viewer_subject_id, created_at
        from app_server_runs
        where id = ${runId} and workspace_id = ${scope.workspaceId} and site_id = ${siteId}`,
    );
    return row ? toRun(row) : null;
  });
}

/** Runs of one app, newest first. */
export async function listAppServerRuns(
  db: Database,
  scope: Scope,
  siteId: string,
  options: { limit: number; status?: "running" | "ok" | "error"; before?: string },
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

/** Runs and errors of one app since `since`, its newest error, and whether its newest finished run failed. */
export async function summarizeAppServerRuns(
  db: Database,
  scope: Scope,
  siteId: string,
  since: Date,
): Promise<{
  runs: number;
  errors: number;
  lastError: { message: string; at: string } | null;
  lastRunFailed: boolean;
}> {
  if (!UUID.test(siteId)) return { runs: 0, errors: 0, lastError: null, lastRunFailed: false };
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
    const [newest] = await rawRows<{ status: string }>(
      tx,
      sql`select status from app_server_runs
        where workspace_id = ${scope.workspaceId} and site_id = ${siteId} and status <> 'running'
        order by created_at desc, id desc limit 1`,
    );
    return {
      runs: Number(counts?.runs ?? 0),
      errors: Number(counts?.errors ?? 0),
      lastError: last
        ? { message: last.error ?? "Failed", at: new Date(last.created_at).toISOString() }
        : null,
      lastRunFailed: newest?.status === "error",
    };
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
   * they still manage the app. When an agent did it, this is the person whose
   * turn the agent was acting on, not the agent's own service subject.
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
  const found = await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
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
      .select({
        actorSubjectId: schema.workspaceArtifactEvents.actorSubjectId,
        sourceTurnId: schema.workspaceArtifactEvents.sourceTurnId,
      })
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
      deployment: {
        accountId: row.accountId,
        workspaceId,
        siteId,
        status: row.status,
        versionId: row.versionId,
        manifest: row.manifest ? { ...row.manifest, tools: row.manifest.tools ?? [] } : null,
        requestedTools: row.requestedTools ?? [],
        deployerSubjectId: event?.actorSubjectId ?? row.createdBySubjectId,
      } satisfies AppServerDeployment,
      sourceTurnId: event?.sourceTurnId ?? null,
    };
  });
  if (!found) return null;
  if (!found.sourceTurnId) return found.deployment;
  const person = await getSessionTurnPerson(db, workspaceId, found.sourceTurnId);
  return person ? { ...found.deployment, deployerSubjectId: person } : found.deployment;
}

/**
 * The person a turn acted for: an agent publishes with its worker's service
 * subject, which is never a member, so its code runs on the authority of the
 * person whose turn it was (still checked as a live manager on every run). A
 * turn without a person (a schedule, a key) has none, so the code stays
 * paused. Read without the caller's session actor: the turn may be in the
 * person's Only me chat, and only this subject leaves the function.
 */
export async function getSessionTurnPerson(
  db: Database,
  workspaceId: string,
  turnId: string,
): Promise<string | null> {
  return await withoutSessionRlsActor(() =>
    withWorkspaceRls(db, workspaceId, async (scopedDb) => {
      const [turn] = await scopedDb
        .select({
          initiatingHumanSubjectId: schema.sessionTurns.initiatingHumanSubjectId,
          initiatorKind: schema.sessionTurns.initiatorKind,
          initiatorSubjectId: schema.sessionTurns.initiatorSubjectId,
        })
        .from(schema.sessionTurns)
        .where(
          and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.id, turnId)),
        )
        .limit(1);
      return (
        turn?.initiatingHumanSubjectId ??
        (turn?.initiatorKind === "subject" ? turn.initiatorSubjectId : null)
      );
    }),
  );
}

import { sql } from "drizzle-orm";
import {
  AppSyncAction,
  AppSyncRunSummary,
  type AppSyncLastRun,
  type AppSyncRunSummary as AppSyncRunSummaryType,
} from "@opengeni/contracts";
import { rawRows, withWorkspaceRls, type Database } from "./database";

/**
 * App data sync persistence (docs/app-sync.md). A sync is an ordinary
 * scheduled task whose action is `app_sync`; this module keeps what only
 * syncs need: the executor queue, personal opt-ins and each person's last
 * run. Everything is read and written under the workspace's row-level
 * security, except `listDueAppSyncRuns`, which reads ids only.
 */

type Scope = { accountId: string; workspaceId: string };

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

function parseSummary(value: unknown): AppSyncRunSummaryType | null {
  if (!value || typeof value !== "object") return null;
  const parsed = AppSyncRunSummary.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Parse a stored action; null when it is not a well-formed sync. */
export function appSyncActionOf(action: unknown): AppSyncAction | null {
  if (!action || typeof action !== "object") return null;
  if ((action as { kind?: unknown }).kind !== "app_sync") return null;
  const parsed = AppSyncAction.safeParse(action);
  return parsed.success ? parsed.data : null;
}

/** The ids of a Site's live syncs, oldest first. */
export async function listAppSyncTaskIds(
  db: Database,
  scope: Scope,
  siteId: string,
): Promise<string[]> {
  return await withWorkspaceRls(db, scope.workspaceId, async (tx) => {
    const rows = await rawRows<{ id: string }>(
      tx,
      sql`select id from scheduled_tasks
          where workspace_id = ${scope.workspaceId}::uuid
            and account_id = ${scope.accountId}::uuid
            and deleted_at is null
            and action ->> 'kind' = 'app_sync'
            and action ->> 'siteId' = ${siteId}
          order by created_at, id
          limit 200`,
    );
    return rows.map((row) => row.id);
  });
}

function runStatus(status: string): AppSyncLastRun["status"] {
  if (status === "dispatched") return "running";
  if (status === "succeeded" || status === "failed" || status === "skipped" || status === "queued")
    return status;
  return "failed";
}

/** Each sync's newest run. */
export async function latestAppSyncRuns(
  db: Database,
  workspaceId: string,
  taskIds: readonly string[],
): Promise<Map<string, AppSyncLastRun>> {
  const result = new Map<string, AppSyncLastRun>();
  if (taskIds.length === 0) return result;
  const rows = await withWorkspaceRls(db, workspaceId, (tx) =>
    rawRows<{
      task_id: string;
      id: string;
      status: string;
      fired_at: Date | string;
      completed_at: Date | string | null;
      error: string | null;
      sync_summary: unknown;
    }>(
      tx,
      sql`select distinct on (task_id) task_id, id, status, fired_at, completed_at, error, sync_summary
          from scheduled_task_runs
          where workspace_id = ${workspaceId}::uuid
            and task_id in (${sql.join(
              taskIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
          order by task_id, fired_at desc, created_at desc`,
    ),
  );
  for (const row of rows)
    result.set(row.task_id, {
      runId: row.id,
      status: runStatus(row.status),
      at: iso(row.completed_at ?? row.fired_at),
      error: row.error,
      summary: parseSummary(row.sync_summary),
    });
  return result;
}

/** Queue a sync run for the executor; queuing the same run again does nothing. */
export async function enqueueAppSyncRun(
  db: Database,
  input: Scope & { taskId: string; runId: string },
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    await tx.execute(sql`insert into app_sync_queue (run_id, account_id, workspace_id, task_id)
      values (${input.runId}::uuid, ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.taskId}::uuid)
      on conflict (run_id) do nothing`);
  });
}

export type DueAppSyncRun = { runId: string; accountId: string; workspaceId: string };

/** Runs waiting for the executor across workspaces (ids only). */
export async function listDueAppSyncRuns(db: Database, limit = 16): Promise<DueAppSyncRun[]> {
  const rows = await rawRows<{ run_id: string; account_id: string; workspace_id: string }>(
    db,
    sql`select run_id, account_id, workspace_id from app_sync_queue
        where lease_until is null or lease_until < now()
        order by queued_at
        limit ${Math.max(1, Math.min(100, Math.trunc(limit)))}`,
  );
  return rows.map((row) => ({
    runId: row.run_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
  }));
}

export type ClaimedAppSyncRun = {
  runId: string;
  taskId: string;
  accountId: string;
  workspaceId: string;
  attempts: number;
  chainDepth: number;
  triggerType: string;
};

/**
 * Lease one queued run and mark it running. Null when another executor holds
 * it, it already finished, or it is no longer queued.
 */
export async function claimAppSyncRun(
  db: Database,
  input: { workspaceId: string; runId: string; leaseSeconds?: number },
): Promise<ClaimedAppSyncRun | null> {
  const leaseSeconds = Math.max(10, Math.trunc(input.leaseSeconds ?? 300));
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [claimed] = await rawRows<{ task_id: string; account_id: string; attempts: number }>(
      tx,
      sql`update app_sync_queue
          set lease_until = now() + make_interval(secs => ${leaseSeconds}), attempts = attempts + 1
          where run_id = ${input.runId}::uuid
            and workspace_id = ${input.workspaceId}::uuid
            and (lease_until is null or lease_until < now())
          returning task_id, account_id, attempts`,
    );
    if (!claimed) return null;
    const [run] = await rawRows<{
      status: string;
      chain_depth: number | string | null;
      trigger_type: string;
    }>(
      tx,
      sql`select status, chain_depth, trigger_type from scheduled_task_runs
          where workspace_id = ${input.workspaceId}::uuid and id = ${input.runId}::uuid`,
    );
    if (!run || (run.status !== "queued" && run.status !== "dispatched")) {
      await tx.execute(sql`delete from app_sync_queue where run_id = ${input.runId}::uuid`);
      return null;
    }
    if (run.status === "queued")
      await tx.execute(sql`update scheduled_task_runs set status = 'dispatched', updated_at = now()
        where workspace_id = ${input.workspaceId}::uuid and id = ${input.runId}::uuid and status = 'queued'`);
    return {
      runId: input.runId,
      taskId: claimed.task_id,
      accountId: claimed.account_id,
      workspaceId: input.workspaceId,
      attempts: Number(claimed.attempts),
      chainDepth: Math.max(0, Number(run.chain_depth ?? 0) || 0),
      triggerType: run.trigger_type,
    };
  });
}

/** Settle a sync run and remove it from the queue. False when it had already settled. */
export async function finishAppSyncRun(
  db: Database,
  input: {
    workspaceId: string;
    runId: string;
    status: "succeeded" | "failed" | "skipped";
    error: string | null;
    summary: AppSyncRunSummaryType | null;
  },
): Promise<boolean> {
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const updated = await rawRows<{ id: string }>(
      tx,
      sql`update scheduled_task_runs
          set status = ${input.status}, error = ${input.error?.slice(0, 2000) ?? null},
              sync_summary = ${input.summary ? JSON.stringify(input.summary) : null}::jsonb,
              completed_at = now(), updated_at = now()
          where workspace_id = ${input.workspaceId}::uuid and id = ${input.runId}::uuid
            and status in ('queued', 'dispatched')
          returning id`,
    );
    await tx.execute(sql`delete from app_sync_queue
      where workspace_id = ${input.workspaceId}::uuid and run_id = ${input.runId}::uuid`);
    return updated.length > 0;
  });
}

// --- personal opt-ins ---------------------------------------------------------

export type AppSyncSubscription = {
  taskId: string;
  subjectId: string;
  createdAt: string;
  lastRun: AppSyncLastRun | null;
};

type SubscriptionRow = {
  task_id: string;
  subject_id: string;
  created_at: Date | string;
  last_run_at: Date | string | null;
  last_status: string | null;
  last_error: string | null;
  last_summary: unknown;
};

function mapSubscription(row: SubscriptionRow): AppSyncSubscription {
  return {
    taskId: row.task_id,
    subjectId: row.subject_id,
    createdAt: iso(row.created_at),
    lastRun:
      row.last_run_at && row.last_status
        ? {
            runId: null,
            status: row.last_status === "succeeded" ? "succeeded" : "failed",
            at: iso(row.last_run_at),
            error: row.last_error,
            summary: parseSummary(row.last_summary),
          }
        : null,
  };
}

/** Opt a person in to (or out of) a personal sync. Returns whether they are opted in. */
export async function setAppSyncSubscription(
  db: Database,
  input: Scope & { taskId: string; subjectId: string; optedIn: boolean },
): Promise<boolean> {
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    if (input.optedIn)
      await tx.execute(sql`insert into app_sync_subscriptions (account_id, workspace_id, task_id, subject_id)
        values (${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.taskId}::uuid, ${input.subjectId})
        on conflict (workspace_id, task_id, subject_id) do nothing`);
    else
      await tx.execute(sql`delete from app_sync_subscriptions
        where workspace_id = ${input.workspaceId}::uuid and task_id = ${input.taskId}::uuid
          and subject_id = ${input.subjectId}`);
  });
  return input.optedIn;
}

/** Everyone opted in to one sync, oldest first. */
export async function listAppSyncSubscriptions(
  db: Database,
  workspaceId: string,
  taskId: string,
  limit = 200,
): Promise<AppSyncSubscription[]> {
  const rows = await withWorkspaceRls(db, workspaceId, (tx) =>
    rawRows<SubscriptionRow>(
      tx,
      sql`select task_id, subject_id, created_at, last_run_at, last_status, last_error, last_summary
          from app_sync_subscriptions
          where workspace_id = ${workspaceId}::uuid and task_id = ${taskId}::uuid
          order by created_at, subject_id
          limit ${Math.max(1, Math.trunc(limit))}`,
    ),
  );
  return rows.map(mapSubscription);
}

/** One person's opt-ins among these syncs, by sync. */
export async function getAppSyncSubscriptionsForSubject(
  db: Database,
  workspaceId: string,
  taskIds: readonly string[],
  subjectId: string,
): Promise<Map<string, AppSyncSubscription>> {
  const result = new Map<string, AppSyncSubscription>();
  if (taskIds.length === 0) return result;
  const rows = await withWorkspaceRls(db, workspaceId, (tx) =>
    rawRows<SubscriptionRow>(
      tx,
      sql`select task_id, subject_id, created_at, last_run_at, last_status, last_error, last_summary
          from app_sync_subscriptions
          where workspace_id = ${workspaceId}::uuid and subject_id = ${subjectId}
            and task_id in (${sql.join(
              taskIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`,
    ),
  );
  for (const row of rows) result.set(row.task_id, mapSubscription(row));
  return result;
}

/** How many people opted in to each sync. */
export async function countAppSyncSubscriptions(
  db: Database,
  workspaceId: string,
  taskIds: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (taskIds.length === 0) return result;
  const rows = await withWorkspaceRls(db, workspaceId, (tx) =>
    rawRows<{ task_id: string; count: number | string }>(
      tx,
      sql`select task_id, count(*) as count from app_sync_subscriptions
          where workspace_id = ${workspaceId}::uuid
            and task_id in (${sql.join(
              taskIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
          group by task_id`,
    ),
  );
  for (const row of rows) result.set(row.task_id, Number(row.count));
  return result;
}

/** Record one person's run of a personal sync. */
export async function recordAppSyncSubscriptionRun(
  db: Database,
  input: {
    workspaceId: string;
    taskId: string;
    subjectId: string;
    status: "succeeded" | "failed";
    error: string | null;
    summary: AppSyncRunSummaryType | null;
  },
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    await tx.execute(sql`update app_sync_subscriptions
      set last_run_at = now(), last_status = ${input.status},
          last_error = ${input.error?.slice(0, 2000) ?? null},
          last_summary = ${input.summary ? JSON.stringify(input.summary) : null}::jsonb
      where workspace_id = ${input.workspaceId}::uuid and task_id = ${input.taskId}::uuid
        and subject_id = ${input.subjectId}`);
  });
}

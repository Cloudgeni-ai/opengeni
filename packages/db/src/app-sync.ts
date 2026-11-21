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

/** How long a claimed run is held before another executor may take it over; runs renew it. */
export const APP_SYNC_LEASE_SECONDS = 300;

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

/**
 * Queue a sync run for the executor; queuing the same run again does nothing.
 * `chainDepth` is the run's automation chain depth when an automation's agent
 * started it (its run's depth plus one); scheduled and event runs keep the
 * depth recorded on the run itself.
 */
export async function enqueueAppSyncRun(
  db: Database,
  input: Scope & { taskId: string; runId: string; chainDepth?: number },
): Promise<void> {
  const depth = Math.max(1, Math.min(32767, Math.trunc(input.chainDepth ?? 1)));
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    await tx.execute(sql`insert into app_sync_queue (run_id, account_id, workspace_id, task_id, chain_depth)
      values (${input.runId}::uuid, ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.taskId}::uuid, ${depth})
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
  /** Another run of the same sync holds a live lease: this one must not run (overlap `skip`). */
  overlapping: boolean;
  /** This claim's lease token: renewing and settling need it (see `renewAppSyncLease`). */
  leaseToken: string;
};

/**
 * Lease one queued run and mark it running. Null when another executor holds
 * it, it already finished, or it is no longer queued. Claims of the same sync
 * are serialized, so of two runs of one sync only the first runs; the other
 * comes back `overlapping` while the first's lease is live.
 */
export async function claimAppSyncRun(
  db: Database,
  input: { workspaceId: string; runId: string; leaseSeconds?: number },
): Promise<ClaimedAppSyncRun | null> {
  const leaseSeconds = Math.max(10, Math.trunc(input.leaseSeconds ?? APP_SYNC_LEASE_SECONDS));
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [queued] = await rawRows<{ task_id: string }>(
      tx,
      sql`select task_id from app_sync_queue
          where run_id = ${input.runId}::uuid and workspace_id = ${input.workspaceId}::uuid`,
    );
    if (!queued) return null;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`app-sync:${queued.task_id}`}, 0))`,
    );
    const [claimed] = await rawRows<{
      task_id: string;
      account_id: string;
      attempts: number;
      chain_depth: number | string;
      lease_token: string;
    }>(
      tx,
      sql`update app_sync_queue
          set lease_until = now() + make_interval(secs => ${leaseSeconds}), attempts = attempts + 1,
              lease_token = gen_random_uuid()
          where run_id = ${input.runId}::uuid
            and workspace_id = ${input.workspaceId}::uuid
            and (lease_until is null or lease_until < now())
          returning task_id, account_id, attempts, chain_depth, lease_token`,
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
    const [other] = await rawRows<{ run_id: string }>(
      tx,
      sql`select run_id from app_sync_queue
          where workspace_id = ${input.workspaceId}::uuid and task_id = ${claimed.task_id}::uuid
            and run_id <> ${input.runId}::uuid and lease_until > now()
          limit 1`,
    );
    const chainDepth = Math.max(
      1,
      Number(run.chain_depth ?? 1) || 1,
      Number(claimed.chain_depth ?? 1) || 1,
    );
    if (run.status === "queued")
      await tx.execute(sql`update scheduled_task_runs set status = 'dispatched', updated_at = now()
        where workspace_id = ${input.workspaceId}::uuid and id = ${input.runId}::uuid and status = 'queued'`);
    if (chainDepth > (Number(run.chain_depth ?? 1) || 1))
      // The run history shows the depth too; the queue's copy is what counts.
      await tx
        .transaction(async (savepoint) => {
          await savepoint.execute(sql`update scheduled_task_runs set chain_depth = ${chainDepth}
            where workspace_id = ${input.workspaceId}::uuid and id = ${input.runId}::uuid`);
        })
        .catch(() => undefined);
    return {
      runId: input.runId,
      taskId: claimed.task_id,
      accountId: claimed.account_id,
      workspaceId: input.workspaceId,
      attempts: Number(claimed.attempts),
      chainDepth,
      triggerType: run.trigger_type,
      overlapping: other !== undefined,
      leaseToken: claimed.lease_token,
    };
  });
}

/**
 * A claim's fence: the lease token and attempt count it got. A claim by a
 * release without tokens leaves the token unchanged but still counts an
 * attempt, so both are checked.
 */
export type AppSyncLease = { leaseToken: string; attempts: number };

function leaseHeld(lease: AppSyncLease | undefined) {
  return lease
    ? sql`and lease_token = ${lease.leaseToken}::uuid and attempts = ${lease.attempts}`
    : sql``;
}

/**
 * Extend a running sync's lease, so a long run is not claimed again. False
 * when the run is gone or, given the claim's lease, another executor has
 * claimed it since: the caller must then stop calling the tool and writing,
 * and leave the run to the current holder.
 */
export async function renewAppSyncLease(
  db: Database,
  input: { workspaceId: string; runId: string; leaseSeconds?: number; lease?: AppSyncLease },
): Promise<boolean> {
  const leaseSeconds = Math.max(10, Math.trunc(input.leaseSeconds ?? APP_SYNC_LEASE_SECONDS));
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const rows = await rawRows<{ run_id: string }>(
      tx,
      sql`update app_sync_queue set lease_until = now() + make_interval(secs => ${leaseSeconds})
          where workspace_id = ${input.workspaceId}::uuid and run_id = ${input.runId}::uuid
            ${leaseHeld(input.lease)}
          returning run_id`,
    );
    return rows.length > 0;
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
    /** Settle only while this claim still holds the run; false (and nothing changes) otherwise. */
    lease?: AppSyncLease;
  },
): Promise<boolean> {
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    if (input.lease) {
      const held = await rawRows<{ run_id: string }>(
        tx,
        sql`select run_id from app_sync_queue
            where workspace_id = ${input.workspaceId}::uuid and run_id = ${input.runId}::uuid
              ${leaseHeld(input.lease)}
            for update`,
      );
      if (held.length === 0) return false;
    }
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
  /** The account (route server id) the person chose; null when they didn't. */
  account: string | null;
};

type SubscriptionRow = {
  task_id: string;
  subject_id: string;
  account_server_id: string | null;
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
    account: row.account_server_id ?? null,
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

/**
 * Opt a person in to (or out of) a personal sync, on the account they chose
 * (kept as it is when `account` is omitted). Returns whether they are opted in.
 */
export async function setAppSyncSubscription(
  db: Database,
  input: Scope & {
    taskId: string;
    subjectId: string;
    optedIn: boolean;
    account?: string | null;
  },
): Promise<boolean> {
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    if (input.optedIn)
      await tx.execute(sql`insert into app_sync_subscriptions (account_id, workspace_id, task_id, subject_id, account_server_id)
        values (${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.taskId}::uuid, ${input.subjectId}, ${input.account ?? null})
        on conflict (workspace_id, task_id, subject_id) do update
          set account_server_id = case when ${input.account === undefined} then app_sync_subscriptions.account_server_id
            else excluded.account_server_id end`);
    else
      await tx.execute(sql`delete from app_sync_subscriptions
        where workspace_id = ${input.workspaceId}::uuid and task_id = ${input.taskId}::uuid
          and subject_id = ${input.subjectId}`);
  });
  return input.optedIn;
}

/** Remove everyone's opt-in to a sync (its tool or target changed); returns how many. */
export async function clearAppSyncSubscriptions(
  db: Database,
  workspaceId: string,
  taskId: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const rows = await rawRows<{ subject_id: string }>(
      tx,
      sql`delete from app_sync_subscriptions
          where workspace_id = ${workspaceId}::uuid and task_id = ${taskId}::uuid
          returning subject_id`,
    );
    return rows.length;
  });
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
      sql`select task_id, subject_id, account_server_id, created_at, last_run_at, last_status, last_error, last_summary
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
      sql`select task_id, subject_id, account_server_id, created_at, last_run_at, last_status, last_error, last_summary
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

// --- keys a sync wrote (removeMissing) -----------------------------------------

/** The ledger's person for a shared sync's keys. */
export const APP_SYNC_SHARED_KEYS = "";

/**
 * Record that this run pass saw (and wrote) these keys, for one person of a
 * personal sync or `APP_SYNC_SHARED_KEYS`.
 */
export async function recordAppSyncKeys(
  db: Database,
  input: Scope & { taskId: string; subjectId: string; pass: string; keys: readonly string[] },
): Promise<void> {
  if (input.keys.length === 0) return;
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    for (let start = 0; start < input.keys.length; start += 500) {
      const chunk = input.keys.slice(start, start + 500);
      await tx.execute(sql`insert into app_sync_keys (account_id, workspace_id, task_id, subject_id, record_key, seen_pass)
        select ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.taskId}::uuid, ${input.subjectId}, key, ${input.pass}::uuid
        from unnest(${sql.raw("ARRAY[")}${sql.join(
          chunk.map((key) => sql`${key}`),
          sql`, `,
        )}${sql.raw("]::text[]")}) as key
        on conflict (workspace_id, task_id, subject_id, record_key) do update
          set seen_pass = excluded.seen_pass, seen_at = now()`);
    }
  });
}

/** Keys this sync wrote earlier that the pass didn't see, oldest first. */
export async function listMissingAppSyncKeys(
  db: Database,
  input: { workspaceId: string; taskId: string; subjectId: string; pass: string; limit: number },
): Promise<string[]> {
  const rows = await withWorkspaceRls(db, input.workspaceId, (tx) =>
    rawRows<{ record_key: string }>(
      tx,
      sql`select record_key from app_sync_keys
          where workspace_id = ${input.workspaceId}::uuid and task_id = ${input.taskId}::uuid
            and subject_id = ${input.subjectId} and seen_pass <> ${input.pass}::uuid
          order by seen_at, record_key
          limit ${Math.max(1, Math.trunc(input.limit))}`,
    ),
  );
  return rows.map((row) => row.record_key);
}

/** Forget keys whose records were removed. */
export async function deleteAppSyncKeys(
  db: Database,
  input: { workspaceId: string; taskId: string; subjectId: string; keys: readonly string[] },
): Promise<void> {
  if (input.keys.length === 0) return;
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    await tx.execute(sql`delete from app_sync_keys
      where workspace_id = ${input.workspaceId}::uuid and task_id = ${input.taskId}::uuid
        and subject_id = ${input.subjectId}
        and record_key in (${sql.join(
          input.keys.map((key) => sql`${key}`),
          sql`, `,
        )})`);
  });
}

/** Forget every key a sync wrote (it now writes somewhere else); returns how many. */
export async function clearAppSyncKeys(
  db: Database,
  workspaceId: string,
  taskId: string,
  subjectId?: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const rows = await rawRows<{ record_key: string }>(
      tx,
      sql`delete from app_sync_keys
          where workspace_id = ${workspaceId}::uuid and task_id = ${taskId}::uuid
            ${subjectId === undefined ? sql`` : sql`and subject_id = ${subjectId}`}
          returning record_key`,
    );
    return rows.length;
  });
}

// --- event runs ------------------------------------------------------------------

/**
 * For an event run: whose event sources fired it. `workspaceWide` when any
 * of its triggers is on a workspace source; otherwise `owners` are the
 * people whose own (private) sources fired it. Null for any other run.
 */
export async function appSyncRunEventSources(
  db: Database,
  workspaceId: string,
  runId: string,
): Promise<{ workspaceWide: boolean; owners: string[] } | null> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const rows = await rawRows<{ visibility: string; owner_subject_id: string | null }>(
      tx,
      sql`select source.visibility, source.owner_subject_id
          from scheduled_task_runs run
          join scheduled_task_event_occurrences occurrence
            on occurrence.workspace_id = run.workspace_id and occurrence.task_id = run.task_id
            and run.producer_key = 'scheduled-task-event:' || occurrence.id::text
          join event_triggers trigger
            on trigger.workspace_id = run.workspace_id and trigger.id = any(occurrence.trigger_ids)
          join event_sources source
            on source.workspace_id = trigger.workspace_id and source.id = trigger.source_id
          where run.workspace_id = ${workspaceId}::uuid and run.id = ${runId}::uuid
            and run.trigger_type = 'event'`,
    );
    if (rows.length === 0) return null;
    const owners = new Set<string>();
    let workspaceWide = false;
    for (const row of rows) {
      if (row.visibility === "workspace" || row.owner_subject_id === null) workspaceWide = true;
      else owners.add(row.owner_subject_id);
    }
    return { workspaceWide, owners: [...owners] };
  });
}

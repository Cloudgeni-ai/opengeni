import { sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";

/** Identity-only system inventory; all mutation is tenant-scoped and rechecked. */
export async function listExhaustedScheduledTasks(db: Database, limit = 32) {
  return rawRows<{ id: string; workspace_id: string }>(
    db,
    sql`select * from opengeni_private.list_exhausted_scheduled_tasks(${limit})`,
  );
}

/**
 * Pause only settled, truly exhausted work and enqueue external reconciliation.
 *
 * A final run that did not succeed is reviewed for its owner notice first
 * (`scheduled_task_blocker_reviews`, the inventory's own unreviewed test), so
 * retiring never hides a failed last run. A notice already sent stays: the
 * review is kept as `paused` with the retired schedule, never read as a
 * person's pause that withdraws it.
 */
export async function retireExhaustedScheduledTask(
  db: Database,
  workspaceId: string,
  taskId: string,
): Promise<boolean> {
  return withWorkspaceRls(db, workspaceId, async (scopedDb) =>
    scopedDb.transaction(async (tx) => {
      // Run admission uses the same task lock, so the pending-run test cannot
      // race a freshly accepted delivery. Edits are rechecked under that lock.
      await tx.execute(
        sql`select id from scheduled_tasks where workspace_id = ${workspaceId} and id = ${taskId} for update`,
      );
      const rows = await rawRows<{ id: string }>(
        tx as unknown as Database,
        sql`
      with retired as (
        update scheduled_tasks set status = 'paused', updated_at = now()
        where workspace_id = ${workspaceId} and id = ${taskId}
          and status = 'active' and deleted_at is null and scheduled_task_is_exhausted(id)
          and not exists (
            select 1
            from (
              select run.id, run.status from scheduled_task_runs run
              where run.workspace_id = ${workspaceId} and run.task_id = ${taskId}
                and run.account_id = scheduled_tasks.account_id
                and run.trigger_type = 'scheduled' and run.action_kind = 'agent_turn'
              order by run.created_at desc, run.id desc limit 1
            ) latest
            left join scheduled_task_blocker_reviews review
              on review.workspace_id = ${workspaceId} and review.task_id = ${taskId}
            where latest.status in ('succeeded', 'failed', 'skipped')
              and latest.id is distinct from review.reviewed_run_id
              and (latest.status <> 'succeeded' or review.state = 'notified'))
        returning id, account_id, workspace_id, temporal_schedule_id
      ), kept_notice as (
        update scheduled_task_blocker_reviews set state = 'paused', updated_at = now()
        where workspace_id = ${workspaceId} and task_id in (select id from retired)
          and state = 'notified'
      ), enqueued as (
        insert into scheduled_task_schedule_outbox(account_id, workspace_id, temporal_schedule_id, task_id)
        select account_id, workspace_id, temporal_schedule_id, id from retired
        on conflict (task_id) do update set id = gen_random_uuid(), created_at = now(), next_attempt_at = now()
      ) select id from retired`,
      );
      return rows.length === 1;
    }),
  );
}

export async function listScheduledTaskScheduleReconciliations(db: Database, limit = 32) {
  return rawRows<{
    id: string;
    task_id: string;
    workspace_id: string;
    temporal_schedule_id: string;
  }>(
    db,
    sql`select * from opengeni_private.list_scheduled_task_schedule_reconciliations(${limit})`,
  );
}

export async function acknowledgeScheduledTaskScheduleReconciliation(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, (scopedDb) =>
    scopedDb.execute(
      sql`delete from scheduled_task_schedule_outbox where workspace_id = ${workspaceId} and id = ${id}`,
    ),
  );
}

export async function deferScheduledTaskScheduleReconciliation(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, (scopedDb) =>
    scopedDb.execute(
      sql`update scheduled_task_schedule_outbox set next_attempt_at = now() + interval '1 minute' where workspace_id = ${workspaceId} and id = ${id}`,
    ),
  );
}

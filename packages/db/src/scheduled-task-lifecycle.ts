import { sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";

/** Identity-only system inventory; all mutation is tenant-scoped and rechecked. */
export async function listExhaustedScheduledTasks(db: Database, limit = 32) {
  return rawRows<{ id: string; workspace_id: string }>(
    db,
    sql`select * from opengeni_private.list_exhausted_scheduled_tasks(${limit})`,
  );
}

/** Pause only settled, truly exhausted work and enqueue external reconciliation. */
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
        returning id, account_id, workspace_id, temporal_schedule_id
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

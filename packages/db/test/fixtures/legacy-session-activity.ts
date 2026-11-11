import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database, type RlsContext } from "../../src/database";

/** Historical migration fixtures must speak the pre-xid writer protocol, not
 * call the current runtime against an intentionally withheld expand migration.
 * This is also the old-binary path exercised by the rolling compatibility test.
 */
export async function withLegacySessionActivityRlsContext<T>(
  db: Database,
  scope: RlsContext & { workspaceId: string },
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return withRlsContext(db, scope, async tx => {
    const [prior] = await rawRows<{ state: string; workspace: string }>(tx, sql`select
      coalesce(current_setting('opengeni.session_activity_gate_state',true),'') as state,
      coalesce(current_setting('opengeni.session_activity_gate_workspace_id',true),'') as workspace`);
    let succeeded = false;
    try {
      await tx.execute(sql`select
        set_config('opengeni.session_activity_gate_state','open',true),
        set_config('opengeni.session_activity_gate_workspace_id',${scope.workspaceId},true)`);
      const value = await fn(tx);
      await tx.execute(sql`select set_config('opengeni.session_activity_gate_state','preparing',true)`);
      await tx.execute(sql`set constraints all immediate`);
      await tx.execute(sql`set constraints sessions_activity_insert_commit_guard,sessions_activity_update_commit_guard deferred`);
      await tx.execute(sql`with gate as materialized (
        select set_config('opengeni.session_activity_gate_state','finalizing',true) as state
      ), pending as materialized (
        select id from sessions cross join gate where workspace_id=${scope.workspaceId}
          and activity_revision_pending_xid=pg_current_xact_id()::text::bigint
      ), advanced as (
        update workspace_session_activity_revisions set revision=revision+1
        where workspace_id=${scope.workspaceId} and exists(select 1 from pending) returning revision
      ), stamped as (
        update sessions s set activity_revision=a.revision,activity_revision_pending_xid=null
        from advanced a where s.workspace_id=${scope.workspaceId}
          and s.activity_revision_pending_xid=pg_current_xact_id()::text::bigint returning s.id
      ) select count(*) from stamped`);
      await tx.execute(sql`select set_config('opengeni.session_activity_gate_state','finalized',true)`);
      await tx.execute(sql`set constraints sessions_activity_insert_commit_guard,sessions_activity_update_commit_guard immediate`);
      await tx.execute(sql`set constraints sessions_activity_insert_commit_guard,sessions_activity_update_commit_guard deferred`);
      succeeded = true;
      return value;
    } finally {
      if (succeeded) await tx.execute(sql`select
        set_config('opengeni.session_activity_gate_state',${prior?.state ?? ""},true),
        set_config('opengeni.session_activity_gate_workspace_id',${prior?.workspace ?? ""},true)`);
    }
  });
}

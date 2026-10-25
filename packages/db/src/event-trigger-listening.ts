import { sql, type SQL } from "drizzle-orm";

/**
 * Whether a runnable automation listens to a source (or, given a stream key,
 * to one stream of it): an active or blocked trigger (a blocked one waits for
 * the source to recover) on an active, undeleted, unfinished automation whose
 * owner may use the active source. Subscriptions and feeds exist only while
 * this holds.
 */
export function automationsListenTo(
  workspaceId: string,
  sourceId: SQL,
  streamKey: SQL | null = null,
): SQL {
  return sql`exists (
    select 1 from event_triggers trigger
    join scheduled_tasks task
      on task.id = trigger.task_id and task.workspace_id = trigger.workspace_id
    join scheduled_task_event_settings settings
      on settings.task_id = trigger.task_id and settings.workspace_id = trigger.workspace_id
    join event_sources source
      on source.id = trigger.source_id and source.workspace_id = trigger.workspace_id
    where trigger.workspace_id = ${workspaceId} and trigger.source_id = ${sourceId}
      ${streamKey === null ? sql`` : sql`and trigger.stream_key = ${streamKey}`}
      and trigger.status in ('active', 'blocked')
      and task.status = 'active' and task.deleted_at is null and settings.completed_at is null
      and source.status = 'active'
      and (source.visibility = 'workspace' or source.owner_subject_id is null
        or source.owner_subject_id = task.owner_subject_id))`;
}

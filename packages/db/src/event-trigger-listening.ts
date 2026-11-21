import { sql, type SQL } from "drizzle-orm";

/**
 * Whether the automation `task` may hear the event source `source`: a
 * workspace source, or a private one of the automation's owner. An App data
 * sync keeps its owner (the person whose connection a shared sync runs on)
 * in its action, so its owner's private sources reach it too.
 */
export const AUTOMATION_HEARS_SOURCE =
  sql.raw(`(source.visibility = 'workspace' or source.owner_subject_id is null
        or source.owner_subject_id = task.owner_subject_id
        or (task.action ->> 'kind' = 'app_sync'
          and source.owner_subject_id = task.action ->> 'ownerSubjectId'))`);

/**
 * Private source kinds that are each person's own copy of the same thing
 * (their Gmail, their GitHub connection), so a personal sync's trigger on its
 * owner's one stands for every subscriber's.
 */
export const PERSONAL_SYNC_SUBSCRIBER_SOURCE_KINDS = ["gmail", "github_personal"] as const;

/**
 * Whether the trigger (aliases `trigger`, `task`, `source` = the trigger's
 * source) hears events of the source `firedSourceId`: its own source, when
 * its automation may hear it, or, for a personal app sync whose trigger names
 * its owner's private Gmail or GitHub (your connection) source, the same
 * kind of private source of a person opted in to that sync. Such a run is
 * only for the person whose source fired (appSyncRunEventSources).
 */
export function triggerHearsSource(firedSourceId: SQL, options: { activeOnly?: boolean } = {}) {
  const kinds = sql.raw(
    PERSONAL_SYNC_SUBSCRIBER_SOURCE_KINDS.map((kind) => `'${kind}'`).join(", "),
  );
  // The sources such a trigger can name, first, so the lookup stays on the
  // (workspace_id, source_id) index: the fired one, and the same kind of
  // private source of each owner of a sync the fired source's owner joined.
  return sql`(trigger.source_id in (
      select ${firedSourceId}
      union all
      select owned.id from event_sources fired
      join app_sync_subscriptions subscriber
        on subscriber.workspace_id = fired.workspace_id
        and subscriber.subject_id = fired.owner_subject_id
      join scheduled_tasks synced
        on synced.workspace_id = subscriber.workspace_id and synced.id = subscriber.task_id
      join event_sources owned
        on owned.workspace_id = fired.workspace_id and owned.kind = fired.kind
        and owned.visibility = 'private'
        and owned.owner_subject_id = synced.action ->> 'ownerSubjectId'
      where fired.id = ${firedSourceId}
        and fired.kind in (${kinds}) and fired.visibility = 'private')
    and ((trigger.source_id = ${firedSourceId}
      ${options.activeOnly ? sql`and source.status = 'active'` : sql``}
      and ${AUTOMATION_HEARS_SOURCE})
    or (trigger.source_id <> ${firedSourceId}
      and task.action ->> 'kind' = 'app_sync' and task.action ->> 'mode' = 'personal'
      and source.kind in (${kinds}) and source.visibility = 'private'
      and source.owner_subject_id = task.action ->> 'ownerSubjectId'
      and exists (
        select 1 from event_sources fired
        join app_sync_subscriptions subscriber
          on subscriber.workspace_id = fired.workspace_id and subscriber.task_id = task.id
          and subscriber.subject_id = fired.owner_subject_id
        where fired.workspace_id = trigger.workspace_id and fired.id = ${firedSourceId}
          and fired.kind = source.kind and fired.visibility = 'private'
          and fired.status = 'active'))))`;
}

/**
 * Whether a runnable automation listens to a source (or, given a stream key,
 * to one stream of it): an active or blocked trigger (a blocked one waits for
 * the source to recover) on an active, undeleted, unfinished automation whose
 * owner may use the active source (or a personal sync's subscriber's own
 * source, see triggerHearsSource). Subscriptions and feeds exist only while
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
    where trigger.workspace_id = ${workspaceId}
      ${streamKey === null ? sql`` : sql`and trigger.stream_key = ${streamKey}`}
      and trigger.status in ('active', 'blocked')
      and task.status = 'active' and task.deleted_at is null and settings.completed_at is null
      and ${triggerHearsSource(sourceId, { activeOnly: true })})`;
}

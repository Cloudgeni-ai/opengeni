import { sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";
import { fromPostgresLosslessJson } from "./lossless-json";

/**
 * Credential-free `tool.auth_needed` facts recorded by one scheduled run's own
 * turn (`session_turns.scheduled_task_run_id`). Later human follow-ups in the
 * same session, goal continuations, and other runs of a reusable session are
 * not the run's turn and are never attributed to it.
 */
export type ScheduledTaskRunAuthNeededEvent = {
  runId: string;
  payload: unknown;
  occurredAt: string;
};

/** Per turn bound: enough to name every failing connector, never a full replay. */
export const SCHEDULED_TASK_RUN_AUTH_NEEDED_EVENTS_PER_TURN = 32;

type EventRow = {
  run_id: string;
  payload: unknown;
  payload_codec_version: number | null;
  occurred_at: Date | string;
};

function eventFromRow(row: EventRow): ScheduledTaskRunAuthNeededEvent {
  return {
    runId: row.run_id,
    payload: fromPostgresLosslessJson(row.payload, row.payload_codec_version),
    occurredAt:
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : new Date(row.occurred_at).toISOString(),
  };
}

/**
 * The scheduled-run turn's current, non-duplicate `tool.auth_needed` events.
 * Uses the unique run->turn index and the (workspace, turn, type) event index.
 */
export async function listScheduledTaskRunAuthNeededEvents(
  db: Database,
  workspaceId: string,
  runIds: readonly string[],
): Promise<ScheduledTaskRunAuthNeededEvent[]> {
  const ids = [...new Set(runIds)];
  if (ids.length === 0) return [];
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await rawRows<EventRow>(
      scopedDb,
      sql`
        select turn.scheduled_task_run_id as run_id,
          event.payload,
          event.payload_codec_version,
          event.occurred_at
        from session_turns turn
        cross join lateral (
          select candidate.payload, candidate.payload_codec_version,
            candidate.occurred_at, candidate.sequence
          from session_events candidate
          where candidate.workspace_id = turn.workspace_id
            and candidate.turn_id = turn.id
            and candidate.type = 'tool.auth_needed'
            and candidate.duplicate_of_event_id is null
            and (candidate.turn_association is null or candidate.turn_association = 'current')
          order by candidate.sequence
          limit ${SCHEDULED_TASK_RUN_AUTH_NEEDED_EVENTS_PER_TURN}
        ) event
        where turn.workspace_id = ${workspaceId}::uuid
          and turn.scheduled_task_run_id in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
        order by turn.scheduled_task_run_id, event.sequence
      `,
    );
    return rows.map(eventFromRow);
  });
}

export type ScheduledTaskAccessAttentionEvent = ScheduledTaskRunAuthNeededEvent & {
  taskId: string;
  taskName: string;
  firedAt: string;
};

/**
 * `tool.auth_needed` events of each active agent task's latest run that has a
 * turn, for the tasks this subject owns (and, when `includeOwnerless`, tasks
 * without an owner). A newer run whose turn recorded no such event clears the
 * task, because only the newest run with a turn is considered.
 */
export async function listScheduledTaskAccessAttentionEvents(
  db: Database,
  workspaceId: string,
  input: { subjectId: string; includeOwnerless: boolean; taskLimit: number },
): Promise<ScheduledTaskAccessAttentionEvent[]> {
  const taskLimit = Math.max(1, Math.min(500, Math.floor(input.taskLimit)));
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await rawRows<
      EventRow & { task_id: string; task_name: string; fired_at: Date | string }
    >(
      scopedDb,
      sql`
        with owned as (
          select task.id, task.name, task.workspace_id
          from scheduled_tasks task
          where task.workspace_id = ${workspaceId}::uuid
            and task.deleted_at is null
            and task.status = 'active'
            and task.action ->> 'kind' = 'agent_turn'
            and (
              task.owner_subject_id = ${input.subjectId}
              or (${input.includeOwnerless} and task.owner_subject_id is null)
            )
        ),
        latest as (
          select owned.id as task_id, owned.name as task_name, run.id as run_id,
            run.fired_at, run.turn_id, owned.workspace_id
          from owned
          cross join lateral (
            select candidate.id, candidate.fired_at, turn.id as turn_id
            from scheduled_task_runs candidate
            join session_turns turn
              on turn.workspace_id = candidate.workspace_id
              and turn.scheduled_task_run_id = candidate.id
            where candidate.workspace_id = owned.workspace_id
              and candidate.task_id = owned.id
            order by candidate.created_at desc, candidate.id desc
            limit 1
          ) run
        ),
        failing as (
          select latest.*
          from latest
          where exists (
            select 1 from session_events event
            where event.workspace_id = latest.workspace_id
              and event.turn_id = latest.turn_id
              and event.type = 'tool.auth_needed'
              and event.duplicate_of_event_id is null
              and (event.turn_association is null or event.turn_association = 'current')
          )
          order by latest.fired_at desc, latest.task_id
          limit ${taskLimit}
        )
        select failing.task_id, failing.task_name, failing.run_id, failing.fired_at,
          event.payload, event.payload_codec_version, event.occurred_at
        from failing
        cross join lateral (
          select candidate.payload, candidate.payload_codec_version,
            candidate.occurred_at, candidate.sequence
          from session_events candidate
          where candidate.workspace_id = failing.workspace_id
            and candidate.turn_id = failing.turn_id
            and candidate.type = 'tool.auth_needed'
            and candidate.duplicate_of_event_id is null
            and (candidate.turn_association is null or candidate.turn_association = 'current')
          order by candidate.sequence
          limit ${SCHEDULED_TASK_RUN_AUTH_NEEDED_EVENTS_PER_TURN}
        ) event
        order by failing.fired_at desc, failing.task_id, event.sequence
      `,
    );
    return rows.map((row) => ({
      ...eventFromRow(row),
      taskId: row.task_id,
      taskName: row.task_name,
      firedAt:
        row.fired_at instanceof Date
          ? row.fired_at.toISOString()
          : new Date(row.fired_at).toISOString(),
    }));
  });
}

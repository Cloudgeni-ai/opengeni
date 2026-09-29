import { sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";

/**
 * A scheduled run whose own turn (`session_turns.scheduled_task_run_id`) is
 * waiting on a person: a pending tool approval or structured human-input
 * request. Projected at read time from durable turn/event facts; nothing is
 * stored, so the run row stays `dispatched` exactly as its lifecycle requires.
 *
 * `since` is when the current unanswered wait began: the first
 * `session.requiresAction` of this turn after the latest response that was not
 * the scheduler's own timeout rejection. A person's decision therefore restarts
 * the clock, while the scheduler rejecting several queued approvals one by one
 * does not (each would otherwise get a fresh full timeout).
 *
 * `expiresAt` is `since` plus the task's frozen `agentConfig.approvalTimeoutSeconds`
 * from the run's accepted execution; null when the task sets no timeout.
 */
export type ScheduledRunHumanWait = {
  runId: string;
  turnId: string;
  sessionId: string;
  since: string;
  expiresAt: string | null;
  timeoutSeconds: number | null;
};

/** Client event id prefix of the scheduler's own timeout decisions. */
export const SCHEDULED_HUMAN_WAIT_TIMEOUT_CLIENT_EVENT_PREFIX =
  "system:scheduled-approval-timeout:";

type HumanWaitRow = {
  run_id: string;
  turn_id: string;
  session_id: string;
  since: Date | string | null;
  timeout_seconds: number | string | null;
};

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function humanWaitFromRow(row: HumanWaitRow): ScheduledRunHumanWait | null {
  if (row.since === null) return null;
  const since = isoTimestamp(row.since);
  const timeoutSeconds =
    row.timeout_seconds === null || row.timeout_seconds === undefined
      ? null
      : Number(row.timeout_seconds);
  const validTimeout =
    timeoutSeconds !== null && Number.isSafeInteger(timeoutSeconds) && timeoutSeconds > 0
      ? timeoutSeconds
      : null;
  return {
    runId: row.run_id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    since,
    expiresAt:
      validTimeout === null
        ? null
        : new Date(Date.parse(since) + validTimeout * 1000).toISOString(),
    timeoutSeconds: validTimeout,
  };
}

/**
 * Human waits of scheduled runs, selected either by run ids or by one exact
 * turn. Runs must be scheduled-task runs of this workspace. Caller supplies
 * the RLS-scoped handle.
 */
export async function scheduledRunHumanWaitsInRlsContext(
  scopedDb: Database,
  workspaceId: string,
  filter: { runIds: readonly string[] } | { turnId: string },
): Promise<ScheduledRunHumanWait[]> {
  if ("runIds" in filter && filter.runIds.length === 0) return [];
  const selector =
    "runIds" in filter
      ? sql`turn.scheduled_task_run_id in (${sql.join(
          filter.runIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql`turn.id = ${filter.turnId}::uuid`;
  const rows = await rawRows<HumanWaitRow>(
    scopedDb,
    sql`
      select turn.scheduled_task_run_id as run_id, turn.id as turn_id,
        turn.session_id,
        (
          select min(waiting.occurred_at)
          from session_events waiting
          where waiting.workspace_id = turn.workspace_id
            and waiting.turn_id = turn.id
            and waiting.type = 'session.requiresAction'
            and waiting.sequence > coalesce((
              select max(answered.sequence)
              from session_events answered
              where answered.workspace_id = turn.workspace_id
                and answered.turn_id = turn.id
                and answered.type in ('user.approvalDecision', 'user.humanInputResponse')
                and (answered.client_event_id is null
                  or left(answered.client_event_id, ${SCHEDULED_HUMAN_WAIT_TIMEOUT_CLIENT_EVENT_PREFIX.length})
                    <> ${SCHEDULED_HUMAN_WAIT_TIMEOUT_CLIENT_EVENT_PREFIX})
            ), 0)
        ) as since,
        run.accepted_execution_snapshot #>> '{task,agentConfig,approvalTimeoutSeconds}'
          as timeout_seconds
      from session_turns turn
      join scheduled_task_runs run
        on run.workspace_id = turn.workspace_id
       and run.id = turn.scheduled_task_run_id
      where turn.workspace_id = ${workspaceId}::uuid
        and ${selector}
        and turn.status = 'requires_action'
        and run.status = 'dispatched'
    `,
  );
  return rows.map(humanWaitFromRow).filter((wait) => wait !== null);
}

/** Read-time projection for run listings: run id -> its current human wait. */
export async function listScheduledRunHumanWaits(
  db: Database,
  workspaceId: string,
  runIds: readonly string[],
): Promise<Map<string, ScheduledRunHumanWait>> {
  if (runIds.length === 0) return new Map();
  const waits = await withWorkspaceRls(db, workspaceId, (scopedDb) =>
    scheduledRunHumanWaitsInRlsContext(scopedDb, workspaceId, { runIds }),
  );
  return new Map(waits.map((wait) => [wait.runId, wait]));
}

export type ScheduledTaskHumanWaitAttentionRow = ScheduledRunHumanWait & {
  taskId: string;
  taskName: string;
  taskExecutionDigest: string;
  firedAt: string;
};

/**
 * Active agent schedules (owned by `subjectId`, or ownerless when allowed)
 * whose latest run with a turn is waiting on a person right now.
 */
export async function listScheduledTaskHumanWaitAttention(
  db: Database,
  workspaceId: string,
  input: { subjectId: string; includeOwnerless: boolean; taskLimit: number },
): Promise<ScheduledTaskHumanWaitAttentionRow[]> {
  const taskLimit = Math.max(1, Math.min(500, Math.floor(input.taskLimit)));
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const latest = await rawRows<{
      task_id: string;
      task_name: string;
      task_execution_digest: string;
      run_id: string;
      fired_at: Date | string;
    }>(
      scopedDb,
      sql`
        select task.id as task_id, task.name as task_name,
          task.execution_digest as task_execution_digest,
          run.id as run_id, run.fired_at
        from scheduled_tasks task
        cross join lateral (
          select candidate.id, candidate.fired_at, candidate.status
          from scheduled_task_runs candidate
          join session_turns turn
            on turn.workspace_id = candidate.workspace_id
           and turn.scheduled_task_run_id = candidate.id
          where candidate.workspace_id = task.workspace_id
            and candidate.task_id = task.id
          order by candidate.created_at desc, candidate.id desc
          limit 1
        ) run
        where task.workspace_id = ${workspaceId}::uuid
          and task.deleted_at is null
          and task.status = 'active'
          and task.action ->> 'kind' = 'agent_turn'
          and run.status = 'dispatched'
          and (
            task.owner_subject_id = ${input.subjectId}
            or (${input.includeOwnerless} and task.owner_subject_id is null)
          )
        order by run.fired_at desc, task.id
        limit ${taskLimit}
      `,
    );
    if (latest.length === 0) return [];
    const waits = await scheduledRunHumanWaitsInRlsContext(scopedDb, workspaceId, {
      runIds: latest.map((row) => row.run_id),
    });
    const byRun = new Map(waits.map((wait) => [wait.runId, wait]));
    return latest.flatMap((row) => {
      const wait = byRun.get(row.run_id);
      return wait
        ? [
            {
              ...wait,
              taskId: row.task_id,
              taskName: row.task_name,
              taskExecutionDigest: row.task_execution_digest,
              firedAt: isoTimestamp(row.fired_at),
            },
          ]
        : [];
    });
  });
}

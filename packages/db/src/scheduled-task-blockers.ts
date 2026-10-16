import { sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";

// Migration 0792. A schedule's newest settled scheduled run is reviewed once.
// The decision itself is a pure function the caller supplies; this module only
// reads exact facts under the task lock and applies the decision atomically:
// the review, a self-pause with its Temporal reconciliation, and the owner
// notice to deliver. Delivering the notice is a separate, retried step.

export type ScheduledTaskBlockerState = "clear" | "notified" | "paused";

export type ScheduledTaskBlockerRun = {
  id: string;
  status: string;
  error: string | null;
  admissionRefusal: { reason: string; retryable: boolean } | null;
  /** Present when a pinned connector account could not be selected. */
  admissionDiagnostic: unknown;
  sessionId: string | null;
  createdAt: Date;
};

export type ScheduledTaskBlockerReview = {
  reviewedRunId: string | null;
  state: ScheduledTaskBlockerState;
  reason: string | null;
  message: string | null;
  blockedRunId: string | null;
  blockedSince: Date | null;
  noticeSessionId: string | null;
  noticeKey: string | null;
  noticePending: "post" | "withdraw" | null;
};

export type ScheduledTaskBlockerFacts = {
  task: {
    id: string;
    accountId: string;
    workspaceId: string;
    name: string;
    status: string;
    deleted: boolean;
    runMode: string;
    reusableSessionId: string | null;
    updatedAt: Date;
  };
  review: ScheduledTaskBlockerReview | null;
  /** Newest first: scheduled (not manual) agent-turn runs only. */
  runs: ScheduledTaskBlockerRun[];
};

export type ScheduledTaskBlockerNotice = {
  sessionId: string;
  key: string;
  /** A validated `session.notification.posted` payload. */
  payload: Record<string, unknown>;
};

export type ScheduledTaskBlockerDecision =
  /** Nothing to report; remember the run so it is not reviewed again. */
  | { kind: "none"; reviewedRunId: string | null }
  | {
      kind: "block";
      state: "notified" | "paused";
      reason: string;
      message: string;
      blockedRunId: string;
      blockedSince: Date;
      reviewedRunId: string;
      notice: ScheduledTaskBlockerNotice | null;
    }
  /** The blocker is gone or a person acted: withdraw any notice. */
  | { kind: "clear"; reviewedRunId: string | null };

export const SCHEDULED_TASK_BLOCKER_REVIEW_RUNS = 20;

/** Identity-only system inventory; every mutation is tenant-scoped and rechecked. */
export async function listScheduledTaskBlockerReviews(db: Database, limit = 32) {
  return rawRows<{ id: string; workspace_id: string }>(
    db,
    sql`select * from opengeni_private.list_scheduled_task_blocker_reviews(${limit})`,
  );
}

function date(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

function refusal(value: unknown): ScheduledTaskBlockerRun["admissionRefusal"] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== "object") return null;
  const { reason, retryable } = parsed as { reason?: unknown; retryable?: unknown };
  return typeof reason === "string" && typeof retryable === "boolean"
    ? { reason, retryable }
    : null;
}

/**
 * Review one schedule under its task lock (the lock run admission also takes),
 * so a decision never races a freshly accepted run or a concurrent edit.
 * Returns whether the schedule was paused and whether a notice awaits delivery.
 */
export async function reviewScheduledTaskBlockers(
  db: Database,
  workspaceId: string,
  taskId: string,
  decide: (facts: ScheduledTaskBlockerFacts) => ScheduledTaskBlockerDecision,
): Promise<{ paused: boolean; noticePending: boolean }> {
  return withWorkspaceRls(db, workspaceId, async (scopedDb) =>
    scopedDb.transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const [task] = await rawRows<{
        id: string;
        account_id: string;
        workspace_id: string;
        name: string;
        status: string;
        deleted_at: Date | string | null;
        run_mode: string;
        reusable_session_id: string | null;
        updated_at: Date | string;
      }>(
        exec,
        sql`select id, account_id, workspace_id, name, status, deleted_at, run_mode,
              reusable_session_id, updated_at
            from scheduled_tasks
            where workspace_id = ${workspaceId} and id = ${taskId}
            for update`,
      );
      if (!task) return { paused: false, noticePending: false };
      const [reviewRow] = await rawRows<{
        reviewed_run_id: string | null;
        state: ScheduledTaskBlockerState;
        reason: string | null;
        message: string | null;
        blocked_run_id: string | null;
        blocked_since: Date | string | null;
        notice_session_id: string | null;
        notice_key: string | null;
        notice_pending: "post" | "withdraw" | null;
      }>(
        exec,
        sql`select reviewed_run_id, state, reason, message, blocked_run_id, blocked_since,
              notice_session_id, notice_key, notice_pending
            from scheduled_task_blocker_reviews
            where workspace_id = ${workspaceId} and task_id = ${taskId}
            for update`,
      );
      const runs = await rawRows<{
        id: string;
        status: string;
        error: string | null;
        admission_refusal: unknown;
        admission_diagnostic: unknown;
        session_id: string | null;
        created_at: Date | string;
      }>(
        exec,
        sql`select id, status, error, admission_refusal, admission_diagnostic, session_id, created_at
            from scheduled_task_runs
            where workspace_id = ${workspaceId} and task_id = ${taskId}
              and account_id = ${task.account_id}
              and trigger_type = 'scheduled' and action_kind = 'agent_turn'
            order by created_at desc, id desc
            limit ${SCHEDULED_TASK_BLOCKER_REVIEW_RUNS}`,
      );
      const review: ScheduledTaskBlockerReview | null = reviewRow
        ? {
            reviewedRunId: reviewRow.reviewed_run_id,
            state: reviewRow.state,
            reason: reviewRow.reason,
            message: reviewRow.message,
            blockedRunId: reviewRow.blocked_run_id,
            blockedSince: date(reviewRow.blocked_since),
            noticeSessionId: reviewRow.notice_session_id,
            noticeKey: reviewRow.notice_key,
            noticePending: reviewRow.notice_pending,
          }
        : null;
      const decision = decide({
        task: {
          id: task.id,
          accountId: task.account_id,
          workspaceId: task.workspace_id,
          name: task.name,
          status: task.status,
          deleted: task.deleted_at !== null,
          runMode: task.run_mode,
          reusableSessionId: task.reusable_session_id,
          updatedAt: new Date(task.updated_at),
        },
        review,
        runs: runs.map((run) => ({
          id: run.id,
          status: run.status,
          error: run.error,
          admissionRefusal: refusal(run.admission_refusal),
          admissionDiagnostic: run.admission_diagnostic ?? null,
          sessionId: run.session_id,
          createdAt: new Date(run.created_at),
        })),
      });

      if (decision.kind === "none") {
        await exec.execute(sql`
          insert into scheduled_task_blocker_reviews (task_id, account_id, workspace_id, reviewed_run_id)
          values (${task.id}, ${task.account_id}, ${task.workspace_id}, ${decision.reviewedRunId})
          on conflict (task_id) do update set
            reviewed_run_id = coalesce(excluded.reviewed_run_id, scheduled_task_blocker_reviews.reviewed_run_id),
            updated_at = now()`);
        return { paused: false, noticePending: review?.noticePending != null };
      }

      if (decision.kind === "clear") {
        // Withdraw the notice the owner was sent; a post still undelivered is dropped.
        const withdraw = review?.noticeSessionId != null;
        await exec.execute(sql`
          insert into scheduled_task_blocker_reviews (task_id, account_id, workspace_id, reviewed_run_id)
          values (${task.id}, ${task.account_id}, ${task.workspace_id}, ${decision.reviewedRunId})
          on conflict (task_id) do update set
            reviewed_run_id = coalesce(excluded.reviewed_run_id, scheduled_task_blocker_reviews.reviewed_run_id),
            state = 'clear', reason = null, message = null, blocked_run_id = null,
            blocked_since = null,
            notice_pending = ${withdraw ? "withdraw" : null},
            notice_payload = null,
            updated_at = now()`);
        return { paused: false, noticePending: withdraw };
      }

      const notice = decision.notice;
      await exec.execute(sql`
        insert into scheduled_task_blocker_reviews (
          task_id, account_id, workspace_id, reviewed_run_id, state, reason, message,
          blocked_run_id, blocked_since, notice_session_id, notice_key, notice_pending,
          notice_payload
        ) values (
          ${task.id}, ${task.account_id}, ${task.workspace_id}, ${decision.reviewedRunId},
          ${decision.state}, ${decision.reason}, ${decision.message}, ${decision.blockedRunId},
          ${decision.blockedSince.toISOString()}::timestamptz,
          ${notice?.sessionId ?? null}, ${notice?.key ?? null}, ${notice ? "post" : null},
          ${notice ? JSON.stringify(notice.payload) : null}::jsonb
        )
        on conflict (task_id) do update set
          reviewed_run_id = excluded.reviewed_run_id,
          state = excluded.state, reason = excluded.reason, message = excluded.message,
          blocked_run_id = excluded.blocked_run_id, blocked_since = excluded.blocked_since,
          notice_session_id = coalesce(excluded.notice_session_id, scheduled_task_blocker_reviews.notice_session_id),
          notice_key = coalesce(excluded.notice_key, scheduled_task_blocker_reviews.notice_key),
          notice_pending = coalesce(excluded.notice_pending, scheduled_task_blocker_reviews.notice_pending),
          notice_payload = case when excluded.notice_pending is not null
            then excluded.notice_payload
            else scheduled_task_blocker_reviews.notice_payload end,
          updated_at = now()`);
      let paused = false;
      if (decision.state === "paused") {
        // Like exhausted-schedule retirement: pause only a still-active task and
        // let the lifecycle pump bring Temporal in line through the outbox.
        const pausedRows = await rawRows<{ id: string }>(
          exec,
          sql`
          with paused as (
            update scheduled_tasks set status = 'paused', updated_at = now()
            where workspace_id = ${workspaceId} and id = ${taskId}
              and status = 'active' and deleted_at is null
            returning id, account_id, workspace_id, temporal_schedule_id
          ), enqueued as (
            insert into scheduled_task_schedule_outbox(account_id, workspace_id, temporal_schedule_id, task_id)
            select account_id, workspace_id, temporal_schedule_id, id from paused
            on conflict (task_id) do update set id = gen_random_uuid(), created_at = now(), next_attempt_at = now()
          ) select id from paused`,
        );
        paused = pausedRows.length === 1;
      }
      return { paused, noticePending: notice !== null };
    }),
  );
}

export type PendingScheduledTaskBlockerNotice = {
  sessionId: string;
  key: string;
  pending: "post" | "withdraw";
  payload: Record<string, unknown> | null;
};

export async function getPendingScheduledTaskBlockerNotice(
  db: Database,
  workspaceId: string,
  taskId: string,
): Promise<PendingScheduledTaskBlockerNotice | null> {
  return withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await rawRows<{
      notice_session_id: string;
      notice_key: string;
      notice_pending: "post" | "withdraw";
      notice_payload: unknown;
    }>(
      scopedDb,
      sql`select notice_session_id, notice_key, notice_pending, notice_payload
          from scheduled_task_blocker_reviews
          where workspace_id = ${workspaceId} and task_id = ${taskId}
            and notice_pending is not null`,
    );
    if (!row) return null;
    const payload =
      typeof row.notice_payload === "string"
        ? (JSON.parse(row.notice_payload) as Record<string, unknown>)
        : ((row.notice_payload as Record<string, unknown> | null) ?? null);
    return {
      sessionId: row.notice_session_id,
      key: row.notice_key,
      pending: row.notice_pending,
      payload,
    };
  });
}

/**
 * Record that exactly this pending notice was delivered. A post keeps its
 * session and key so the notice can be withdrawn later; a withdrawal forgets them.
 * A review that changed meanwhile is left for its own delivery.
 */
export async function settleScheduledTaskBlockerNotice(
  db: Database,
  workspaceId: string,
  taskId: string,
  delivered: Pick<PendingScheduledTaskBlockerNotice, "sessionId" | "key" | "pending">,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, (scopedDb) =>
    scopedDb.execute(sql`
      update scheduled_task_blocker_reviews set
        notice_pending = null,
        notice_payload = null,
        notice_session_id = case when ${delivered.pending} = 'withdraw' then null else notice_session_id end,
        notice_key = case when ${delivered.pending} = 'withdraw' then null else notice_key end,
        updated_at = now()
      where workspace_id = ${workspaceId} and task_id = ${taskId}
        and notice_pending = ${delivered.pending}
        and notice_session_id = ${delivered.sessionId} and notice_key = ${delivered.key}`),
  );
}

export type ScheduledTaskBlockerSummary = {
  state: "notified" | "paused";
  reason: string;
  message: string;
  runId: string;
  since: string;
};

/**
 * The current blocker of each task, for display. A recorded self-pause shows
 * only while the task is still paused, and a notice only while it is active.
 */
export async function getScheduledTaskBlockers(
  db: Database,
  workspaceId: string,
  taskIds: readonly string[],
): Promise<Map<string, ScheduledTaskBlockerSummary>> {
  const result = new Map<string, ScheduledTaskBlockerSummary>();
  if (taskIds.length === 0) return result;
  const rows = await withWorkspaceRls(db, workspaceId, (scopedDb) =>
    rawRows<{
      task_id: string;
      state: "notified" | "paused";
      reason: string;
      message: string;
      blocked_run_id: string;
      blocked_since: Date | string;
    }>(
      scopedDb,
      sql`select review.task_id, review.state, review.reason, review.message,
            review.blocked_run_id, review.blocked_since
          from scheduled_task_blocker_reviews review
          join scheduled_tasks task
            on task.id = review.task_id and task.workspace_id = review.workspace_id
          where review.workspace_id = ${workspaceId}
            and review.task_id in (${sql.join(
              taskIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
            and task.deleted_at is null
            and ((review.state = 'paused' and task.status = 'paused')
              or (review.state = 'notified' and task.status = 'active'))`,
    ),
  );
  for (const row of rows) {
    result.set(row.task_id, {
      state: row.state,
      reason: row.reason,
      message: row.message,
      runId: row.blocked_run_id,
      since: new Date(row.blocked_since).toISOString(),
    });
  }
  return result;
}

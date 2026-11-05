import { sql } from "drizzle-orm";
import { type Database, withRlsContext } from "./database";

/** Owned-box setup operations. Their turn may wait for the box to be gone. */
const OWNED_BOX_SETUP_OPERATIONS = sql`('lazyOwnedSandboxSetup', 'eagerOwnedSandboxSetup')`;

/**
 * Reject every request that a turn worker left behind once that worker's
 * process provably no longer exists. Nothing else settles them: the worker
 * closed the attempt (or was declared dead) before its writer drain released
 * them, and a box that stays warm (compute is never drained for being idle)
 * never reaches the cold commit that rejects crashed-worker requests. The
 * closed attempt then never quiesced, and its session never claimed another
 * turn, Steer or message. Any kind of request can be left this way: a file
 * write, an editor change, a command, stdin, owned-box setup.
 *
 * A settled activity and a missing holder do not prove the worker exited (a
 * closed attempt's holder is removed at once, and Temporal reports a cancelled
 * activity settled while its code still runs). Time does, for the closures
 * that mean the worker itself went away:
 *
 * - `interrupted_recoverable` through the attempt's own `worker_shutdown`
 *   recovery request, which follows the worker's shutdown signal. A standalone
 *   worker process exits within its process-exit deadline of that signal,
 *   whatever its drain does.
 * - worker death: `lease_lost_recoverable`, or `failed` with the
 *   `worker_death_redispatch_exhausted` failure. The workflow records these
 *   only after Temporal's heartbeat timeout, so the worker had stopped
 *   heartbeating at least that long before the closure.
 *
 * The attempt must have closed at least the process-exit deadline ago, with no
 * Pause/Steer interruption row. A closed attempt admits nothing new, and every
 * request a worker sends to a provider ends with its own request timeout well
 * inside that window.
 *
 * The request must be the attempt's own, unsettled, with no provider outcome,
 * without its holder and without a retained process (a retained command is
 * settled by its own exit or loss proof). Owned-box setup on a turn whose setup
 * Start outcome is recorded unknown keeps waiting for the box to be gone.
 *
 * The request is rejected and never replayed: no provider outcome was
 * observed. A command it started may have finished, or, on a provider that
 * keeps a disconnected command running, may still run untracked, like any
 * process the agent started in the background. The replacement attempt is
 * told that its previous execution stopped before it finished and reads the
 * workspace as it is. Pause, Steer, cancellation and other closures, which a
 * live worker records and whose replacement resumes the same box, keep their
 * gate. A late settlement by the old owner is fenced by `settled_at`.
 *
 * Returns how many requests were settled. The caller wakes the session when
 * any were: a worker-death closure needs no quiescence receipt, so its
 * reconciliation reports `stale`, and only the wake makes the workflow look at
 * the session again.
 */
export async function settleExitedWorkerAdmissions(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    attemptId: string;
    temporalWorkflowId: string;
    temporalWorkflowRunId: string;
    temporalActivityId: string;
    workerProcessExitDeadlineMs?: number;
  },
): Promise<number> {
  const exitDeadlineMs = input.workerProcessExitDeadlineMs;
  if (exitDeadlineMs === undefined || !Number.isSafeInteger(exitDeadlineMs) || exitDeadlineMs < 0)
    return 0;
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const settled = await scopedDb.execute<{ id: string }>(sql`
        update sandbox_workspace_mutation_admissions admission
        set provider_outcome = 'rejected', settled_at = now()
        from session_turn_attempts attempt
        join session_turns turn
          on turn.workspace_id = attempt.workspace_id
         and turn.session_id = attempt.session_id
         and turn.id = attempt.turn_id
        where attempt.account_id = ${input.accountId}
          and attempt.workspace_id = ${input.workspaceId}
          and attempt.session_id = ${input.sessionId}
          and attempt.id = ${input.attemptId}
          and attempt.temporal_workflow_id = ${input.temporalWorkflowId}
          and attempt.temporal_workflow_run_id = ${input.temporalWorkflowRunId}
          and attempt.temporal_activity_id = ${input.temporalActivityId}
          and attempt.state = 'closed'
          and attempt.quiesced_at is null
          and attempt.closed_at <= now() - (${exitDeadlineMs}::integer * interval '1 millisecond')
          and not exists (
            select 1 from session_attempt_interruptions interruption
            where interruption.workspace_id = attempt.workspace_id
              and interruption.session_id = attempt.session_id
              and interruption.attempt_id = attempt.id
          )
          and (
            (
              attempt.outcome = 'interrupted_recoverable'
              and exists (
                select 1 from session_events recovery
                where recovery.account_id = attempt.account_id
                  and recovery.workspace_id = attempt.workspace_id
                  and recovery.session_id = attempt.session_id
                  and recovery.turn_id = attempt.turn_id
                  and recovery.turn_attempt_id = attempt.id
                  and recovery.type = 'turn.recovery.requested'
                  and recovery.payload ->> 'reason' = 'worker_shutdown'
              )
            )
            or attempt.outcome = 'lease_lost_recoverable'
            or (
              attempt.outcome = 'failed'
              and exists (
                select 1 from session_events failure
                where failure.account_id = attempt.account_id
                  and failure.workspace_id = attempt.workspace_id
                  and failure.session_id = attempt.session_id
                  and failure.turn_id = attempt.turn_id
                  and failure.turn_attempt_id = attempt.id
                  and failure.type = 'turn.failed'
                  and failure.payload ->> 'code' = 'worker_death_redispatch_exhausted'
              )
            )
          )
          and (
            admission.operation not in ${OWNED_BOX_SETUP_OPERATIONS}
            or (turn.metadata -> 'sandboxSetupOutcomeUnknown') is null
          )
          and admission.account_id = attempt.account_id
          and admission.workspace_id = attempt.workspace_id
          and admission.session_id = attempt.session_id
          and admission.turn_id = attempt.turn_id
          and admission.attempt_id = attempt.id
          and admission.actor_kind = 'turn'
          and admission.actor_id = attempt.id
          and admission.holder_kind = 'turn'
          and admission.execution_generation = attempt.execution_generation
          and admission.settled_at is null
          and admission.provider_outcome is null
          and not exists (
            select 1 from sandbox_retained_processes retained
            where retained.parent_admission_id = admission.id
          )
          and not exists (
            select 1 from sandbox_lease_holders holder
            where holder.lease_id = admission.lease_id
              and holder.holder_id = admission.holder_id
          )
        returning admission.id
      `);
      return settled.length;
    },
  );
}

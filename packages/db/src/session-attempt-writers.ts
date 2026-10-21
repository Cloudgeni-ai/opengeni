import { sql, type SQL } from "drizzle-orm";

/**
 * A request whose owner lost its execution and that nothing can settle any
 * more. Its holder is gone from the lease, it was never adopted as a retained
 * process, and its provider outcome is still unknown. Two owners leave this
 * shape:
 *
 * - a turn attempt closed `lease_lost_recoverable` or `failed` (worker death,
 *   redispatch exhaustion, credential-lease loss);
 * - an API-direct request (Files, Terminal, Browser and similar surfaces)
 *   whose API process died mid-operation. A live direct request heartbeats its
 *   holder for the whole operation and settles its admission before releasing
 *   it (`releaseLeaseHolder` rejects any null outcome it left), so a direct
 *   admission without its holder was left by a holder the TTL reaper removed.
 *
 * Either way the owner can admit no more work, and the only physical writer the
 * request can stand for is a command that may still be running on that exact
 * box. It must not pin the sandbox (drain, command containment, deadline
 * rotation) or refuse checkpoints forever.
 *
 * This does not prove the owning process is dead. Safety comes from what the
 * callers do: a drain captures around the request only when its capture is a
 * point-in-time image of a stopped or paused box and terminates that box next,
 * a warm capture only when it is a point-in-time image and then records itself
 * as having run around writers, and the request is rejected only in the cold
 * commit after the exact box was terminated or proven gone. A late settlement
 * by a still-running owner is then fenced. Pause, Steer and cancellation
 * closures keep their requests as writers because the replacement attempt
 * resumes the same box; the holder clause is defence in depth for turns.
 */
export function crashedWorkerOrphanAdmissionSql(admission: SQL): SQL {
  return sql`(
    ${admission}.settled_at is null
    and ${admission}.provider_outcome is null
    and (
      (
        ${admission}.actor_kind = 'turn'
        and ${admission}.holder_kind = 'turn'
        and exists (
          select 1 from session_turn_attempts orphan_owner
          where orphan_owner.account_id = ${admission}.account_id
            and orphan_owner.workspace_id = ${admission}.workspace_id
            and orphan_owner.session_id = ${admission}.session_id
            and orphan_owner.turn_id = ${admission}.turn_id
            and orphan_owner.id = ${admission}.attempt_id
            and orphan_owner.id = ${admission}.actor_id
            and orphan_owner.execution_generation = ${admission}.execution_generation
            and orphan_owner.state = 'closed'
            and orphan_owner.outcome in ('lease_lost_recoverable', 'failed')
        )
      ) or (
        ${admission}.actor_kind = 'direct'
        and ${admission}.holder_kind = 'direct'
      )
    )
    and not exists (
      select 1 from sandbox_retained_processes orphan_process
      where orphan_process.parent_admission_id = ${admission}.id
    )
    and not exists (
      select 1 from sandbox_lease_holders orphan_holder
      where orphan_holder.lease_id = ${admission}.lease_id
        and orphan_holder.holder_id = ${admission}.holder_id
    )
  )`;
}

/** Physical writers retain ownership after logical settlement. A durably
 * adopted background command owns its lifetime independently of the turn.
 *
 * `containment` is the physical predicate minus crashed-worker orphans
 * (`crashedWorkerOrphanAdmissionSql`). Only sandbox containment, drain and
 * deadline decisions use it, because those settle the orphan themselves once
 * the exact box is gone; the quiescence receipt keeps the strict predicate.
 *
 * The predicate is correlated per attempt row. A session-wide scan must first
 * restrict rows to `sessionPendingWriterAttemptIdsSql`, otherwise it evaluates
 * these subqueries for every attempt the session ever ran. */
export function sessionAttemptPendingWritersSql(
  attempt: SQL,
  mode: "physical" | "inference" | "containment" = "physical",
): SQL {
  // A lost legacy exec observation without a retained locator cannot be
  // reconciled by polling. Let inference inspect the same machine, while
  // physical quiescence retains the strict predicate. Capture and containment
  // use the separate crashed-worker test above (see `containment`).
  const unknownLegacyExec =
    mode === "inference"
      ? sql`and not (
          ${attempt}.state = 'closed'
          and ${attempt}.outcome = 'lease_lost_recoverable'
          and admission.actor_kind = 'turn'
          and admission.actor_id = ${attempt}.id
          and admission.attempt_id = ${attempt}.id
          and admission.turn_id = ${attempt}.turn_id
          and admission.execution_generation = ${attempt}.execution_generation
          and admission.provider_backend = 'modal'
          and admission.route_kind = 'home'
          and admission.route_target_id is null
          and admission.operation = 'execCommand'
          and admission.provider_outcome is null
          and not exists (
            select 1 from sandbox_retained_processes retained
            where retained.parent_admission_id = admission.id
          )
        )`
      : mode === "containment"
        ? sql`and not ${crashedWorkerOrphanAdmissionSql(sql`admission`)}`
        : sql``;
  return sql`(
    exists (
      select 1 from sandbox_workspace_mutation_admissions admission
      where admission.account_id = ${attempt}.account_id
        and admission.workspace_id = ${attempt}.workspace_id
        and admission.session_id = ${attempt}.session_id
        and admission.settled_at is null
        ${unknownLegacyExec}
        and (
          admission.attempt_id = ${attempt}.id
          or (admission.actor_kind = 'process' and exists (
            select 1 from sandbox_retained_processes process
            where process.account_id = ${attempt}.account_id
              and process.workspace_id = ${attempt}.workspace_id
              and process.session_id = ${attempt}.session_id
              and process.id = admission.actor_id
              and process.owner_attempt_id = ${attempt}.id
          ))
        )
        and not exists (
          select 1 from sandbox_retained_processes process
          join session_background_commands command on command.retained_process_id = process.id
          where process.account_id = ${attempt}.account_id
            and process.workspace_id = ${attempt}.workspace_id
            and process.session_id = ${attempt}.session_id
            and (process.parent_admission_id = admission.id
              or (admission.actor_kind = 'process' and process.id = admission.actor_id))
            and command.state in ('running', 'stopping')
        )
    ) or exists (
      select 1 from sandbox_retained_processes process
      where process.account_id = ${attempt}.account_id
        and process.workspace_id = ${attempt}.workspace_id
        and process.session_id = ${attempt}.session_id
        and process.owner_attempt_id = ${attempt}.id
        and process.state = 'active'
        and not exists (
          select 1 from session_background_commands command
          where command.retained_process_id = process.id
            and command.state in ('running', 'stopping')
        )
    )
  )`;
}

/** One session, addressed by bound workspace and session ids. */
export type SessionAttemptScope = { workspaceId: string; sessionId: string };

/**
 * The attempt ids in one session for which `sessionAttemptPendingWritersSql`
 * can be true, in any mode. It is a superset: callers still apply the exact
 * predicate to these rows. Every branch of that predicate needs either an
 * unsettled workspace-mutation admission of the session (owned by the attempt
 * itself, or by a retained process the attempt owns) or an active retained
 * process the attempt owns, so these three sources cover it.
 *
 * The subquery is uncorrelated. Postgres evaluates it once and probes it as a
 * hashed set, so the check costs the session's pending work, not its history.
 * The unsettled admissions are read through
 * `sandbox_workspace_mutation_admissions_unsettled_session_idx` (migration
 * 0879) and active processes through `sandbox_retained_processes_active_idx`.
 */
export function sessionPendingWriterAttemptIdsSql(scope: SessionAttemptScope): SQL {
  return sql`(
    select admission.attempt_id
    from sandbox_workspace_mutation_admissions admission
    where admission.workspace_id = ${scope.workspaceId}
      and admission.session_id = ${scope.sessionId}
      and admission.settled_at is null
      and admission.attempt_id is not null
    union all
    select process.owner_attempt_id
    from sandbox_workspace_mutation_admissions admission
    join sandbox_retained_processes process on process.id = admission.actor_id
    where admission.workspace_id = ${scope.workspaceId}
      and admission.session_id = ${scope.sessionId}
      and admission.settled_at is null
      and admission.actor_kind = 'process'
      and process.owner_attempt_id is not null
    union all
    select process.owner_attempt_id
    from sandbox_retained_processes process
    where process.workspace_id = ${scope.workspaceId}
      and process.session_id = ${scope.sessionId}
      and process.state = 'active'
      and process.owner_attempt_id is not null
  )`;
}

/**
 * The attempt ids in one session that can still await a physical-quiescence
 * receipt: possible pending writers, attempts with a settled or stale Pause or
 * Steer interruption, and the session's newest attempt (the only one that can
 * be an unsucceeded same-turn recovery). Like the writer set it is an
 * uncorrelated superset, so the exact quiescence predicate runs only on these
 * rows instead of every closed attempt in the session's history.
 */
export function sessionQuiescenceCandidateAttemptIdsSql(scope: SessionAttemptScope): SQL {
  return sql`(
    select candidate.id from ${sessionPendingWriterAttemptIdsSql(scope)} as candidate(id)
    union all
    select interruption.attempt_id
    from session_attempt_interruptions interruption
    where interruption.workspace_id = ${scope.workspaceId}
      and interruption.session_id = ${scope.sessionId}
      and interruption.state in ('settled', 'rejected_stale')
    union all
    (
      select latest.id
      from session_turn_attempts latest
      where latest.workspace_id = ${scope.workspaceId}
        and latest.session_id = ${scope.sessionId}
      order by latest.started_at desc, latest.id desc
      limit 1
    )
  )`;
}

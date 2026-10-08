import { sql, type SQL } from "drizzle-orm";

/**
 * An exact turn request that a crashed worker left behind (OPE-743): its attempt
 * was closed `lease_lost_recoverable`, its turn lease holder is gone (reaped as
 * dead), it was never adopted as a retained process, and its provider outcome
 * is still unknown. Nothing will ever settle it: the owner cannot admit more
 * work, and the only physical writer it can stand for is a command that may
 * still be running on that exact box. It therefore must not pin the sandbox
 * (idle drain, command containment, deadline rotation) or refuse checkpoints
 * forever; it is settled only after the exact provider box is terminated or
 * proven gone, which is when nothing it started can still be running.
 *
 * The holder check is what separates a crash from an ordinary cancellation:
 * Pause/Steer may drop the turn holder eagerly while the live activity is still
 * draining a request, but those attempts close with another outcome. A
 * lease-lost attempt whose holder still exists stays a writer.
 */
export function crashedWorkerOrphanAdmissionSql(admission: SQL): SQL {
  return sql`(
    ${admission}.actor_kind = 'turn'
    and ${admission}.holder_kind = 'turn'
    and ${admission}.settled_at is null
    and ${admission}.provider_outcome is null
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
        and orphan_owner.outcome = 'lease_lost_recoverable'
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
 * the exact box is gone; the quiescence receipt keeps the strict predicate. */
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

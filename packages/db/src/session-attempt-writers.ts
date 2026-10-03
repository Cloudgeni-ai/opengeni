import { sql, type SQL } from "drizzle-orm";

/** Physical writers retain ownership after logical settlement. A durably
 * adopted background command owns its lifetime independently of the turn. */
export function sessionAttemptPendingWritersSql(
  attempt: SQL,
  mode: "physical" | "inference" = "physical",
): SQL {
  // A lost legacy exec observation without a retained locator cannot be
  // reconciled by polling. Let inference inspect the same machine, while
  // capture, rotation and physical quiescence retain their strict predicate.
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

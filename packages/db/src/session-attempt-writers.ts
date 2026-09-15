import { sql, type SQL } from "drizzle-orm";

/** Physical writers retain ownership after logical settlement. A durably
 * adopted background command owns its lifetime independently of the turn. */
export function sessionAttemptPendingWritersSql(attempt: SQL): SQL {
  return sql`(
    exists (
      select 1 from sandbox_workspace_mutation_admissions admission
      where admission.account_id = ${attempt}.account_id
        and admission.workspace_id = ${attempt}.workspace_id
        and admission.session_id = ${attempt}.session_id
        and admission.settled_at is null
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

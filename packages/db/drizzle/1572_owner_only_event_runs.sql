-- deployment-mode: rolling
-- An event only the automation's owner may see (their private meeting or
-- chat, from their "This workspace" source) runs in an Only me chat of the
-- owner. An automation that continues a chat shared with the workspace
-- records a skipped run with reason owner_only_event instead, which the
-- refusal guard now allows.
-- The refusal guard is unchanged from migration 1565 apart from the new
-- reason. The session authority guard also accepts the scheduler's private
-- create for such a run: a new-chat-per-run event run of the owner's whose
-- occurrence (written by Opengeni, never by the automation) marks an event
-- ownerOnly. Every other private create is unchanged.
-- The previous release never records that reason or makes that create.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION opengeni_private.guard_scheduled_admission_refusal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE task_row scheduled_tasks%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.admission_refusal IS DISTINCT FROM OLD.admission_refusal
      OR (OLD.admission_refusal IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
    THEN RAISE EXCEPTION 'scheduled admission refusal is immutable' USING ERRCODE = '42501'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.admission_refusal IS NULL THEN RETURN NEW; END IF;
  IF NEW.action_kind IS DISTINCT FROM 'agent_turn'
    OR NEW.admission_diagnostic IS NOT NULL
    OR jsonb_typeof(NEW.admission_refusal) IS DISTINCT FROM 'object'
    OR NEW.admission_refusal - ARRAY['version','reason','retryable'] <> '{}'::jsonb
    OR NEW.admission_refusal -> 'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(NEW.admission_refusal -> 'retryable') IS DISTINCT FROM 'boolean'
    OR coalesce(NEW.admission_refusal ->> 'reason', '') NOT IN (
      'scheduled_authority_unavailable',
      'machine_target_unavailable', 'machine_enrollment_inactive',
      'variable_set_unavailable', 'rig_version_unavailable',
      'insufficient_credits', 'monthly_model_cost_limit', 'monthly_agent_run_limit', 'allowance_exhausted', 'scheduled_model_unavailable', 'session_usage_limit',
      'chain_limit', 'duplicate_agent_run', 'owner_only_event')
    OR NEW.error IS DISTINCT FROM NEW.admission_refusal ->> 'reason'
    OR NEW.status IS DISTINCT FROM (CASE WHEN (NEW.admission_refusal ->> 'retryable')::boolean
      THEN 'skipped' ELSE 'failed' END)
    OR NEW.completed_at IS NULL OR nullif(btrim(NEW.producer_key),'') IS NULL
    OR NEW.session_id IS NOT NULL OR NEW.trigger_event_id IS NOT NULL
    OR NEW.accepted_execution_snapshot IS NOT NULL OR NEW.accepted_execution_digest IS NOT NULL
    OR NEW.knowledge_sync_run_id IS NOT NULL OR NEW.knowledge_summary IS NOT NULL
  THEN RAISE EXCEPTION 'invalid scheduled admission refusal' USING ERRCODE = '22023'; END IF;
  SELECT task.* INTO STRICT task_row FROM scheduled_tasks task
    WHERE task.id = NEW.task_id AND task.workspace_id = NEW.workspace_id
      AND task.account_id = NEW.account_id FOR UPDATE;
  IF task_row.status <> 'active' OR task_row.deleted_at IS NOT NULL
    OR task_row.action ->> 'kind' IS DISTINCT FROM 'agent_turn'
    OR NEW.task_authority_revision IS DISTINCT FROM task_row.authority_revision
    OR NEW.task_execution_digest IS DISTINCT FROM task_row.execution_digest
  THEN RAISE EXCEPTION 'scheduled task changed before refusal recording' USING ERRCODE = '40001'; END IF;
  RETURN NEW;
END $$;

DO $definer_search_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.guard_scheduled_admission_refusal() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$definer_search_path$;

DO $migration$
DECLARE
  definition text;
  anchor text := $a$AND run.accepted_execution_snapshot#>>'{task,runMode}' IN ('new_session_per_run','reusable_session'))$a$;
BEGIN
  IF pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.guard_session_authority_write()', pg_catalog.current_schema())) IS NULL THEN
    RAISE WARNING '1572: guard_session_authority_write() is missing; owner-only event runs stay refused';
    RETURN;
  END IF;
  definition := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.guard_session_authority_write()', pg_catalog.current_schema()
  )::regprocedure);
  IF strpos(definition, $a$(@.ownerOnly == true)$a$) > 0 THEN
    RETURN;
  END IF;
  IF strpos(definition, anchor) = 0 THEN
    RAISE WARNING '1572: the scheduler clause is missing; owner-only event runs stay refused';
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '1572 owner-only event run private create drift' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, anchor, anchor || $r$
              OR (run.trigger_type='event'
                AND run.accepted_execution_snapshot#>>'{task,runMode}'='new_session_per_run'
                AND run.accepted_execution_snapshot#>>'{task,ownerSubjectId}'=capability.actor_subject_id
                AND EXISTS (
                SELECT 1 FROM scheduled_task_event_occurrences occurrence
                WHERE occurrence.account_id=run.account_id
                  AND occurrence.workspace_id=run.workspace_id
                  AND occurrence.task_id=run.task_id
                  AND run.producer_key='scheduled-task-event:' || occurrence.id::text
                  AND pg_catalog.jsonb_path_exists(occurrence.events,
                    '$[*] ? (@.ownerOnly == true)'::jsonpath)))$r$);
  EXECUTE definition;
END
$migration$;

-- The run's generated-chat fence expects that same chat Only me for the owner.
DO $migration$
DECLARE
  definition text;
  anchor constant text := $a$(task_snapshot->>'visibility'='private'$a$;
BEGIN
  definition := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.fence_scheduled_task_run_connection_session_identity()',
    pg_catalog.current_schema())::regprocedure);
  IF strpos(definition, $a$(@.ownerOnly == true)$a$) > 0 THEN
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 3 THEN
    RAISE EXCEPTION '1572 scheduled generated session fence drift' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, anchor, $r$((task_snapshot->>'visibility'='private'
                  OR (OLD.trigger_type='event'
                    AND task_snapshot->>'runMode'='new_session_per_run'
                    AND EXISTS (
                    SELECT 1 FROM scheduled_task_event_occurrences occurrence
                    WHERE occurrence.account_id=OLD.account_id
                      AND occurrence.workspace_id=OLD.workspace_id
                      AND occurrence.task_id=OLD.task_id
                      AND OLD.producer_key='scheduled-task-event:' || occurrence.id::text
                      AND pg_catalog.jsonb_path_exists(occurrence.events,
                        '$[*] ? (@.ownerOnly == true)'::jsonpath))))$r$);
  EXECUTE definition;
END
$migration$;

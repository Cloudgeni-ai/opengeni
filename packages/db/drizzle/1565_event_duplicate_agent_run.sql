-- deployment-mode: rolling
-- One delivery starts at most one run per agent (docs/design/automations-and-events.md): when
-- several automations of the same agent match it, the others record a skipped
-- run with reason duplicate_agent_run, which the refusal guard now allows.
-- The previous release never records that reason; this release records it in
-- a savepoint, so before this migration a refused receipt only goes missing.
-- Unchanged from migration 1105 apart from the new reason.
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
      'chain_limit', 'duplicate_agent_run')
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

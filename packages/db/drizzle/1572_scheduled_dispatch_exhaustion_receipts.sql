-- deployment-mode: rolling
-- Allow the existing immutable, unaccepted run receipt to also record a fire
-- whose dispatch exhausted its retries. That occurrence is failed, while a
-- later one may work (retryable=true, so even old blocker reviewers never
-- treat it as a hard refusal). Signatures, grants, and other reasons stay put.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION opengeni_private.guard_scheduled_admission_refusal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  task_row scheduled_tasks%ROWTYPE;
  dispatch_exhausted boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.admission_refusal IS DISTINCT FROM OLD.admission_refusal
      OR (OLD.admission_refusal IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
    THEN RAISE EXCEPTION 'scheduled admission refusal is immutable' USING ERRCODE = '42501'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.admission_refusal IS NULL THEN RETURN NEW; END IF;
  dispatch_exhausted := coalesce(NEW.admission_refusal ->> 'reason' = 'scheduled_dispatch_exhausted', false);
  IF (NEW.action_kind IS DISTINCT FROM 'agent_turn'
      AND NOT (dispatch_exhausted AND NEW.action_kind = 'app_sync'))
    OR (dispatch_exhausted AND (NEW.trigger_type NOT IN ('scheduled', 'event')
      OR NEW.admission_refusal -> 'retryable' IS DISTINCT FROM 'true'::jsonb))
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
      'chain_limit', 'duplicate_agent_run', 'scheduled_dispatch_exhausted')
    OR NEW.error IS DISTINCT FROM NEW.admission_refusal ->> 'reason'
    OR NEW.status IS DISTINCT FROM (CASE
      WHEN dispatch_exhausted OR NOT (NEW.admission_refusal ->> 'retryable')::boolean
      THEN 'failed' ELSE 'skipped' END)
    OR NEW.completed_at IS NULL OR nullif(btrim(NEW.producer_key),'') IS NULL
    OR NEW.session_id IS NOT NULL OR NEW.trigger_event_id IS NOT NULL
    OR NEW.accepted_execution_snapshot IS NOT NULL OR NEW.accepted_execution_digest IS NOT NULL
    OR NEW.knowledge_sync_run_id IS NOT NULL OR NEW.knowledge_summary IS NOT NULL
  THEN RAISE EXCEPTION 'invalid scheduled admission refusal' USING ERRCODE = '22023'; END IF;
  SELECT task.* INTO STRICT task_row FROM scheduled_tasks task
    WHERE task.id = NEW.task_id AND task.workspace_id = NEW.workspace_id
      AND task.account_id = NEW.account_id FOR UPDATE;
  IF task_row.status <> 'active' OR task_row.deleted_at IS NOT NULL
    OR task_row.action ->> 'kind' IS DISTINCT FROM NEW.action_kind
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

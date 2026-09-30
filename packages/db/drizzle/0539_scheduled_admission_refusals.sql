-- deployment-mode: rolling
-- A scheduled occurrence the scheduler refuses before accepting execution is a
-- visible run receipt, never an activity retried to exhaustion with no run or a
-- silently dropped occurrence. `admission_refusal` is a content-free,
-- enumerated reason plus whether the refusal is transient:
--   retryable = true  -> status 'skipped': this occurrence is not run; a later
--                        occurrence is admitted normally once the condition
--                        clears (credits, usage limits, an inactive machine).
--   retryable = false -> status 'failed': every occurrence is refused until
--                        the task or a resource it names changes.
-- It never carries an accepted execution, session, or raw exception text, and
-- is immutable once written. Connection-account refusals keep their 0534
-- `admission_diagnostic` receipt; the two are mutually exclusive.
-- Rolling: additive nullable column; old writers never set it, old readers do
-- not select it, and an old worker replays such a row as an ordinary terminal
-- run without accepted execution.
ALTER TABLE scheduled_task_runs ADD COLUMN admission_refusal jsonb;

CREATE FUNCTION opengeni_private.guard_scheduled_admission_refusal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
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
      'insufficient_credits', 'monthly_model_cost_limit', 'monthly_agent_run_limit')
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
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_scheduled_admission_refusal() FROM PUBLIC;
CREATE TRIGGER scheduled_admission_refusal_immutable BEFORE INSERT OR UPDATE ON scheduled_task_runs
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_scheduled_admission_refusal();

-- Ordinary accepted runs keep the exact existing validation functions; refused
-- receipts (either kind) carry no accepted snapshot and cannot acquire one.
DROP TRIGGER scheduled_agent_run_execution_admission ON scheduled_task_runs;
CREATE TRIGGER scheduled_agent_run_execution_admission BEFORE INSERT ON scheduled_task_runs
FOR EACH ROW WHEN (NEW.admission_diagnostic IS NULL AND NEW.admission_refusal IS NULL)
EXECUTE FUNCTION admit_scheduled_agent_run_execution();
DROP TRIGGER scheduled_run_owner_matches ON scheduled_task_runs;
CREATE TRIGGER scheduled_run_owner_matches BEFORE INSERT ON scheduled_task_runs
FOR EACH ROW WHEN (NEW.admission_diagnostic IS NULL AND NEW.admission_refusal IS NULL)
EXECUTE FUNCTION opengeni_private.guard_scheduled_run_owner();

DO $refusal_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.guard_scheduled_admission_refusal() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $refusal_path$;

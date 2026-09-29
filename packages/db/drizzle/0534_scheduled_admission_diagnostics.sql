-- deployment-mode: rolling
-- Refused occurrences are terminal evidence, never accepted execution. Reuse
-- the run history and producer key without creating a session or authority.
ALTER TABLE scheduled_task_runs ADD COLUMN admission_diagnostic jsonb;

CREATE FUNCTION opengeni_private.guard_scheduled_admission_diagnostic()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE task_row scheduled_tasks%ROWTYPE; item jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.admission_diagnostic IS DISTINCT FROM OLD.admission_diagnostic
      OR (OLD.admission_diagnostic IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
    THEN RAISE EXCEPTION 'scheduled admission refusal is immutable' USING ERRCODE = '42501'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.admission_diagnostic IS NULL THEN RETURN NEW; END IF;
  IF NEW.action_kind IS DISTINCT FROM 'agent_turn'
    OR NEW.status IS DISTINCT FROM 'failed'
    OR NEW.error IS DISTINCT FROM 'connection_account_unavailable'
    OR NEW.completed_at IS NULL OR nullif(btrim(NEW.producer_key),'') IS NULL
    OR NEW.session_id IS NOT NULL OR NEW.trigger_event_id IS NOT NULL
    OR NEW.accepted_execution_snapshot IS NOT NULL OR NEW.accepted_execution_digest IS NOT NULL
    OR NEW.knowledge_sync_run_id IS NOT NULL OR NEW.knowledge_summary IS NOT NULL
    OR jsonb_typeof(NEW.admission_diagnostic) IS DISTINCT FROM 'object'
    OR NEW.admission_diagnostic - ARRAY['version','reason','accounts'] <> '{}'::jsonb
    OR NEW.admission_diagnostic -> 'version' IS DISTINCT FROM '1'::jsonb
    OR coalesce(NEW.admission_diagnostic ->> 'reason','') NOT IN (
      'selected_account_unavailable','owner_access_unavailable','ambiguous_account',
      'parent_accounts_required','selection_unavailable')
    OR jsonb_typeof(NEW.admission_diagnostic -> 'accounts') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'invalid scheduled admission diagnostic' USING ERRCODE = '22023'; END IF;
  SELECT task.* INTO STRICT task_row FROM scheduled_tasks task
    WHERE task.id = NEW.task_id AND task.workspace_id = NEW.workspace_id
      AND task.account_id = NEW.account_id FOR UPDATE;
  IF task_row.status <> 'active' OR task_row.deleted_at IS NOT NULL
    OR task_row.action ->> 'kind' IS DISTINCT FROM 'agent_turn'
    OR NEW.task_authority_revision IS DISTINCT FROM task_row.authority_revision
    OR NEW.task_execution_digest IS DISTINCT FROM task_row.execution_digest
  THEN RAISE EXCEPTION 'scheduled task changed before refusal recording' USING ERRCODE = '40001'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.admission_diagnostic -> 'accounts') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR item - ARRAY['serverId','connectionId','reason'] <> '{}'::jsonb
      OR jsonb_typeof(item -> 'serverId') IS DISTINCT FROM 'string'
      OR length(item ->> 'serverId') NOT BETWEEN 1 AND 256
      OR NOT item ? 'connectionId'
      OR (item -> 'connectionId' <> 'null'::jsonb AND
        (jsonb_typeof(item -> 'connectionId') <> 'string' OR
         item ->> 'connectionId' !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'))
      OR coalesce(item ->> 'reason','') NOT IN (
        'connector_unavailable','account_not_visible','account_inactive',
        'account_mismatch','selection_unavailable')
    THEN RAISE EXCEPTION 'invalid scheduled account diagnostic' USING ERRCODE = '22023'; END IF;
  END LOOP;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_scheduled_admission_diagnostic() FROM PUBLIC;
CREATE TRIGGER scheduled_admission_diagnostic_immutable BEFORE INSERT OR UPDATE ON scheduled_task_runs
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_scheduled_admission_diagnostic();

-- Ordinary accepted runs retain the exact existing validation functions.
-- Diagnostic rows instead satisfy the terminal-only guard above. They carry
-- no accepted snapshot, cannot acquire one, and cannot leave failed state.
DROP TRIGGER scheduled_agent_run_execution_admission ON scheduled_task_runs;
CREATE TRIGGER scheduled_agent_run_execution_admission BEFORE INSERT ON scheduled_task_runs
FOR EACH ROW WHEN (NEW.admission_diagnostic IS NULL)
EXECUTE FUNCTION admit_scheduled_agent_run_execution();
DROP TRIGGER scheduled_run_owner_matches ON scheduled_task_runs;
CREATE TRIGGER scheduled_run_owner_matches BEFORE INSERT ON scheduled_task_runs
FOR EACH ROW WHEN (NEW.admission_diagnostic IS NULL)
EXECUTE FUNCTION opengeni_private.guard_scheduled_run_owner();

DO $diagnostic_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.guard_scheduled_admission_diagnostic() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $diagnostic_path$;
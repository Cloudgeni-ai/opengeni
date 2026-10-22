-- deployment-mode: rolling
-- Explicit archive abandonment is not proof of provider loss. Only workers
-- that reconstruct this distinction may claim a session with the new receipt.
-- Existing receipt kinds and their v1/v2/v3 fences are unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION guard_explicit_workspace_recovery_warning() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE prior_subject text := coalesce(current_setting('opengeni.subject_id', true), '');
  prior_account text := coalesce(current_setting('opengeni.account_id', true), '');
  prior_workspace text := coalesce(current_setting('opengeni.workspace_id', true), '');
  needs_warning boolean;
BEGIN
  PERFORM set_config('opengeni.subject_id', '', true);
  PERFORM set_config('opengeni.account_id', NEW.account_id::text, true);
  PERFORM set_config('opengeni.workspace_id', NEW.workspace_id::text, true);
  SELECT EXISTS (SELECT 1 FROM session_command_receipts receipt
    WHERE receipt.account_id = NEW.account_id AND receipt.workspace_id = NEW.workspace_id
      AND receipt.target_session_id = NEW.session_id
      AND receipt.action = 'sandbox.recovery.fresh_workspace'
      AND receipt.result #>> '{freshWorkspace,reason}' = 'restore_abandoned') INTO needs_warning;
  PERFORM set_config('opengeni.subject_id', prior_subject, true);
  PERFORM set_config('opengeni.account_id', prior_account, true);
  PERFORM set_config('opengeni.workspace_id', prior_workspace, true);
  IF needs_warning AND current_setting('opengeni.filesystem_discontinuity_protocol_v4', true) IS DISTINCT FROM '4' THEN
    RAISE EXCEPTION 'session requires filesystem discontinuity warning protocol v4' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_explicit_workspace_recovery_warning() FROM PUBLIC;
CREATE TRIGGER explicit_workspace_recovery_warning_guard BEFORE INSERT ON session_turn_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_explicit_workspace_recovery_warning();

-- Old API/reaper processes may still attempt lease writes during rollout even
-- though old workers cannot claim the affected conversation. They must not
-- erase abandonment truth or publish an empty filesystem at the old generation.
CREATE FUNCTION guard_explicit_workspace_recovery_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE abandoned text := OLD.resume_state #>> '{opengeniFreshWorkspaceRecovery,abandonedRevision}';
BEGIN
  IF abandoned IS NOT NULL
     AND NEW.resume_state #>> '{sessionState,workspaceArchiveMeta,revision}' = abandoned
     AND NEW.resume_state #>> '{opengeniFreshWorkspaceRecovery,abandonedRevision}' IS DISTINCT FROM abandoned THEN
    RAISE EXCEPTION 'retained abandoned archive requires its recovery receipt' USING ERRCODE = '55000';
  END IF;
  IF OLD.liveness = 'warming' AND NEW.liveness = 'warm'
     AND OLD.resume_state #>> '{opengeniFreshWorkspaceRecovery,source}' = 'explicit'
     AND OLD.resume_state #>> '{opengeniFreshWorkspaceRecovery,status}' = 'accepted'
     AND NEW.workspace_generation <> OLD.workspace_generation + 1 THEN
    RAISE EXCEPTION 'explicit empty publication requires a new workspace generation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_explicit_workspace_recovery_publication() FROM PUBLIC;
CREATE TRIGGER explicit_workspace_recovery_publication_guard BEFORE UPDATE ON sandbox_leases
  FOR EACH ROW EXECUTE FUNCTION guard_explicit_workspace_recovery_publication();

DO $paths$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_explicit_workspace_recovery_warning() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
  EXECUTE format('ALTER FUNCTION %I.guard_explicit_workspace_recovery_publication() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
END
$paths$;

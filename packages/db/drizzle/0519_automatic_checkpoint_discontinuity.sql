-- deployment-mode: maintenance
-- A completed normal turn can now authorize recovery from its latest verified
-- checkpoint. Old workers do not read automatic discontinuity receipts, so
-- drain them before activation; every later claim must prove the v2 warning
-- protocol before it can run the restored session.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION guard_sandbox_recovery_warning_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE prior_subject text := coalesce(current_setting('opengeni.subject_id', true), '');
  prior_account text := coalesce(current_setting('opengeni.account_id', true), '');
  prior_workspace text := coalesce(current_setting('opengeni.workspace_id', true), '');
  consent_warning boolean;
  automatic_warning boolean;
BEGIN
  PERFORM set_config('opengeni.subject_id', '', true);
  PERFORM set_config('opengeni.account_id', NEW.account_id::text, true);
  PERFORM set_config('opengeni.workspace_id', NEW.workspace_id::text, true);
  SELECT
    EXISTS (SELECT 1 FROM session_command_receipts receipt
      WHERE receipt.account_id = NEW.account_id AND receipt.workspace_id = NEW.workspace_id
        AND receipt.target_session_id = NEW.session_id
        AND receipt.action = 'sandbox.recovery.consent' AND receipt.result ? 'operationId'),
    EXISTS (SELECT 1 FROM session_command_receipts receipt
      WHERE receipt.account_id = NEW.account_id AND receipt.workspace_id = NEW.workspace_id
        AND receipt.target_session_id = NEW.session_id
        AND receipt.action = 'sandbox.recovery.automatic' AND receipt.result ? 'checkpoint')
    INTO consent_warning, automatic_warning;
  PERFORM set_config('opengeni.subject_id', prior_subject, true);
  PERFORM set_config('opengeni.account_id', prior_account, true);
  PERFORM set_config('opengeni.workspace_id', prior_workspace, true);
  IF consent_warning
    AND current_setting('opengeni.filesystem_discontinuity_protocol_v1', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'session requires filesystem discontinuity warning protocol v1'
      USING ERRCODE = '55000';
  END IF;
  IF automatic_warning
    AND current_setting('opengeni.filesystem_discontinuity_protocol_v2', true) IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'session requires filesystem discontinuity warning protocol v2'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

-- An automatic receipt is permanent for its session, including after a failed
-- restore; the warning must survive compaction, retries and later box rotations.
-- Session deletion itself remains an allowed FK cascade.
CREATE FUNCTION guard_sandbox_automatic_warning_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE prior_subject text;
  prior_account text;
  prior_workspace text;
  parent_exists boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF OLD.action IS DISTINCT FROM 'sandbox.recovery.automatic'
    OR NOT (OLD.result ? 'checkpoint') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    prior_subject := coalesce(current_setting('opengeni.subject_id', true), '');
    prior_account := coalesce(current_setting('opengeni.account_id', true), '');
    prior_workspace := coalesce(current_setting('opengeni.workspace_id', true), '');
    PERFORM set_config('opengeni.subject_id', '', true);
    PERFORM set_config('opengeni.account_id', OLD.account_id::text, true);
    PERFORM set_config('opengeni.workspace_id', OLD.workspace_id::text, true);
    SELECT EXISTS (SELECT 1 FROM sessions WHERE id = OLD.target_session_id
      AND account_id = OLD.account_id AND workspace_id = OLD.workspace_id) INTO parent_exists;
    PERFORM set_config('opengeni.subject_id', prior_subject, true);
    PERFORM set_config('opengeni.account_id', prior_account, true);
    PERFORM set_config('opengeni.workspace_id', prior_workspace, true);
    IF parent_exists THEN
      RAISE EXCEPTION 'automatic checkpoint warning receipt is permanent for this session'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'automatic checkpoint warning receipt is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_automatic_warning_receipt() FROM PUBLIC;
CREATE TRIGGER sandbox_automatic_warning_receipt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON session_command_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_sandbox_automatic_warning_receipt();

DO $paths$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_recovery_warning_claim() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_automatic_warning_receipt() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
END
$paths$;

RESET statement_timeout;
RESET lock_timeout;
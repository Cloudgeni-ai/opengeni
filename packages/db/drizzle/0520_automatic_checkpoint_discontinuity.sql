-- deployment-mode: maintenance
-- A completed normal turn can now authorize recovery from its latest verified
-- checkpoint. Old workers do not read automatic discontinuity receipts, so
-- drain them before activation; every later claim must prove the v2 warning
-- protocol before it can run the restored session.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- The initial singleton selection must remain exclusive until verified warm
-- publication. The existing human-consent guard alone sees public_recovery,
-- whereas automatic selection is a separate lease-owned authority.
CREATE OR REPLACE FUNCTION guard_public_sandbox_recovery_session() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.sandbox_group_id IS NOT DISTINCT FROM OLD.sandbox_group_id
    AND NEW.active_sandbox_id IS NOT DISTINCT FROM OLD.active_sandbox_id
    AND NEW.active_epoch IS NOT DISTINCT FROM OLD.active_epoch THEN RETURN NEW; END IF;
  PERFORM 1 FROM sandbox_leases lease
    WHERE lease.workspace_id = NEW.workspace_id
      AND (lease.sandbox_group_id = NEW.sandbox_group_id
        OR (TG_OP = 'UPDATE' AND lease.sandbox_group_id = OLD.sandbox_group_id))
      AND (lease.public_recovery->>'status' = 'accepted'
        OR lease.resume_state #>> '{opengeniAutomaticCheckpointRecovery,status}' = 'accepted')
    FOR SHARE;
  IF FOUND THEN
    RAISE EXCEPTION 'selected sandbox checkpoint protects group membership and route'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_public_sandbox_recovery_lease() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE automatic_status text;
BEGIN
  IF NEW.public_recovery->>'status' = 'accepted'
    AND (TG_OP = 'INSERT' OR OLD.public_recovery->>'status' IS DISTINCT FROM 'accepted'
      OR NEW.public_recovery->>'operationId' IS DISTINCT FROM OLD.public_recovery->>'operationId')
    AND NOT coalesce((SELECT consent_enabled FROM opengeni_private.sandbox_recovery_rollout WHERE singleton), false) THEN
    RAISE EXCEPTION 'public checkpoint consent is not activated' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.public_recovery->>'status' = 'accepted' THEN
    IF NEW.current_checkpoint_artifact_id IS DISTINCT FROM OLD.current_checkpoint_artifact_id
      OR NEW.workspace_generation IS DISTINCT FROM OLD.workspace_generation
      OR NEW.archive_generation IS DISTINCT FROM OLD.archive_generation THEN
      RAISE EXCEPTION 'consented sandbox recovery pins the exact current checkpoint'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.liveness = 'warming' AND NEW.liveness = 'cold'
      AND NEW.public_recovery->>'status' = 'accepted' THEN
      NEW.public_recovery := jsonb_set(OLD.public_recovery, '{status}', '"failed"'::jsonb);
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
    AND OLD.resume_state #>> '{opengeniAutomaticCheckpointRecovery,status}' = 'accepted' THEN
    IF NEW.current_checkpoint_artifact_id IS DISTINCT FROM OLD.current_checkpoint_artifact_id
      OR NEW.workspace_generation IS DISTINCT FROM OLD.workspace_generation
      OR NEW.archive_generation IS DISTINCT FROM OLD.archive_generation THEN
      RAISE EXCEPTION 'automatic sandbox recovery pins the exact current checkpoint'
        USING ERRCODE = '55000';
    END IF;
    automatic_status := NEW.resume_state #>> '{opengeniAutomaticCheckpointRecovery,status}';
    IF OLD.liveness = 'warming' AND NEW.liveness = 'cold' AND automatic_status = 'accepted' THEN
      NEW.resume_state := jsonb_set(NEW.resume_state,
        '{opengeniAutomaticCheckpointRecovery,status}', '"failed"'::jsonb);
    ELSIF automatic_status IS DISTINCT FROM 'accepted' AND NOT (
      OLD.liveness = 'warming' AND NEW.liveness = 'warm'
      AND automatic_status = 'verified'
      AND NEW.resume_state #>> '{opengeniRecovery,restore,status}' = 'ready'
      AND NEW.resume_state #>> '{opengeniRecovery,workspace,status}' = 'ready'
    ) THEN
      RAISE EXCEPTION 'automatic sandbox recovery requires verified warm publication'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;

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
  EXECUTE format('ALTER FUNCTION %I.guard_public_sandbox_recovery_session() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
  EXECUTE format('ALTER FUNCTION %I.guard_public_sandbox_recovery_lease() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_recovery_warning_claim() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_automatic_warning_receipt() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
END
$paths$;

-- A short indexed audit window remains observable even if the committing
-- worker dies before incrementing a process-local counter. Return only two
-- aggregate counts; no workspace, session or provider identities cross the
-- fleet inventory boundary.
CREATE INDEX audit_events_sandbox_recovery_recent_idx
  ON audit_events (occurred_at)
  WHERE action IN (
    'sandbox.provider_missing_before_capture',
    'sandbox.automatic_checkpoint_recovery.authorized'
  );

DO $projection$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_private.sandbox_recovery_observations()
    RETURNS TABLE(provider_losses bigint, fallback_selections bigint)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      SELECT
        count(*) FILTER (WHERE action = 'sandbox.provider_missing_before_capture')::bigint,
        count(*) FILTER (WHERE action = 'sandbox.automatic_checkpoint_recovery.authorized')::bigint
      FROM %1$I.audit_events
      WHERE occurred_at >= pg_catalog.clock_timestamp() - interval '30 minutes'
        AND action IN (
          'sandbox.provider_missing_before_capture',
          'sandbox.automatic_checkpoint_recovery.authorized'
        )
    $body$;
  $definition$, target_schema);
END
$projection$;
REVOKE ALL ON FUNCTION opengeni_private.sandbox_recovery_observations() FROM PUBLIC;
DO $projection_grants$
DECLARE runtime_role text;
BEGIN
  FOR runtime_role IN SELECT jsonb_array_elements_text(
    current_setting('opengeni.migration_application_roles')::jsonb)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION opengeni_private.sandbox_recovery_observations() TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$projection_grants$;

RESET statement_timeout;
RESET lock_timeout;
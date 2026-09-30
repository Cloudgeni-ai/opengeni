-- deployment-mode: rolling
-- A definitively lost managed sandbox no longer dead-ends its sessions: shared
-- sandbox groups may select their latest verified checkpoint, and a group with
-- no usable checkpoint continues on a new EMPTY workspace. Every group member
-- receives a permanent warning receipt. This only guards the NEW receipt kind
-- and adds one fixed operator-ledger kind. Rows and receipts older images write
-- keep their exact 0526 behavior, and older images never create a fresh
-- receipt, so old and new API/control/turn images may overlap. An older worker
-- fails closed only for a session that holds a fresh-workspace receipt.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Canonical claims always INSERT, including exact-attempt ON CONFLICT replay,
-- so a worker that cannot reconstruct the empty-workspace warning can never
-- claim, or reattach to, an affected session. v3 workers also declare v1/v2.
CREATE OR REPLACE FUNCTION guard_sandbox_recovery_warning_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE prior_subject text := coalesce(current_setting('opengeni.subject_id', true), '');
  prior_account text := coalesce(current_setting('opengeni.account_id', true), '');
  prior_workspace text := coalesce(current_setting('opengeni.workspace_id', true), '');
  consent_warning boolean;
  automatic_warning boolean;
  fresh_warning boolean;
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
        AND receipt.action = 'sandbox.recovery.automatic' AND receipt.result ? 'checkpoint'),
    EXISTS (SELECT 1 FROM session_command_receipts receipt
      WHERE receipt.account_id = NEW.account_id AND receipt.workspace_id = NEW.workspace_id
        AND receipt.target_session_id = NEW.session_id
        AND receipt.action = 'sandbox.recovery.fresh_workspace' AND receipt.result ? 'freshWorkspace')
    INTO consent_warning, automatic_warning, fresh_warning;
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
  IF fresh_warning
    AND current_setting('opengeni.filesystem_discontinuity_protocol_v3', true) IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'session requires filesystem discontinuity warning protocol v3'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

-- Automatic checkpoint and empty-workspace receipts are permanent for their
-- session, including after a failed restore or later box rotation. Session
-- deletion itself remains an allowed FK cascade.
CREATE OR REPLACE FUNCTION guard_sandbox_automatic_warning_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE prior_subject text;
  prior_account text;
  prior_workspace text;
  parent_exists boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF NOT ((OLD.action = 'sandbox.recovery.automatic' AND OLD.result ? 'checkpoint')
    OR (OLD.action = 'sandbox.recovery.fresh_workspace' AND OLD.result ? 'freshWorkspace')) THEN
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
      RAISE EXCEPTION 'automatic sandbox recovery warning receipt is permanent for this session'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'automatic sandbox recovery warning receipt is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DO $paths$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_recovery_warning_claim() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_automatic_warning_receipt() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
END
$paths$;

-- The content-free operator ledger gains one fixed kind. It still stores only
-- audit event IDs; the source audit row is verified under live workspace RLS.
ALTER TABLE opengeni_private.sandbox_recovery_operator_receipts
  DROP CONSTRAINT sandbox_recovery_operator_receipts_kind_check,
  ADD CONSTRAINT sandbox_recovery_operator_receipts_kind_check CHECK (kind IN (
    'provider_missing_before_capture', 'checkpoint_fallback_selected', 'fresh_workspace_selected'
  ));

DROP FUNCTION opengeni_private.sandbox_recovery_observations();

DO $projection$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.record_sandbox_recovery_operator_event(
      event_id uuid, event_kind text
    ) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE expected_action text;
    BEGIN
      expected_action := CASE event_kind
        WHEN 'provider_missing_before_capture' THEN 'sandbox.provider_missing_before_capture'
        WHEN 'checkpoint_fallback_selected' THEN 'sandbox.automatic_checkpoint_recovery.authorized'
        WHEN 'fresh_workspace_selected' THEN 'sandbox.fresh_workspace_recovery.authorized'
        ELSE NULL END;
      IF expected_action IS NULL OR NOT EXISTS (
        SELECT 1 FROM %1$I.audit_events event
        WHERE event.id = event_id AND event.action = expected_action
          AND event.account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
          AND event.workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      ) THEN
        RAISE EXCEPTION 'sandbox recovery operator event is not attributable'
          USING ERRCODE = '42501';
      END IF;
      INSERT INTO opengeni_private.sandbox_recovery_operator_receipts(audit_event_id, kind)
      VALUES (event_id, event_kind) ON CONFLICT (audit_event_id) DO NOTHING;
    END $body$;
  $definition$, target_schema);
  -- Older readers select the first two columns by name; the added count is
  -- ignored by them.
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_private.sandbox_recovery_observations()
    RETURNS TABLE(provider_losses bigint, fallback_selections bigint, fresh_workspace_selections bigint)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      SELECT
        count(*) FILTER (WHERE kind = 'provider_missing_before_capture')::bigint,
        count(*) FILTER (WHERE kind = 'checkpoint_fallback_selected')::bigint,
        count(*) FILTER (WHERE kind = 'fresh_workspace_selected')::bigint
      FROM opengeni_private.sandbox_recovery_operator_receipts
      WHERE occurred_at >= pg_catalog.clock_timestamp() - interval '30 minutes'
    $body$;
  $definition$, target_schema);
END
$projection$;
REVOKE ALL ON FUNCTION opengeni_private.record_sandbox_recovery_operator_event(uuid, text) FROM PUBLIC;
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

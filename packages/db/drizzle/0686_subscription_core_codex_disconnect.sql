-- deployment-mode: maintenance
-- OPE-766. Deploy with the request-reservation callers: an old binary cannot
-- distinguish a token read from permission to start another physical request.
-- Local disconnect scrubs secrets immediately. A retained row is nonsecret
-- history, NOT a claim that an upstream request or token has been revoked.
SET LOCAL lock_timeout = '5s';

ALTER TABLE subscription_connections ADD COLUMN disconnected_at timestamptz;
ALTER TABLE subscription_connections ADD CONSTRAINT subscription_disconnected_secret_chk
  CHECK (disconnected_at IS NULL OR
    (status = 'disabled' AND credential_encrypted = '' AND provider_account_id IS NULL
      AND NOT allocator_enabled));

ALTER TABLE subscription_operation_leases
  ADD COLUMN request_id text,
  ADD COLUMN transport_attempt integer,
  ADD COLUMN request_reserved_at timestamptz,
  ADD COLUMN request_outcome text,
  ADD COLUMN request_observed_at timestamptz;
CREATE UNIQUE INDEX subscription_operation_request_identity_uq
  ON subscription_operation_leases(account_id, request_id, transport_attempt)
  WHERE request_id IS NOT NULL;
ALTER TABLE subscription_operation_leases ADD CONSTRAINT subscription_operation_request_shape_chk
  CHECK ((request_id IS NULL AND transport_attempt IS NULL AND request_reserved_at IS NULL
      AND request_outcome IS NULL AND request_observed_at IS NULL)
    OR (request_id IS NOT NULL AND transport_attempt IS NOT NULL AND request_outcome IS NOT NULL
      AND length(request_id) BETWEEN 1 AND 512 AND transport_attempt > 0
      AND request_reserved_at IS NOT NULL
      AND request_outcome IN ('reserved', 'response_received', 'refused', 'unknown')));

-- Retain the original authorization guard, widening only its workload labels.
-- Exact source assertions follow the repository's migration rewrite convention.
DO $request_kinds$
DECLARE item record; definition text; anchor text;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'subscription_operation_leases'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%operation_kind%'
  LOOP EXECUTE format('ALTER TABLE subscription_operation_leases DROP CONSTRAINT %I', item.conname); END LOOP;
  ALTER TABLE subscription_operation_leases ADD CONSTRAINT subscription_operation_leases_kind_chk
    CHECK (operation_kind IN ('image', 'realtime', 'transcription', 'model', 'credential_request', 'apps'));
  ALTER TABLE subscription_operation_leases ADD CONSTRAINT subscription_operation_leases_reference_chk
    CHECK ((turn_id IS NULL OR session_id IS NOT NULL)
      AND (session_id IS NOT NULL OR (turn_id IS NULL AND operation_kind IN ('transcription', 'credential_request', 'apps')))
      AND (operation_kind <> 'model' OR turn_id IS NOT NULL));
  definition := pg_get_functiondef('opengeni_private.guard_subscription_operation_lease_reference()'::regprocedure);
  anchor := $old$IF NEW.operation_kind <> 'transcription'
          OR nullif(current_setting('opengeni.subject_id', true), '') IS NULL
          OR nullif(current_setting('opengeni.initiating_human_subject_id', true), '') IS NULL$old$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'operation authority source changed';
  END IF;
  EXECUTE replace(definition, anchor, $new$IF NEW.operation_kind NOT IN ('transcription', 'credential_request', 'apps')
          OR (NEW.operation_kind <> 'apps' AND (
            nullif(current_setting('opengeni.subject_id', true), '') IS NULL
            OR nullif(current_setting('opengeni.initiating_human_subject_id', true), '') IS NULL))$new$);
END
$request_kinds$;

-- Every admission uses the same lock as disconnect/refresh. A successful
-- reservation is the linearization boundary, not proof fetch has started.
CREATE FUNCTION opengeni_private.guard_subscription_disconnect_admission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$
BEGIN
  IF NEW.provider <> 'codex' OR NEW.connection_id IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'subscription_operation_leases' THEN
    IF NEW.operation_kind = 'model' AND NEW.request_id IS NOT NULL THEN
      PERFORM 1 FROM session_turns turn WHERE turn.account_id = NEW.account_id
        AND turn.workspace_id = NEW.workspace_id AND turn.session_id = NEW.session_id
        AND turn.id = NEW.turn_id AND turn.active_attempt_id = NEW.attempt_id
        AND turn.execution_generation = NEW.generation AND turn.status = 'running'
        FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'model request no longer owns its exact attempt' USING ERRCODE = '42501';
      END IF;
      IF EXISTS (SELECT 1 FROM subscription_operation_leases prior
        WHERE prior.account_id = NEW.account_id AND prior.workspace_id = NEW.workspace_id
          AND prior.session_id = NEW.session_id AND prior.turn_id = NEW.turn_id
          AND prior.provider = 'codex' AND prior.operation_kind = 'model'
          AND prior.request_id IS NOT NULL AND (prior.request_outcome = 'unknown'
            OR (prior.request_outcome = 'reserved' AND prior.attempt_id <> NEW.attempt_id))) THEN
        RAISE EXCEPTION 'prior Codex request outcome is unresolved' USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  -- Match the caller's turn-before-connection lock order.
  PERFORM pg_advisory_xact_lock(hashtextextended('subscription-refresh:' || NEW.connection_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM subscription_connections connection
      WHERE connection.account_id = NEW.account_id AND connection.id = NEW.connection_id
        AND connection.disconnected_at IS NULL AND connection.status = 'active') THEN
    RAISE EXCEPTION 'subscription source is disconnected or unavailable' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'subscription_operation_leases' THEN
    IF NEW.operation_kind = 'apps' AND NOT EXISTS (
      SELECT 1 FROM opengeni_private.resolve_subscription_codex_apps_designation(NEW.account_id, NEW.workspace_id) designated
      WHERE designated.connection_id = NEW.connection_id AND designated.status = 'active'
    ) THEN
      RAISE EXCEPTION 'Apps request requires its exact active designation' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_disconnect_admission() FROM PUBLIC;
CREATE TRIGGER zz_subscription_lease_disconnect_admission
  BEFORE INSERT OR UPDATE OF connection_id, holder_id, generation ON subscription_leases
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_disconnect_admission();
CREATE TRIGGER zz_subscription_operation_disconnect_admission
  BEFORE INSERT OR UPDATE OF connection_id, holder_id, generation ON subscription_operation_leases
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_disconnect_admission();
CREATE TRIGGER zz_subscription_binding_disconnect_admission
  BEFORE INSERT OR UPDATE OF connection_id ON subscription_session_bindings
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_disconnect_admission();

CREATE FUNCTION opengeni_private.guard_subscription_disconnect_history()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $body$
BEGIN
  IF OLD.disconnected_at IS NOT NULL AND
    (NEW.disconnected_at IS DISTINCT FROM OLD.disconnected_at
      OR NEW.status <> 'disabled' OR NEW.credential_encrypted <> ''
      OR NEW.provider_account_id IS NOT NULL OR NEW.allocator_enabled) THEN
    RAISE EXCEPTION 'disconnected subscription identity cannot be reactivated' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_disconnect_history() FROM PUBLIC;
CREATE TRIGGER subscription_disconnect_history
  BEFORE UPDATE ON subscription_connections
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_disconnect_history();

CREATE FUNCTION opengeni_private.guard_subscription_request_history()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $body$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.request_id IS NOT NULL THEN
      NEW.request_reserved_at := clock_timestamp();
      NEW.request_outcome := 'reserved';
      NEW.request_observed_at := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.request_id IS NULL THEN
    IF TG_OP = 'UPDATE' AND NEW.request_id IS NOT NULL THEN
      RAISE EXCEPTION 'a request requires a new operation identity' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- Ordinary retention may cascade from a deleted session/workspace. Lease
  -- release, expiry and replacement must not erase unresolved request custody.
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'request history is not an expiring lease' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.account_id, NEW.workspace_id, NEW.operation_id, NEW.attempt_id,
      NEW.operation_kind, NEW.session_id, NEW.turn_id, NEW.provider, NEW.connection_id,
      NEW.holder_id, NEW.generation, NEW.request_id, NEW.transport_attempt, NEW.request_reserved_at)
    IS DISTINCT FROM ROW(OLD.account_id, OLD.workspace_id, OLD.operation_id, OLD.attempt_id,
      OLD.operation_kind, OLD.session_id, OLD.turn_id, OLD.provider, OLD.connection_id,
      OLD.holder_id, OLD.generation, OLD.request_id, OLD.transport_attempt, OLD.request_reserved_at)
    OR (OLD.request_outcome IN ('response_received', 'refused')
      AND NEW.request_outcome IS DISTINCT FROM OLD.request_outcome)
    OR (OLD.request_outcome <> 'reserved' AND NEW.request_outcome = 'reserved') THEN
    RAISE EXCEPTION 'request reservation is immutable and single use' USING ERRCODE = '55000';
  END IF;
  IF NEW.request_outcome IS DISTINCT FROM OLD.request_outcome THEN
    NEW.request_observed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_request_history() FROM PUBLIC;
CREATE TRIGGER aa_subscription_request_history BEFORE INSERT OR UPDATE OR DELETE
  ON subscription_operation_leases FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.guard_subscription_request_history();

-- Preserve the reviewed management authorization, personal-owner capability,
-- lock order and RLS. Replace only destructive lease pruning/removal. A later
-- connect creates a NEW id because the old upstream identity is cleared.
DO $disconnect$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.disconnect_subscription_codex_connection(uuid,uuid,text,uuid)'::regprocedure);
  anchor := $old$      -- An unresolved provider outcome in any workspace keeps the connection:
      -- its one upstream idempotency key must stay retryable.
      IF EXISTS (SELECT 1 FROM codex_reset_redemption_attempts attempt
        WHERE attempt.account_id = p_account_id AND attempt.credential_id = p_connection_id
          AND attempt.status = 'provider_started') THEN
        PERFORM opengeni_subscription_internal.drop_subscription_codex_owner_capabilities(p_account_id);
        RETURN 'unresolved_redemption';
      END IF;
      BEGIN
        DELETE FROM subscription_leases lease
        WHERE lease.account_id = p_account_id AND lease.connection_id = p_connection_id
          AND lease.leased_until <= clock_timestamp();
        DELETE FROM subscription_operation_leases lease
        WHERE lease.account_id = p_account_id AND lease.connection_id = p_connection_id
          AND lease.leased_until <= clock_timestamp();
        DELETE FROM subscription_connections connection
        WHERE connection.account_id = p_account_id AND connection.id = p_connection_id;
      EXCEPTION WHEN foreign_key_violation THEN
        -- A chat or operation lease still names it (leases are RESTRICT).
        PERFORM opengeni_subscription_internal.drop_subscription_codex_owner_capabilities(p_account_id);
        RETURN 'in_use';
      END;$old$;
  replacement := $new$      -- Irreversible local removal. Existing request/lease and unknown reset
      -- records remain nonsecret custody evidence. Expiry proves nothing about
      -- the upstream provider. No background worker is needed to remove secrets.
      UPDATE subscription_connections connection SET
        disconnected_at = coalesce(connection.disconnected_at, clock_timestamp()),
        status = 'disabled', credential_encrypted = '', provider_account_id = NULL,
        allocator_enabled = false, expires_at = NULL, last_error = NULL,
        updated_at = clock_timestamp()
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.disconnected_at IS NULL;
      DELETE FROM subscription_apps_designations designation
      WHERE designation.account_id = p_account_id AND designation.connection_id = p_connection_id;$new$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'disconnect authority source changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$disconnect$;

-- The owner capability is minted only inside the reviewed management routine.
-- It allows clearing this exact designation even in another private workspace;
-- it grants neither its session data nor another connection's designation.
CREATE POLICY subscription_codex_disconnect_designation ON subscription_apps_designations
  FOR DELETE USING (
    current_user = pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
      WHERE oid = 'subscription_apps_designations'::regclass))
    AND opengeni_private.subscription_codex_owner_capability_held(
      account_id, ARRAY['codex_connection_owner'], NULL, connection_id, false));
CREATE POLICY subscription_codex_disconnect_designation_read ON subscription_apps_designations
  FOR SELECT USING (
    current_user = pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
      WHERE oid = 'subscription_apps_designations'::regclass))
    AND opengeni_private.subscription_codex_owner_capability_held(
      account_id, ARRAY['codex_connection_owner'], NULL, connection_id, false));

DO $personal_projection$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.subscription_codex_personal_connections(uuid,uuid,text)'::regprocedure);
  anchor := 'AND connection.owner_subject_id = p_subject_id';
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'personal projection source changed';
  END IF;
  EXECUTE replace(definition, anchor, anchor || ' AND connection.disconnected_at IS NULL');
END
$personal_projection$;

DO $personal_management$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.manage_subscription_codex_personal(uuid,uuid,text,uuid,text,text,boolean,integer)'::regprocedure);
  anchor := $old$SELECT * INTO target FROM subscription_connections WHERE id = target.id FOR UPDATE;
        IF NOT FOUND THEN$old$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'personal management source changed';
  END IF;
  EXECUTE replace(definition, anchor, $new$SELECT * INTO target FROM subscription_connections WHERE id = target.id FOR UPDATE;
        IF NOT FOUND OR target.disconnected_at IS NOT NULL THEN$new$);
END
$personal_management$;

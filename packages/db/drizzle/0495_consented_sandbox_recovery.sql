-- deployment-mode: rolling
-- Consent stays DB-disabled until an operator verifies compatible immutable
-- API/control/turn images and templates. The permanent claim guard rejects
-- returning old workers for affected sessions even after consent is disabled.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $roles$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0495 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0495 invalid application roles' USING ERRCODE = '55000'; END IF;
END
$roles$;

-- Operator-owned release activation, never an API/UI or environment flag.
-- Runtime roles may inspect this one non-secret row but cannot activate it.
CREATE TABLE opengeni_private.sandbox_recovery_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  consent_enabled boolean NOT NULL DEFAULT false,
  release_evidence text,
  CHECK (NOT consent_enabled OR nullif(btrim(release_evidence), '') IS NOT NULL)
);
INSERT INTO opengeni_private.sandbox_recovery_rollout (singleton) VALUES (true);
REVOKE ALL ON opengeni_private.sandbox_recovery_rollout FROM PUBLIC;
DO $activation_acl$
DECLARE grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT role.rolname FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
    JOIN pg_roles role ON role.oid = acl.grantee
    WHERE relation.oid = 'opengeni_private.sandbox_recovery_rollout'::regclass
      AND acl.grantee <> relation.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON opengeni_private.sandbox_recovery_rollout FROM %I', grantee_name);
  END LOOP;
END
$activation_acl$;
DO $read_grants$
DECLARE runtime_role text;
BEGIN
  FOR runtime_role IN SELECT jsonb_array_elements_text(
    current_setting('opengeni.migration_application_roles')::jsonb)
  LOOP
    -- Fresh installation migrates before provisioning runtime roles. Existing
    -- rolling roles retain read access now; provisionRoles converges late roles.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format('GRANT SELECT ON opengeni_private.sandbox_recovery_rollout TO %I', runtime_role);
    END IF;
  END LOOP;
END
$read_grants$;

ALTER TABLE sandbox_leases ADD COLUMN public_recovery jsonb;
ALTER TABLE sandbox_leases ADD CONSTRAINT sandbox_public_recovery_shape CHECK (
  public_recovery IS NULL OR coalesce((
    jsonb_typeof(public_recovery) = 'object'
    AND public_recovery->>'version' = '1'
    AND public_recovery->>'status' IN ('accepted', 'verified', 'failed')
    AND public_recovery->>'sessionId' IS NOT NULL
    AND public_recovery->>'operationId' IS NOT NULL
    AND public_recovery->>'subjectId' IS NOT NULL
    AND jsonb_typeof(public_recovery->'selection') = 'object'
  ), false)
);

-- All session writers already hold the 0345 workspace tenancy fence. Consent
-- takes it exclusively BEFORE reading all group members. Afterwards this guard
-- prevents an attachment/route change through the entire provider restore.
CREATE FUNCTION guard_public_sandbox_recovery_session() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.sandbox_group_id IS NOT DISTINCT FROM OLD.sandbox_group_id
    AND NEW.active_sandbox_id IS NOT DISTINCT FROM OLD.active_sandbox_id
    AND NEW.active_epoch IS NOT DISTINCT FROM OLD.active_epoch THEN RETURN NEW; END IF;
  PERFORM 1 FROM sandbox_leases lease
    WHERE lease.workspace_id = NEW.workspace_id
      AND (lease.sandbox_group_id = NEW.sandbox_group_id
        OR (TG_OP = 'UPDATE' AND lease.sandbox_group_id = OLD.sandbox_group_id))
      AND lease.public_recovery->>'status' = 'accepted'
    FOR SHARE;
  IF FOUND THEN
    RAISE EXCEPTION 'consented sandbox recovery protects group membership and route'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_public_sandbox_recovery_session() FROM PUBLIC;
CREATE TRIGGER public_sandbox_recovery_session_guard
  BEFORE INSERT OR UPDATE OF sandbox_group_id, active_sandbox_id, active_epoch
  ON sessions FOR EACH ROW EXECUTE FUNCTION guard_public_sandbox_recovery_session();

-- The selected CURRENT reference is also the existing GC pin. A late capture
-- cannot replace it while restoration owns this exact choice. Failed creation
-- keeps provenance but ends this attempt; late callbacks still lose epoch CAS.
CREATE FUNCTION guard_public_sandbox_recovery_lease() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
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
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_public_sandbox_recovery_lease() FROM PUBLIC;
CREATE TRIGGER public_sandbox_recovery_lease_guard BEFORE INSERT OR UPDATE ON sandbox_leases
  FOR EACH ROW EXECUTE FUNCTION guard_public_sandbox_recovery_lease();

-- Finalized consent is the monotonic affected-session marker, independent of
-- lease lifetime, provider success/failure, history compaction and activation.
-- Only the actual FK cascade from deleting its owning session may remove it.
CREATE FUNCTION guard_sandbox_recovery_consent_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE prior_subject text;
  prior_account text;
  prior_workspace text;
  parent_exists boolean;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.action = 'sandbox.recovery.consent' AND OLD.result ? 'operationId' THEN
    IF TG_OP = 'DELETE' THEN
      -- Same tenant scope, neutral actor: an RLS-hidden private session must
      -- never look deleted. Its FK cascade sees the actual parent row gone.
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
        RAISE EXCEPTION 'checkpoint consent warning receipt is permanent for this session' USING ERRCODE = '55000';
      END IF;
      RETURN OLD;
    END IF;
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'checkpoint consent warning receipt is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.action = 'sandbox.recovery.consent'
    AND NEW.result ? 'operationId' AND (TG_OP = 'INSERT'
      OR OLD.action IS DISTINCT FROM 'sandbox.recovery.consent' OR NOT (OLD.result ? 'operationId'))
    AND NOT coalesce((SELECT consent_enabled FROM opengeni_private.sandbox_recovery_rollout WHERE singleton), false) THEN
    RAISE EXCEPTION 'public checkpoint consent is not activated' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_recovery_consent_receipt() FROM PUBLIC;
CREATE TRIGGER sandbox_recovery_consent_receipt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON session_command_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_sandbox_recovery_consent_receipt();

-- Canonical claims always INSERT, including exact-attempt ON CONFLICT replay.
-- BEFORE INSERT runs before conflict handling, so returning old workers cannot
-- reattach to a compatible worker's already-admitted attempt without warning.
CREATE FUNCTION guard_sandbox_recovery_warning_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE prior_subject text := coalesce(current_setting('opengeni.subject_id', true), '');
  prior_account text := coalesce(current_setting('opengeni.account_id', true), '');
  prior_workspace text := coalesce(current_setting('opengeni.workspace_id', true), '');
  warning_required boolean;
BEGIN
  -- Read the authoritative requirement, not an actor-filtered receipt list.
  -- The ordinary attempt RLS/admission guards still authorize the INSERT.
  PERFORM set_config('opengeni.subject_id', '', true);
  PERFORM set_config('opengeni.account_id', NEW.account_id::text, true);
  PERFORM set_config('opengeni.workspace_id', NEW.workspace_id::text, true);
  SELECT EXISTS (SELECT 1 FROM session_command_receipts receipt
    WHERE receipt.account_id = NEW.account_id AND receipt.workspace_id = NEW.workspace_id
      AND receipt.target_session_id = NEW.session_id
      AND receipt.action = 'sandbox.recovery.consent' AND receipt.result ? 'operationId') INTO warning_required;
  PERFORM set_config('opengeni.subject_id', prior_subject, true);
  PERFORM set_config('opengeni.account_id', prior_account, true);
  PERFORM set_config('opengeni.workspace_id', prior_workspace, true);
  IF warning_required AND current_setting('opengeni.filesystem_discontinuity_protocol_v1', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'session requires filesystem discontinuity warning protocol v1'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_sandbox_recovery_warning_claim() FROM PUBLIC;
CREATE TRIGGER sandbox_recovery_warning_claim_guard BEFORE INSERT ON session_turn_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_sandbox_recovery_warning_claim();

-- Explicit pg_temp last: an application-created temporary table must not
-- shadow the authoritative lease in an invoker trigger.
DO $paths$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_public_sandbox_recovery_session() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
  EXECUTE format('ALTER FUNCTION %I.guard_public_sandbox_recovery_lease() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_recovery_consent_receipt() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
  EXECUTE format('ALTER FUNCTION %I.guard_sandbox_recovery_warning_claim() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
END
$paths$;
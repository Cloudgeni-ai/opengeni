-- deployment-mode: maintenance
-- Old workers cannot inject the mandatory filesystem-discontinuity warning.
-- Drain every old API/control/turn worker and never restart a pre-0492 image.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0492 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0492 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0492 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;

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
  IF OLD.public_recovery->>'status' = 'accepted' THEN
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
CREATE TRIGGER public_sandbox_recovery_lease_guard BEFORE UPDATE ON sandbox_leases
  FOR EACH ROW EXECUTE FUNCTION guard_public_sandbox_recovery_lease();

-- Explicit pg_temp last: an application-created temporary table must not
-- shadow the authoritative lease in an invoker trigger.
DO $paths$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_public_sandbox_recovery_session() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
  EXECUTE format('ALTER FUNCTION %I.guard_public_sandbox_recovery_lease() SET search_path TO pg_catalog, %I, pg_temp', target_schema, target_schema);
END
$paths$;
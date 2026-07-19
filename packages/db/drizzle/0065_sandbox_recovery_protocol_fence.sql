-- deployment-mode: rolling
-- OPE-60: protect durable sandbox recovery transitions from old writers. A
-- recovery-aware row may only be changed by a writer that explicitly opts into
-- protocol v1 in the current transaction. Superusers remain available for
-- maintenance and emergency recovery.

CREATE OR REPLACE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.liveness IS DISTINCT FROM NEW.liveness
    OR OLD.instance_id IS DISTINCT FROM NEW.instance_id
    OR OLD.lease_epoch IS DISTINCT FROM NEW.lease_epoch
    OR OLD.resume_state IS DISTINCT FROM NEW.resume_state
    OR OLD.resume_backend_id IS DISTINCT FROM NEW.resume_backend_id
  ) AND (
    coalesce(OLD.resume_state ? 'opengeniRecovery', false)
    OR coalesce(NEW.resume_state ? 'opengeniRecovery', false)
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_roles
      WHERE rolname = session_user
        AND rolsuper
    ) AND current_setting('opengeni.sandbox_recovery_protocol_v1', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION
        'sandbox recovery protocol v1 is required for protected lease transitions'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sandbox_recovery_protocol_v1_guard ON sandbox_leases;
CREATE TRIGGER sandbox_recovery_protocol_v1_guard
BEFORE UPDATE OF liveness, instance_id, lease_epoch, resume_state, resume_backend_id
ON sandbox_leases
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v1();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v1() TO opengeni_app;
  END IF;
END $$;
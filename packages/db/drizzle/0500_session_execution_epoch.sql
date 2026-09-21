-- deployment-mode: rolling
-- Expand the execution fence independently of the later sharing cutover.
-- Old and new readers both retain strict revocation until 0501 is applied.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE sessions ADD COLUMN execution_authority_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
DO $backfill$
DECLARE workspace_id_value uuid;
BEGIN
  FOR workspace_id_value IN SELECT DISTINCT workspace_id FROM sessions ORDER BY workspace_id LOOP
    PERFORM acquire_session_tenancy_fence(workspace_id_value);
    UPDATE sessions SET execution_authority_epoch = authority_epoch
      WHERE workspace_id = workspace_id_value;
  END LOOP;
END
$backfill$;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions ADD CONSTRAINT sessions_execution_authority_epoch_bounds
  CHECK (execution_authority_epoch > 0 AND execution_authority_epoch <= authority_epoch);
CREATE FUNCTION derive_session_execution_authority_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.execution_authority_epoch := NEW.authority_epoch;
      ELSIF NEW.execution_authority_epoch IS DISTINCT FROM OLD.execution_authority_epoch THEN
        RAISE EXCEPTION 'execution authority floor is lifecycle-owned' USING ERRCODE='42501';
      ELSIF NEW.authority_epoch IS DISTINCT FROM OLD.authority_epoch THEN
        NEW.execution_authority_epoch := NEW.authority_epoch;
      END IF;
      RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION derive_session_execution_authority_epoch() FROM PUBLIC;
-- Runs after the existing authority capability guard. Neither function permits
-- callers to nominate an execution floor or bypass a visibility/owner fence.
CREATE TRIGGER sessions_z_execution_epoch BEFORE INSERT OR UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION derive_session_execution_authority_epoch();

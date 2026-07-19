-- deployment-mode: rolling
-- OPE-73: migration 0063 replaces the workflow-wake claim function after
-- migration 0061 grants it to the runtime role. DROP FUNCTION removes that
-- object ACL, so restore the least-privilege runtime grant on the replacement.

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT USAGE ON SCHEMA opengeni_private TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_session_workflow_wakes(integer)
      TO opengeni_app;
  END IF;
END $grants$;
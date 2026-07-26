-- deployment-mode: rolling
-- Migration 0063 recreates this SECURITY DEFINER function and revokes its
-- default PUBLIC authority. Restore only the runtime dispatcher's exact grant;
-- production Helm runs migrations without a separate provision-roles pass.
REVOKE ALL ON FUNCTION opengeni_private.claim_session_workflow_wakes(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_session_workflow_wakes(integer)
      TO opengeni_app;
  END IF;
END $$;
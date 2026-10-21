-- deployment-mode: rolling
-- 0897 created opengeni_private.workspace_membership_administers with the
-- default PUBLIC EXECUTE, so every role could call it, including dedicated
-- capability-only roles (the artifact outbox dispatcher) that must keep their
-- exact function sets. Row policies evaluate it as the application role and
-- the rewritten SECURITY DEFINER routines run as their owner, so ordinary
-- application EXECUTE is all it needs (same rule as 0852).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

REVOKE EXECUTE ON FUNCTION opengeni_private.workspace_membership_administers(text,jsonb) FROM PUBLIC;

DO $application_predicates$
DECLARE
  data_schema text := current_schema();
  role_name text;
BEGIN
  -- Match the established policy-helper grantees, never effective privileges
  -- on the repaired helper: PUBLIC previously made every role match it.
  FOR role_name IN
    SELECT DISTINCT r.rolname FROM pg_catalog.pg_roles r
    WHERE r.rolname = 'opengeni_app'
      OR r.rolname IN (
        SELECT configured.value FROM pg_catalog.jsonb_array_elements_text(
          coalesce(nullif(pg_catalog.current_setting('opengeni.migration_application_roles',true),''),'[]')::jsonb
        ) configured(value)
      )
      OR r.oid IN (
        SELECT acl.grantee FROM pg_catalog.pg_proc helper
        CROSS JOIN LATERAL pg_catalog.aclexplode(helper.proacl) acl
        WHERE helper.oid = pg_catalog.format(
          '%I.session_private_actor_visible(uuid,uuid,uuid,text)',data_schema
        )::regprocedure
        AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> helper.proowner
      )
  LOOP
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION opengeni_private.workspace_membership_administers(text,jsonb) TO %I',role_name);
  END LOOP;
END
$application_predicates$;

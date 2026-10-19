-- deployment-mode: rolling
-- Policy evaluation needs ordinary application EXECUTE, not PUBLIC EXECUTE.
-- Dedicated artifact roles enter through SECURITY DEFINER routines and must
-- retain their exact capability-only function sets.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

REVOKE EXECUTE ON FUNCTION opengeni_private.maintenance_claim_active(text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION opengeni_private.maintenance_title_event_visible(text,uuid) FROM PUBLIC;

DO $application_predicates$
DECLARE
  data_schema text := current_schema();
  role_name text;
BEGIN
  -- Match the established policy-helper grantees, never effective privileges
  -- on the repaired helpers: PUBLIC previously made every role match those.
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
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION opengeni_private.maintenance_claim_active(text,text) TO %I',role_name);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION opengeni_private.maintenance_title_event_visible(text,uuid) TO %I',role_name);
  END LOOP;
  -- Workspaces is deliberately non-RLS. These inert policies added no access
  -- and would become an unintended admission set if its posture ever changed.
  EXECUTE pg_catalog.format('DROP POLICY maintenance_wakes_select ON %I.workspaces',data_schema);
  EXECUTE pg_catalog.format('DROP POLICY maintenance_wakes_update ON %I.workspaces',data_schema);
END
$application_predicates$;

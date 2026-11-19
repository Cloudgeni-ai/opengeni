-- deployment-mode: rolling
-- Grants the runtime role EXECUTE on the deployment-wide Nango in-use check
-- (1482) and the live Nango connection owners listing (1487), which both
-- were created withheld: the previous release now knows them (its runtime
-- posture accepts them granted or withheld). Readiness requires them from
-- this release on. Deleting a Nango connection is then decided from every
-- non-revoked row that names it, and the Nango sweep also visits a person
-- whose only connection is gone.
--
-- Every configured application role gets them, as provisioning does.
DO $nango_definers_runtime_grant$
DECLARE
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.nango_connections_in_use_v1(text[]), opengeni_private.nango_live_connection_owners_v1(text, text, text, integer) TO %I',
      application_role
    );
  END LOOP;
END $nango_definers_runtime_grant$;

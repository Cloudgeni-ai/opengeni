-- deployment-mode: rolling
-- Grants the runtime role EXECUTE on the organization vault list (1218) and
-- the organization machine and rig list (1224), which both created withheld:
-- the previous release now knows them (its runtime posture accepts them
-- granted or withheld). Readiness requires them from this release on, and
-- organization owners and admins see every organization vault, machine and
-- sandbox environment wherever it works.
--
-- Every configured application role gets them, as provisioning does.
DO $organization_lists_runtime_grant$
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.list_organization_vaults_v1(uuid, jsonb), opengeni_private.list_organization_compute_v1(uuid, uuid, text) TO %I',
      application_role
    );
  END LOOP;
END $organization_lists_runtime_grant$;

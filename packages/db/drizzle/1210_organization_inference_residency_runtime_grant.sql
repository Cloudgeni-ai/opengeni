-- deployment-mode: rolling
-- Grants the runtime role EXECUTE on the EU-only inference change function,
-- which 1060 created withheld: the previous release now knows it (its runtime
-- posture accepts it granted or withheld). Readiness requires it from this
-- release on, and owners and admins can change the setting.
--
-- Every configured application role gets it, as provisioning does.
DO $organization_inference_residency_runtime_grant$
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.update_organization_inference_residency_v1(uuid, text, text, boolean, bigint, uuid) TO %I',
      application_role
    );
  END LOOP;
END $organization_inference_residency_runtime_grant$;

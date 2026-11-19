-- deployment-mode: rolling
-- Grants the runtime role EXECUTE on the organization-wide sandbox counts
-- (1475), which 1475 created withheld: the previous release now knows the
-- definer (its runtime posture accepts it granted or withheld). Readiness
-- requires it from this release on, and the per-organization and per-member
-- viewer-only limits and the running-box limit of each plan tier
-- (OPENGENI_SANDBOX_PLAN_LIMITS_JSON) are enforced at admission.
--
-- Every configured application role gets it, as provisioning does.
DO $organization_warm_sandbox_counts_runtime_grant$
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.organization_warm_sandbox_counts_v1(uuid, text, uuid) TO %I',
      application_role
    );
  END LOOP;
END $organization_warm_sandbox_counts_runtime_grant$;

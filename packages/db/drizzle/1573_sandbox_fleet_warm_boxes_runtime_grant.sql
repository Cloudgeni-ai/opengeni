-- deployment-mode: rolling
-- Grants the runtime role EXECUTE on the managed warm box count fleet pressure
-- reads (1492, redefined by 1572 to leave out sleeping compute sandboxes),
-- which 1492 created withheld: the previous release now knows the definer
-- (its runtime posture accepts it granted or withheld). Readiness requires it
-- from this release on, and fleet pressure counts only starting or warm boxes
-- on managed providers instead of every lease.
--
-- Every configured application role gets it, as provisioning does.
DO $sandbox_fleet_warm_boxes_runtime_grant$
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.sandbox_fleet_warm_boxes_v1() TO %I',
      application_role
    );
  END LOOP;
END $sandbox_fleet_warm_boxes_runtime_grant$;

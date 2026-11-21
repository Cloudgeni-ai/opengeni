-- deployment-mode: rolling
-- App package provenance (docs/app-packages.md "Provenance"): an app installed
-- or upgraded from a package records the package's id, so a later upgrade
-- can tell whether a package is a newer version of the same app.
--
-- It also grants the runtime EXECUTE on the app notification delivery
-- routine, which 1543 withheld because the binary then in production did not
-- know it. The pinned previous production binary must contain 1543: it knows
-- the routine and accepts it with or without EXECUTE; this release sends
-- site.notify notifications through it.
--
-- Rolling: one new nullable column the previous release never reads or
-- writes (its inserts leave it null), and a grant it accepts.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE workspace_artifacts ADD COLUMN IF NOT EXISTS package_id uuid;

-- Every configured application role gets the grant, as provisioning does.
DO $app_notification_delivery_grant$
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.deliver_app_notification_v1(uuid) TO %I',
      application_role
    );
  END LOOP;
END $app_notification_delivery_grant$;

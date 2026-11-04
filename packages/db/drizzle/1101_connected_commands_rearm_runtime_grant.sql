-- deployment-mode: rolling
-- Grants the runtime role EXECUTE on the connected-command re-arm, which 0984
-- created withheld: the previous release now knows it (its runtime posture
-- accepts it granted or withheld). Readiness requires it from this release on,
-- and a returning runner's inventory report makes the running commands it did
-- not answer for due again, instead of skipping that step.
--
-- Every configured application role gets it, as provisioning does.
DO $connected_commands_rearm_runtime_grant$
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.rearm_unanswered_connected_commands(uuid, uuid, text) TO %I',
      application_role
    );
  END LOOP;
END $connected_commands_rearm_runtime_grant$;

-- deployment-mode: rolling
-- Grants what 0998 withheld, now that the previous release knows these
-- objects (its runtime posture accepts them granted or withheld): full DML on
-- auth_passkeys and EXECUTE on mutate_managed_passkey. Readiness requires them
-- from this release on, and the previous release turns passkeys on once it
-- sees them granted.
--
-- Every configured application role gets them, as provisioning does.
DO $passkey_runtime_grants$
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
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth_passkeys TO %I',
      application_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION mutate_managed_passkey(text, text, jsonb) TO %I',
      application_role
    );
  END LOOP;
END $passkey_runtime_grants$;

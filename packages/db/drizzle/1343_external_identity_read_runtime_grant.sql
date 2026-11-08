-- deployment-mode: rolling
-- 1172 introduced this reader with runtime access deferred so the preceding
-- binary's runtime posture check could accept the schema. The previous release
-- now knows it and accepts either grant state. Activate it for established
-- external users: requests take the membership fence shared, not exclusively,
-- and do not provision or update an identity on every read. First use and all
-- lifecycle writers retain their existing exclusive fences.
DO $external_identity_read_grant$
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.read_external_identity_v1(uuid, text, text) TO %I',
      application_role
    );
  END LOOP;
END $external_identity_read_grant$;

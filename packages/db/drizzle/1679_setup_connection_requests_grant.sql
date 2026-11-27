-- deployment-mode: rolling
-- Grants the runtime EXECUTE on the admins' inbox notice when a member asks for
-- a connection, which 1599 withheld because the binary then in production did
-- not know the routine. The previous production release now contains 1599: it
-- knows the routine and accepts it with or without EXECUTE; this release
-- requires it. From here "Ask an admin" asks the workspace's admins in their
-- inbox instead of copying a link.
-- Every configured application role gets the grant, as provisioning does.
DO $setup_connection_requests_grant$
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.request_setup_connection_v1(uuid, uuid, text, text, text, text) TO %I',
      application_role
    );
  END LOOP;
END $setup_connection_requests_grant$;

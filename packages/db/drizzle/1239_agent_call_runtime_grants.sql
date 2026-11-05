-- deployment-mode: rolling
-- Grants what 1107 withheld once the pinned previous production binary knows
-- its agent-call and native push v2 definers. That binary accepts them with or
-- without EXECUTE; this release requires them. Keep the v1 push functions and
-- their grants intact for binaries still running during the rolling deploy.
-- Every configured application role gets these grants, as provisioning does.
DO $agent_call_runtime_grants$
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
      'GRANT EXECUTE ON FUNCTION
        opengeni_private.native_push_device_v2(text),
        opengeni_private.register_native_push_device_v2(text, text, text, text, text, text[], text),
        opengeni_private.claim_native_push_deliveries_v2(uuid, integer, integer),
        opengeni_private.agent_call_device_count_v1(text, boolean),
        opengeni_private.agent_call_ringing_v1(text),
        opengeni_private.ring_agent_call_v1(uuid, boolean)
      TO %I', application_role
    );
  END LOOP;
END $agent_call_runtime_grants$;

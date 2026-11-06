-- deployment-mode: rolling
-- Grants what 1240 withheld once the pinned previous production binary knows
-- the inventory of meeting tracks not yet kept compact. That binary accepts it
-- with or without EXECUTE; this release requires it. From here the recording
-- retention sweep also converts existing meetings' audio to the compact kept
-- format and deletes their uploaded pieces, a few tracks per run.
-- Every configured application role gets the grant, as provisioning does.
DO $recording_compact_inventory_grant$
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
        opengeni_private.list_uncompacted_recording_tracks_v1(integer, text)
      TO %I', application_role
    );
  END LOOP;
END $recording_compact_inventory_grant$;

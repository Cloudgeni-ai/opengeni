-- deployment-mode: rolling
-- Grants again the runtime EXECUTE on the inventory of meeting tracks not yet
-- kept compact (1240), which 1283 withheld because the binary then in
-- production (6327db2c) did not know the routine. The pinned previous
-- production binary now contains 1283: it knows the routine and accepts it
-- with or without EXECUTE; this release requires it. From here the recording
-- retention sweep also converts existing meetings' audio to the compact kept
-- format and deletes their uploaded pieces, a few tracks per run.
-- Every configured application role gets the grant, as provisioning does.
DO $recording_compact_inventory_regrant$
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
END $recording_compact_inventory_regrant$;

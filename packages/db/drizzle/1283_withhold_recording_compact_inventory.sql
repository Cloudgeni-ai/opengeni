-- deployment-mode: rolling
-- Withholds again the runtime EXECUTE that 1282 granted on the inventory of
-- meeting tracks not yet kept compact (1240). 1282 assumed the previous
-- production binary knew the routine, but production still ran 6327db2c,
-- which predates 1240: its readiness rejects any unknown SECURITY DEFINER the
-- runtime can execute, so its pods would go unready once 1282 committed and it
-- could not be rolled back to. This binary accepts the routine with or without
-- EXECUTE (runtime-posture DEFERRED_RUNTIME_PRIVATE_ROUTINES), and its sweep
-- leaves existing meetings as they are until a later migration grants it again.
-- The ordinal follows 1282 directly, so a database that has not applied 1282
-- yet runs both back to back and the grant never outlives the next migration.
-- Every configured application role loses the grant, as 1282 gave it.
SET LOCAL lock_timeout = '5s';
DO $recording_compact_inventory_withhold$
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
      'REVOKE EXECUTE ON FUNCTION
        opengeni_private.list_uncompacted_recording_tracks_v1(integer, text)
      FROM %I', application_role
    );
  END LOOP;
END $recording_compact_inventory_withhold$;

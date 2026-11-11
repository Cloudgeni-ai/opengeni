-- deployment-mode: rolling
-- 1359 introduced the session content collector and its inventory with
-- runtime access deferred so the preceding binary's runtime posture check
-- could accept the schema. The previous release now knows both and accepts
-- either grant state. Activate them: the session storage maintenance pass
-- deletes content blobs no model-context snapshot or tool catalog refers to
-- (docs/session-storage-lifecycle.md, "Collecting unreferenced blobs").
DO $session_content_collection_grant$
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.session_content_garbage_candidates_v1(integer) TO %I',
      application_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.collect_session_content_garbage_v1(uuid, uuid, integer) TO %I',
      application_role
    );
  END LOOP;
END $session_content_collection_grant$;

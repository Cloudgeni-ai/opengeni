-- deployment-mode: rolling
-- Grants the runtime EXECUTE on the inventory of cold sandboxes whose chats
-- are all archived, which 1404 withheld because the binary then in production
-- did not know the routine. The pinned previous production binary now
-- contains 1404: it knows the routine and accepts it with or without EXECUTE;
-- this release requires it. From here the sandbox reaper forgets the stopped
-- Modal or Docker sandbox of chats archived for a day, and the checkpoint
-- ledger deletes the saved workspace (a Modal snapshot or tar archive) nothing
-- names any more, as deleting the chats does.
-- Every configured application role gets the grant, as provisioning does.
DO $sandboxes_of_archived_chats_grant$
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
        opengeni_private.cold_sandboxes_of_archived_chats_v1(integer, uuid, uuid, integer)
      TO %I', application_role
    );
  END LOOP;
END $sandboxes_of_archived_chats_grant$;

-- deployment-mode: rolling
-- Grants the runtime EXECUTE on the inbox notice sync for a blocked automation
-- with no chat, which 1562 withheld because the binary then in production did
-- not know the routine. The pinned previous production binary now contains
-- 1562: it knows the routine and accepts it with or without EXECUTE; this
-- release requires it. From here the owner of a paused or blocked automation
-- that has no chat is told in their inbox.
-- Every configured application role gets the grant, as provisioning does.
DO $scheduled_task_blocker_inbox_notices_grant$
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
        opengeni_private.sync_scheduled_task_blocker_inbox_notice_v1(uuid)
      TO %I', application_role
    );
  END LOOP;
END $scheduled_task_blocker_inbox_notices_grant$;

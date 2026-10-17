-- deployment-mode: rolling
-- Exact read-only locator for authenticated runner completion events. Commands
-- can belong to a different workspace than their machine's control workspace.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.locate_connected_command_completion(
      p_control_workspace_id uuid, p_enrollment_id uuid,
      p_connection_instance_id text, p_op_id text
    ) RETURNS TABLE (account_id uuid, workspace_id uuid, session_id uuid, command_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY SELECT command.account_id, command.workspace_id, command.session_id, command.id
        FROM %1$I.session_background_commands command
        WHERE command.provider = 'connected_machine'
          AND command.control_workspace_id = p_control_workspace_id
          AND command.enrollment_id = p_enrollment_id
          AND command.connection_instance_id = p_connection_instance_id
          AND command.op_id = p_op_id
          AND command.state IN ('running', 'stopping');
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $create$, data_schema);
  REVOKE ALL ON FUNCTION opengeni_private.locate_connected_command_completion(uuid,uuid,text,text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.locate_connected_command_completion(uuid,uuid,text,text) TO opengeni_app;
  END IF;
END $install$;

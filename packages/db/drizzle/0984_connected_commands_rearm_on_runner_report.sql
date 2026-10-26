-- deployment-mode: rolling
-- A runner that reports again is asked once more about the commands it did
-- not answer for.
--
-- When a runner that reports its own operation inventory does not answer a
-- recovery request (it was offline), the reconciler records the running
-- command as provider_unanswered and leaves it to that runner (0860): it is
-- claimed again only on a completion notice, a stop, a proof or the runner's
-- retirement. A runner reports only operations it knows, though. An operation
-- whose start never reached it (sent while it was offline), or that it no
-- longer holds, never appears in its inventory and never completes, so the
-- command stayed running forever, although the same process came back.
--
-- rearm_unanswered_connected_commands makes those commands of one exact
-- runner process due again, for the API to call while that process reports
-- its inventory. The next reconciler pass asks the runner, which is talking
-- now and does not need waking: an operation it does not know answers lost
-- and the command settles lost; one it runs continues as usual. It changes
-- only running commands left to this exact process. Commands left to a
-- sandbox runner stay unclaimed whatever their outcome (0860), so this does
-- not poll a sleeping sandbox.
--
-- The commands already stuck this way are made due once here. A runner
-- still offline is recorded unanswered again, once, by the next pass.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.rearm_unanswered_connected_commands(
      p_control_workspace_id uuid, p_enrollment_id uuid, p_connection_instance_id text
    ) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE
      inventory_id uuid;
      access_id uuid;
      workspace_ids uuid[];
      workspace_value uuid;
      rearmed integer;
    BEGIN
      IF p_control_workspace_id IS NULL OR p_enrollment_id IS NULL
          OR p_connection_instance_id IS NULL OR p_connection_instance_id = '' THEN
        RAISE EXCEPTION 'connected-command re-arm needs an exact runner process'
          USING ERRCODE = '22023';
      END IF;
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      SELECT array_agg(DISTINCT command.workspace_id ORDER BY command.workspace_id) INTO workspace_ids
      FROM %1$I.session_background_commands command
      WHERE command.provider = 'connected_machine'
        AND command.control_workspace_id = p_control_workspace_id
        AND command.enrollment_id = p_enrollment_id
        AND command.connection_instance_id = p_connection_instance_id
        AND command.state = 'running'
        AND command.last_reconcile_outcome = 'provider_unanswered';
      FOREACH workspace_value IN ARRAY COALESCE(workspace_ids, ARRAY[]::uuid[]) LOOP
        PERFORM %1$I.acquire_session_tenancy_fence(workspace_value);
      END LOOP;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      access_id := opengeni_private.open_session_tenancy_fenced_access(%1$I.session_tenancy_fence_target_schema());
      UPDATE %1$I.session_background_commands command SET
        last_reconcile_outcome = 'runner_reported',
        reconcile_after = pg_catalog.now(),
        updated_at = pg_catalog.clock_timestamp()
      WHERE command.provider = 'connected_machine'
        AND command.workspace_id = ANY(COALESCE(workspace_ids, ARRAY[]::uuid[]))
        AND command.control_workspace_id = p_control_workspace_id
        AND command.enrollment_id = p_enrollment_id
        AND command.connection_instance_id = p_connection_instance_id
        AND command.state = 'running'
        AND command.last_reconcile_outcome = 'provider_unanswered'
        AND command.reconcile_claim_id IS NULL;
      GET DIAGNOSTICS rearmed = ROW_COUNT;
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      RETURN rearmed;
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $create$, data_schema);
  REVOKE ALL ON FUNCTION opengeni_private.rearm_unanswered_connected_commands(uuid,uuid,text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.rearm_unanswered_connected_commands(uuid,uuid,text) TO opengeni_app;
  END IF;
END $install$;

DO $heal$
DECLARE
  data_schema text := current_schema();
  inventory_id uuid;
  runner record;
  runners jsonb;
BEGIN
  inventory_id := opengeni_private.open_session_tenancy_fence_inventory(
    session_tenancy_fence_target_schema());
  EXECUTE format($select$
    SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'control_workspace_id', command.control_workspace_id,
        'enrollment_id', command.enrollment_id,
        'connection_instance_id', command.connection_instance_id)), '[]'::jsonb)
    FROM %1$I.session_background_commands command
    WHERE command.provider = 'connected_machine'
      AND command.state = 'running'
      AND command.last_reconcile_outcome = 'provider_unanswered'
      AND command.control_workspace_id IS NOT NULL
      AND command.enrollment_id IS NOT NULL
      AND command.connection_instance_id IS NOT NULL
  $select$, data_schema) INTO runners;
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
  FOR runner IN SELECT * FROM jsonb_to_recordset(runners)
      AS r(control_workspace_id uuid, enrollment_id uuid, connection_instance_id text) LOOP
    PERFORM opengeni_private.rearm_unanswered_connected_commands(
      runner.control_workspace_id, runner.enrollment_id, runner.connection_instance_id);
  END LOOP;
END $heal$;

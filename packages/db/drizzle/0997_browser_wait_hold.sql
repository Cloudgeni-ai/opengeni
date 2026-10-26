-- deployment-mode: rolling
-- An agent session that is working or deliberately waiting keeps the browser
-- it created or is using. While the session works (a turn is queued, running,
-- recovering, waiting for capacity or waiting on a person) or has an armed
-- input wait (wait_for_input), the browser is in use, but never longer than
-- 60 minutes (BROWSER_WAIT_HOLD_MAX_MS) after the browser's last use, so a
-- long turn or repeated waits cannot keep a browser nobody uses. Before this,
-- a Modal box holding only such a browser was released after the sandbox idle
-- grace and the browser relaunched later with new tab ids and without its
-- page state.
--
-- list_idle_interaction_leases changes with the same signature and result: a
-- box whose browser is held this way is no longer a candidate. The release
-- decision itself re-checks the same rule in the worker. A previous worker
-- still lists the box but its own decision releases it, exactly as before
-- this migration.
--
-- list_agent_held_browser_sessions is new: the browsers held by the same rule
-- across workspaces, for the API to renew a short hold on each browser's own
-- controller (browserd stops idle browsers by itself on every placement), with
-- the person to reach it as: the most recent person who started a turn of a
-- holding session. A browser held only by sessions no person started gets
-- none (null), and the API then leaves it to its plain idle release.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $install$
DECLARE
  data_schema text := current_schema();
  role_name text;
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.list_idle_interaction_leases(
      p_limit integer, p_idle_ms bigint)
    RETURNS TABLE(account_id uuid, workspace_id uuid, sandbox_group_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE inventory_id uuid; idle_before timestamptz;
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid idle interaction batch'; END IF;
      IF p_idle_ms IS NULL OR p_idle_ms < 60000 THEN RAISE EXCEPTION 'invalid idle window'; END IF;
      idle_before := now() - p_idle_ms * interval '1 millisecond';
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY SELECT lease.account_id, lease.workspace_id, lease.sandbox_group_id
      FROM %1$I.sandbox_leases lease
      WHERE lease.backend = 'modal' AND lease.liveness = 'warm' AND lease.instance_id IS NOT NULL
        AND lease.rotation_requested_at IS NULL AND lease.archive_capture_id IS NULL
        AND lease.unobservable_command_drain_ids IS NULL
        AND (lease.reaper_hold_until IS NULL OR lease.reaper_hold_until <= now())
        AND lease.holders_changed_at < idle_before
        AND EXISTS (SELECT 1 FROM %1$I.sandbox_lease_holders holder
          WHERE holder.lease_id = lease.id AND holder.kind = 'interaction')
        AND NOT EXISTS (SELECT 1 FROM %1$I.sandbox_lease_holders holder
          WHERE holder.lease_id = lease.id AND holder.kind NOT IN ('interaction', 'process'))
        AND NOT EXISTS (
          SELECT 1 FROM %1$I.sandbox_lease_holders holder
          LEFT JOIN %1$I.browser_sessions browser
            ON holder.holder_id LIKE 'browser-session:%%'
            AND browser.id = CASE WHEN holder.holder_id ~ '^browser-session:[0-9a-f-]{36}$'
              THEN substr(holder.holder_id, 17)::uuid END
            AND browser.account_id = holder.account_id AND browser.workspace_id = holder.workspace_id
          LEFT JOIN %1$I.computer_sessions computer
            ON holder.holder_id LIKE 'computer-session:%%'
            AND computer.id = CASE WHEN holder.holder_id ~ '^computer-session:[0-9a-f-]{36}$'
              THEN substr(holder.holder_id, 18)::uuid END
            AND computer.account_id = holder.account_id AND computer.workspace_id = holder.workspace_id
          WHERE holder.lease_id = lease.id AND holder.kind = 'interaction'
            AND (greatest(holder.last_heartbeat_at, browser.last_used_at,
                browser.controller_heartbeat_at, computer.last_used_at,
                computer.controller_heartbeat_at) >= idle_before
              OR EXISTS (SELECT 1 FROM %1$I.interaction_operations operation
                WHERE operation.workspace_id = holder.workspace_id
                  AND operation.state IN ('prepared', 'dispatched')
                  AND ((operation.resource_kind = 'browser_session' AND operation.resource_id = browser.id)
                    OR (operation.resource_kind = 'computer_session'
                      AND operation.resource_id = computer.id)))
              -- A working or waiting agent session keeps its browser (60
              -- minutes is BROWSER_WAIT_HOLD_MAX_MS).
              OR EXISTS (SELECT 1 FROM %1$I.browser_session_associations association
                JOIN %1$I.sessions waiting ON waiting.id = association.session_id
                  AND waiting.workspace_id = association.workspace_id
                WHERE association.workspace_id = browser.workspace_id
                  AND association.browser_session_id = browser.id
                  AND association.relationship IN ('created', 'using')
                  AND (waiting.status IN ('queued', 'running', 'requires_action', 'recovering',
                      'waiting_capacity')
                    OR waiting.input_wait_until > now())
                  AND browser.last_used_at > now() - interval '60 minutes'))
        )
      ORDER BY lease.holders_changed_at, lease.id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.list_agent_held_browser_sessions(
      p_limit integer, p_hold_max_ms bigint)
    RETURNS TABLE(account_id uuid, workspace_id uuid, browser_session_id uuid,
      route_subject_id text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'invalid held browser batch'; END IF;
      IF p_hold_max_ms IS NULL OR p_hold_max_ms < 60000 THEN RAISE EXCEPTION 'invalid hold cap'; END IF;
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY SELECT browser.account_id, browser.workspace_id, browser.id,
        (SELECT turn.initiating_human_subject_id
          FROM %1$I.browser_session_associations association
          JOIN %1$I.sessions holder ON holder.id = association.session_id
            AND holder.workspace_id = association.workspace_id
          JOIN %1$I.session_turns turn ON turn.workspace_id = holder.workspace_id
            AND turn.session_id = holder.id
          WHERE association.workspace_id = browser.workspace_id
            AND association.browser_session_id = browser.id
            AND association.relationship IN ('created', 'using')
            AND (holder.status IN ('queued', 'running', 'requires_action', 'recovering',
                'waiting_capacity')
              OR holder.input_wait_until > now())
            AND turn.initiating_human_subject_id IS NOT NULL
          ORDER BY turn.created_at DESC LIMIT 1)
      FROM %1$I.browser_sessions browser
      WHERE browser.lifecycle = 'active' AND browser.controller_generation IS NOT NULL
        AND browser.last_used_at > now() - p_hold_max_ms * interval '1 millisecond'
        AND EXISTS (SELECT 1 FROM %1$I.browser_session_associations association
          JOIN %1$I.sessions holder ON holder.id = association.session_id
            AND holder.workspace_id = association.workspace_id
          WHERE association.workspace_id = browser.workspace_id
            AND association.browser_session_id = browser.id
            AND association.relationship IN ('created', 'using')
            AND (holder.status IN ('queued', 'running', 'requires_action', 'recovering',
                'waiting_capacity')
              OR holder.input_wait_until > now()))
      ORDER BY browser.last_used_at DESC, browser.id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $create$, data_schema);

  REVOKE ALL ON FUNCTION opengeni_private.list_agent_held_browser_sessions(integer, bigint)
    FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.list_agent_held_browser_sessions(integer, bigint)
      TO opengeni_app;
  END IF;
  FOR role_name IN SELECT rolname FROM pg_roles
    WHERE rolname <> current_user AND has_function_privilege(oid,
      'opengeni_private.list_idle_interaction_leases(integer,bigint)', 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.list_agent_held_browser_sessions(integer, bigint) TO %I', role_name);
  END LOOP;
END
$install$;

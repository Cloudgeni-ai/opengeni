-- deployment-mode: rolling
-- An idle browser or desktop no longer keeps its Modal box warm. A browser or
-- computer holder joins the general idle rule: when nothing has used the box,
-- its sessions, its browsers or its desktops for the sandbox idle grace, the
-- reaper releases those holders and the ordinary drain saves /workspace and
-- stops the box. A checkpoint-capable browser is first saved and suspended
-- through the same system checkpoint the provider deadline uses, now with an
-- `idle` reason; a desktop, which has nothing to save, is marked lost.
--
-- Expand only. list_browser_deadline_checkpoints and
-- browser_deadline_checkpoint keep their signatures; a target without a
-- reason is the provider-deadline target, so pre-0705 workers behave exactly
-- as before. They strip the new reason field and therefore skip idle targets,
-- which newer workers continue.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $install$
DECLARE
  data_schema text := current_schema();
  role_name text;
BEGIN
  -- One digest for both system checkpoint reasons. The provider-deadline
  -- digest is byte-identical to 0564, so an operation prepared before this
  -- migration keeps its authority.
  EXECUTE $create$
    CREATE OR REPLACE FUNCTION opengeni_private.browser_system_checkpoint_digest(
      p_reason text, p_account_id uuid, p_workspace_id uuid, p_lease_id uuid,
      p_lease_epoch bigint, p_instance_id text, p_browser_session_id text,
      p_controller_generation text
    ) RETURNS text
    LANGUAGE sql STABLE SET search_path = pg_catalog
    AS $body$
      SELECT encode(sha256(convert_to(jsonb_build_array(
        CASE p_reason WHEN 'idle' THEN 'browser-idle.v1' ELSE 'browser-provider-deadline.v1' END,
        p_account_id, p_workspace_id, p_lease_id, p_lease_epoch, p_instance_id,
        p_browser_session_id, p_controller_generation
      )::text, 'UTF8')), 'hex')
    $body$;
  $create$;

  EXECUTE $create$
    CREATE OR REPLACE FUNCTION opengeni_private.browser_system_checkpoint_operation_id(
      p_digest text
    ) RETURNS uuid
    LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
    AS $body$
      SELECT (substr(p_digest, 1, 8) || '-' || substr(p_digest, 9, 4)
        || '-4' || substr(p_digest, 14, 3) || '-8' || substr(p_digest, 18, 3)
        || '-' || substr(p_digest, 21, 12))::uuid
    $body$;
  $create$;

  -- Due system browser checkpoints. Provider-deadline targets are unchanged.
  -- Idle targets exist only after the reaper's exact idle decision prepared
  -- their suspend operation; this inventory only continues them (capture,
  -- commit, cleanup), so a crashed checkpoint resumes on the next sweep.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.list_browser_deadline_checkpoints(p_limit integer)
    RETURNS SETOF jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      IF p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'Invalid browser checkpoint inventory bound' USING ERRCODE = '22023';
      END IF;
      PERFORM set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(
        %1$I.session_tenancy_fence_target_schema());
      RETURN QUERY
      SELECT due.target FROM (
        SELECT jsonb_build_object(
            'accountId', lease.account_id, 'workspaceId', lease.workspace_id,
            'sandboxGroupId', lease.sandbox_group_id, 'leaseId', lease.id,
            'leaseEpoch', lease.lease_epoch, 'instanceId', lease.instance_id,
            'browserSessionId', browser.id, 'controllerGeneration', browser.controller_generation
          ) AS target, 0 AS lane, lease.provider_deadline_at AS due_at,
          lease.id AS lease_id, browser.id AS browser_id
        FROM %1$I.sandbox_leases lease
        JOIN %1$I.browser_sessions browser
          ON browser.account_id = lease.account_id AND browser.workspace_id = lease.workspace_id
          AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
          AND browser.placement_instance_id = lease.instance_id
        WHERE lease.backend = 'modal' AND lease.liveness IN ('warming', 'warm')
          AND lease.rotation_reason = 'provider_deadline' AND lease.rotation_requested_at IS NOT NULL
          AND lease.provider_deadline_at > now() AND lease.instance_id IS NOT NULL
          AND browser.placement_kind = 'sandbox_group'
          AND browser.lifecycle IN ('active', 'suspending', 'suspended')
          AND browser.controller_generation IS NOT NULL AND browser.controller_id IS NOT NULL
          AND browser.capabilities->>'privateCheckpoint' = 'true'
          AND EXISTS (SELECT 1 FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = lease.id AND holder.kind = 'interaction'
              AND holder.account_id = browser.account_id AND holder.workspace_id = browser.workspace_id
              AND holder.holder_id = 'browser-session:' || browser.id::text)
        UNION ALL
        SELECT jsonb_build_object(
            'accountId', lease.account_id, 'workspaceId', lease.workspace_id,
            'sandboxGroupId', lease.sandbox_group_id, 'leaseId', lease.id,
            'leaseEpoch', lease.lease_epoch, 'instanceId', lease.instance_id,
            'browserSessionId', browser.id, 'controllerGeneration', browser.controller_generation,
            'reason', 'idle'
          ), 1, operation.created_at, lease.id, browser.id
        FROM %1$I.sandbox_leases lease
        JOIN %1$I.browser_sessions browser
          ON browser.account_id = lease.account_id AND browser.workspace_id = lease.workspace_id
          AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
          AND browser.placement_instance_id = lease.instance_id
        JOIN %1$I.interaction_operations operation
          ON operation.workspace_id = browser.workspace_id
          AND operation.account_id = browser.account_id
          AND operation.resource_kind = 'browser_session' AND operation.resource_id = browser.id
          AND operation.operation_id = opengeni_private.browser_system_checkpoint_operation_id(
            opengeni_private.browser_system_checkpoint_digest('idle', lease.account_id,
              lease.workspace_id, lease.id, lease.lease_epoch, lease.instance_id,
              browser.id::text, browser.controller_generation))
        WHERE lease.backend = 'modal' AND lease.liveness IN ('warming', 'warm')
          AND lease.instance_id IS NOT NULL
          AND browser.placement_kind = 'sandbox_group'
          AND browser.lifecycle IN ('suspending', 'suspended')
          AND browser.controller_generation IS NOT NULL AND browser.controller_id IS NOT NULL
          AND browser.capabilities->>'privateCheckpoint' = 'true'
          AND operation.kind = 'suspend' AND operation.actor_subject_id = 'system:sandbox-idle'
          AND operation.state IN ('prepared', 'dispatched', 'completed')
          AND EXISTS (SELECT 1 FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = lease.id AND holder.kind = 'interaction'
              AND holder.account_id = browser.account_id AND holder.workspace_id = browser.workspace_id
              AND holder.holder_id = 'browser-session:' || browser.id::text)
      ) due
      ORDER BY due.lane, due.due_at, due.lease_id, due.browser_id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END
    $body$;
  $create$, data_schema);

  -- The exact system checkpoint authority, for either reason. A deadline
  -- target still requires the requested provider-deadline rotation. An idle
  -- target needs no rotation; it may prepare only an active browser that has
  -- not been used for the target's idle window (the reaper's locked idle
  -- decision is the caller), and otherwise only continues its own operation.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.browser_deadline_checkpoint(
      p_target jsonb, p_prepare boolean, p_touch boolean
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE
      access_id uuid;
      reason text := coalesce(p_target->>'reason', 'provider_deadline');
      actor text;
      idle_ms bigint;
      holder_heartbeat timestamptz;
      lease %1$I.sandbox_leases%%ROWTYPE;
      browser %1$I.browser_sessions%%ROWTYPE;
      operation %1$I.interaction_operations%%ROWTYPE;
      scope_digest text;
      operation_id_value uuid;
      result jsonb;
    BEGIN
      IF reason NOT IN ('provider_deadline', 'idle') THEN
        RAISE EXCEPTION 'Invalid browser checkpoint reason' USING ERRCODE = '22023';
      END IF;
      actor := CASE reason WHEN 'idle' THEN 'system:sandbox-idle'
        ELSE 'system:sandbox-provider-deadline' END;
      PERFORM set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);
      PERFORM %1$I.acquire_session_tenancy_fence((p_target->>'workspaceId')::uuid);
      access_id := opengeni_private.open_session_tenancy_fenced_access(
        %1$I.session_tenancy_fence_target_schema());
      -- Fence -> lease -> holder -> operation -> browser is the reaper's order.
      SELECT candidate.* INTO lease FROM %1$I.sandbox_leases candidate
      WHERE candidate.id = (p_target->>'leaseId')::uuid
        AND candidate.account_id = (p_target->>'accountId')::uuid
        AND candidate.workspace_id = (p_target->>'workspaceId')::uuid
        AND candidate.sandbox_group_id = (p_target->>'sandboxGroupId')::uuid
        AND candidate.lease_epoch = (p_target->>'leaseEpoch')::bigint
        AND candidate.instance_id = p_target->>'instanceId'
        AND candidate.backend = 'modal' AND candidate.liveness IN ('warming', 'warm')
        AND (reason = 'idle' OR (candidate.rotation_reason = 'provider_deadline'
          AND candidate.rotation_requested_at IS NOT NULL AND candidate.provider_deadline_at > now()))
      FOR UPDATE;
      IF NOT FOUND THEN
        PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
        RETURN NULL;
      END IF;
      SELECT holder.last_heartbeat_at INTO holder_heartbeat FROM %1$I.sandbox_lease_holders holder
      WHERE holder.lease_id = lease.id AND holder.account_id = lease.account_id
        AND holder.workspace_id = lease.workspace_id AND holder.kind = 'interaction'
        AND holder.holder_id = 'browser-session:' || (p_target->>'browserSessionId')
      FOR UPDATE;
      IF NOT FOUND THEN
        PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
        RETURN NULL;
      END IF;
      scope_digest := opengeni_private.browser_system_checkpoint_digest(reason,
        lease.account_id, lease.workspace_id, lease.id, lease.lease_epoch, lease.instance_id,
        p_target->>'browserSessionId', p_target->>'controllerGeneration');
      operation_id_value := opengeni_private.browser_system_checkpoint_operation_id(scope_digest);
      SELECT candidate.* INTO operation FROM %1$I.interaction_operations candidate
      WHERE candidate.workspace_id = lease.workspace_id
        AND candidate.resource_kind = 'browser_session'
        AND candidate.resource_id = (p_target->>'browserSessionId')::uuid
        AND (candidate.state IN ('prepared', 'dispatched') OR candidate.operation_id = operation_id_value)
      -- A different live operation wins over this checkpoint's completed
      -- receipt, so cleanup cannot cross a concurrent human transition.
      ORDER BY (candidate.state IN ('prepared', 'dispatched')) DESC,
        candidate.operation_id LIMIT 1 FOR UPDATE;
      IF FOUND AND (operation.operation_id <> operation_id_value
        OR operation.account_id <> lease.account_id OR operation.kind <> 'suspend'
        OR operation.actor_subject_id <> actor
        OR operation.request_digest <> scope_digest
        OR operation.state NOT IN ('prepared', 'dispatched', 'completed')) THEN
        PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
        RETURN NULL;
      END IF;
      SELECT candidate.* INTO browser FROM %1$I.browser_sessions candidate
      WHERE candidate.id = (p_target->>'browserSessionId')::uuid
        AND candidate.account_id = lease.account_id AND candidate.workspace_id = lease.workspace_id
        AND candidate.placement_kind = 'sandbox_group'
        AND candidate.controller_host_sandbox_group_id = lease.sandbox_group_id
        AND candidate.placement_instance_id = lease.instance_id
        AND candidate.controller_generation = p_target->>'controllerGeneration'
        AND candidate.controller_id IS NOT NULL
        AND candidate.capabilities->>'privateCheckpoint' = 'true'
      FOR UPDATE;
      IF NOT FOUND OR (operation.operation_id IS NULL AND (NOT p_prepare OR browser.lifecycle <> 'active'))
        OR (operation.state IN ('prepared', 'dispatched') AND browser.lifecycle <> 'suspending')
        OR (operation.state = 'completed' AND browser.lifecycle <> 'suspended') THEN
        PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
        RETURN NULL;
      END IF;
      IF operation.operation_id IS NULL AND reason = 'idle' THEN
        -- Someone using the browser (the live view's poll and heartbeat, a
        -- person's input, an agent tool call) is activity; a checkpoint never
        -- starts inside the idle window.
        idle_ms := (p_target->>'idleMs')::bigint;
        IF idle_ms IS NULL OR idle_ms < 60000 OR greatest(browser.last_used_at,
            browser.controller_heartbeat_at, holder_heartbeat)
            >= now() - idle_ms * interval '1 millisecond' THEN
          PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
          RETURN NULL;
        END IF;
      END IF;
      IF operation.operation_id IS NULL THEN
        INSERT INTO %1$I.interaction_operations (
          operation_id, account_id, workspace_id, resource_kind, resource_id,
          kind, request_digest, state, actor_subject_id
        ) VALUES (operation_id_value, lease.account_id, lease.workspace_id, 'browser_session',
          browser.id, 'suspend', scope_digest, 'prepared', actor)
        RETURNING * INTO operation;
        UPDATE %1$I.browser_sessions SET lifecycle = 'suspending', failure_code = NULL, updated_at = now()
        WHERE id = browser.id;
        UPDATE %1$I.workspace_interaction_revisions SET revision = revision + 1, updated_at = now()
        WHERE workspace_id = lease.workspace_id;
      END IF;
      IF p_touch AND operation.state IN ('prepared', 'dispatched') THEN
        UPDATE %1$I.interaction_operations SET updated_at = now() WHERE operation_id = operation_id_value;
        UPDATE %1$I.sandbox_lease_holders SET last_heartbeat_at = now()
        WHERE lease_id = lease.id AND kind = 'interaction' AND holder_id = 'browser-session:' || browser.id::text;
      END IF;
      result := jsonb_build_object('operationId', operation_id_value, 'state', operation.state);
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      RAISE;
    END
    $body$;
  $create$, data_schema);

  -- Discovery of warm Modal boxes that only idle browsers and desktops (and
  -- legacy retained commands, which containment owns) keep warm. Activity is
  -- the newest of the holder heartbeat and the resource's last use and
  -- controller heartbeat: every controller request (agent tool calls, a
  -- person's input, the visible live view's poll and 30 s heartbeat) moves
  -- all three, and a hidden or closed view stops within seconds. An in-flight
  -- lifecycle operation is activity too. The exact decision re-checks every
  -- fact, plus the whole sandbox group's sessions, under the workspace
  -- control fence and lease lock.
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
                      AND operation.resource_id = computer.id))))
        )
      ORDER BY lease.holders_changed_at, lease.id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $create$, data_schema);

  REVOKE ALL ON FUNCTION opengeni_private.browser_system_checkpoint_digest(text, uuid, uuid, uuid, bigint, text, text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.browser_system_checkpoint_operation_id(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.list_browser_deadline_checkpoints(integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.browser_deadline_checkpoint(jsonb, boolean, boolean) FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.list_idle_interaction_leases(integer, bigint) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.list_browser_deadline_checkpoints(integer) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.browser_deadline_checkpoint(jsonb, boolean, boolean) TO opengeni_app;
  END IF;
  FOR role_name IN SELECT rolname FROM pg_roles
    WHERE rolname <> current_user AND has_function_privilege(oid,
      'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)', 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.list_idle_interaction_leases(integer, bigint) TO %I', role_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.list_browser_deadline_checkpoints(integer) TO %I', role_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.browser_deadline_checkpoint(jsonb, boolean, boolean) TO %I', role_name);
  END LOOP;
END
$install$;

-- An idle-saved browser keeps its holder between the profile commit and the
-- controller cleanup, exactly as a deadline-saved one does in its window.
-- Without this, the orphan sweep could drop the holder mid-cleanup and leave
-- a suspended browser whose stale controller blocks every resume.
DO $retain_idle_checkpoint_cleanup$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.reap_stale_interaction_transitions(bigint)'::regprocedure);
  IF strpos(definition, '0705 idle checkpoint cleanup') = 0 THEN
    anchor := E'                AND lease.backend = ''modal'' AND lease.rotation_reason = ''provider_deadline''\n'
      || E'                AND lease.provider_deadline_at > pg_catalog.now()\n';
    replacement := format($condition$                AND lease.backend = 'modal' AND ((
                  lease.rotation_reason = 'provider_deadline'
                  AND lease.provider_deadline_at > pg_catalog.now()
                ) OR (
                  -- 0705 idle checkpoint cleanup: the exact saved generation.
                  lease.liveness IN ('warming', 'warm')
                  AND EXISTS (
                    SELECT 1 FROM %1$I.interaction_operations idle_suspend
                    WHERE idle_suspend.workspace_id = browser.workspace_id
                      AND idle_suspend.resource_kind = 'browser_session'
                      AND idle_suspend.resource_id = browser.id
                      AND idle_suspend.kind = 'suspend' AND idle_suspend.state = 'completed'
                      AND idle_suspend.actor_subject_id = 'system:sandbox-idle'
                      AND idle_suspend.operation_id
                        = opengeni_private.browser_system_checkpoint_operation_id(
                          opengeni_private.browser_system_checkpoint_digest('idle',
                            lease.account_id, lease.workspace_id, lease.id, lease.lease_epoch,
                            lease.instance_id, browser.id::text, browser.controller_generation))
                  )
                ))
$condition$, current_schema());
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 2 THEN
      RAISE EXCEPTION '0705 idle checkpoint cleanup prerequisite drift' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition, anchor, replacement);
  END IF;
END
$retain_idle_checkpoint_cleanup$;

RESET statement_timeout;
RESET lock_timeout;

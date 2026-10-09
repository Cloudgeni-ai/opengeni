-- deployment-mode: rolling
-- An idle Browser or Computer no longer pins its box. Interaction holders have
-- no timestamp expiry, so a desktop or browser nobody used for the idle window
-- kept a box warm until its provider deadline. When the rest of the group is
-- idle by the containment rules (0686), a checkpoint-capable managed browser
-- is saved through the provider-deadline checkpoint path (0564) under its own
-- actor and digest, and any other active Browser/Computer on the box is marked
-- lost with failure_code idle_released. Releasing an idle holder is not use:
-- it keeps the lease's holder-activity clock, so idle command containment and
-- the ordinary idle grace stop the box in the same sweep instead of a full
-- window later. Additive only: older workers never call these functions.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  -- The group rule of list_command_containment_candidates (0686), for a box
  -- whose holders are interaction holders plus, optionally, retained
  -- processes. Callers hold an inventory capability. Command output is not a
  -- fact here: the worker screens busy commands under tenant RLS first.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_lease_idle_for_interaction_release(
      p_lease_id uuid, p_idle_before timestamptz)
    RETURNS boolean
    LANGUAGE sql STABLE SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.sandbox_leases lease
        WHERE lease.id = p_lease_id
          AND lease.backend = 'modal' AND lease.liveness = 'warm'
          AND lease.instance_id IS NOT NULL
          AND lease.rotation_requested_at IS NULL
          AND lease.archive_capture_id IS NULL
          AND lease.unobservable_command_drain_ids IS NULL
          AND (lease.reaper_hold_until IS NULL OR lease.reaper_hold_until <= now())
          AND lease.holders_changed_at < p_idle_before
          AND EXISTS (
            SELECT 1 FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = lease.id AND holder.kind = 'interaction'
          )
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = lease.id AND holder.kind NOT IN ('interaction', 'process')
          )
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.sandbox_workspace_mutation_admissions admission
            WHERE admission.lease_id = lease.id AND admission.lease_epoch = lease.lease_epoch
              AND coalesce(admission.settled_at, admission.admitted_at) >= p_idle_before
          )
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.sessions member
            WHERE member.workspace_id = lease.workspace_id
              AND (member.sandbox_group_id = lease.sandbox_group_id OR EXISTS (
                SELECT 1 FROM %1$I.sandbox_retained_processes owned
                WHERE owned.lease_id = lease.id AND owned.state = 'active'
                  AND owned.session_id = member.id))
              AND (
                EXISTS (
                  SELECT 1 FROM %1$I.session_system_updates pending_update
                  WHERE pending_update.workspace_id = member.workspace_id
                    AND pending_update.session_id = member.id
                    AND pending_update.state = 'pending'
                    AND pending_update.created_at >= p_idle_before
                    AND (pending_update.kind IN ('scheduled_occurrence', 'goal_continuation',
                        'agent_message', 'agent_steer_instruction', 'session_wait_timeout',
                        'media_generation_result')
                      OR (pending_update.kind IN ('child_terminal_result', 'child_requires_action')
                        AND EXISTS (
                          SELECT 1 FROM %1$I.session_goals goal
                          WHERE goal.workspace_id = member.workspace_id
                            AND goal.session_id = member.id AND goal.status = 'active')))
                )
                OR EXISTS (
                  SELECT 1 FROM %1$I.session_turns turn
                  WHERE turn.workspace_id = member.workspace_id AND turn.session_id = member.id
                    -- requires_action waits for a person: not use. Recovery
                    -- is left to the machine.
                    AND turn.status IN ('queued', 'running', 'waiting_capacity', 'recovering')
                )
                OR EXISTS (
                  SELECT 1 FROM %1$I.session_turns turn
                  WHERE turn.workspace_id = member.workspace_id AND turn.session_id = member.id
                    AND turn.finished_at >= p_idle_before
                )
                OR EXISTS (
                  SELECT 1 FROM %1$I.session_turn_attempts attempt
                  WHERE attempt.workspace_id = member.workspace_id
                    AND attempt.session_id = member.id
                    AND (attempt.state <> 'closed' OR coalesce(attempt.quiesced_at,
                      attempt.closed_at, attempt.updated_at) >= p_idle_before)
                )
              )
          )
      )
    $body$;
  $create$, data_schema);

  -- Remove one interaction holder without moving the holder-activity clock.
  -- The caller holds the workspace fence, fenced access and the lease lock.
  -- Recounting matches releaseLeaseHolder: a warm box with no holder left
  -- enters its ordinary idle grace.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.release_idle_interaction_holder(
      p_lease_id uuid, p_holder_id text, p_idle_grace_ms bigint)
    RETURNS void
    LANGUAGE plpgsql SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      prior_clock timestamptz;
      prior_liveness text;
      total integer;
      turns integer;
      viewers integer;
    BEGIN
      SELECT lease.holders_changed_at, lease.liveness INTO prior_clock, prior_liveness
      FROM %1$I.sandbox_leases lease WHERE lease.id = p_lease_id;
      DELETE FROM %1$I.sandbox_lease_holders holder
      WHERE holder.lease_id = p_lease_id AND holder.kind = 'interaction'
        AND holder.holder_id = p_holder_id;
      IF NOT FOUND THEN
        RETURN;
      END IF;
      SELECT count(*)::integer, count(*) FILTER (WHERE kind = 'turn')::integer,
        count(*) FILTER (WHERE kind = 'viewer')::integer
      INTO total, turns, viewers
      FROM %1$I.sandbox_lease_holders WHERE lease_id = p_lease_id;
      UPDATE %1$I.sandbox_leases SET
        refcount = total, turn_holders = turns, viewer_holders = viewers,
        liveness = CASE WHEN prior_liveness = 'warm' AND total = 0 THEN 'draining' ELSE liveness END,
        expires_at = CASE WHEN prior_liveness = 'warm' AND total = 0
          THEN now() + p_idle_grace_ms * interval '1 millisecond' ELSE expires_at END,
        updated_at = now()
      WHERE id = p_lease_id;
      -- The recount trigger stamped the clock; a system release is not use.
      UPDATE %1$I.sandbox_leases SET holders_changed_at = prior_clock WHERE id = p_lease_id;
    END
    $body$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.list_idle_interaction_releases(
      p_limit integer, p_idle_ms bigint)
    RETURNS SETOF jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE inventory_id uuid; idle_before timestamptz;
    BEGIN
      IF p_limit < 1 OR p_limit > 500 OR p_idle_ms IS NULL
        OR p_idle_ms < 60000 OR p_idle_ms > 604800000 THEN
        RAISE EXCEPTION 'Invalid idle interaction inventory bound' USING ERRCODE = '22023';
      END IF;
      idle_before := now() - p_idle_ms * interval '1 millisecond';
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(
        %1$I.session_tenancy_fence_target_schema());
      RETURN QUERY
      SELECT candidate.target FROM (
        SELECT jsonb_build_object(
          'accountId', lease.account_id, 'workspaceId', lease.workspace_id,
          'sandboxGroupId', lease.sandbox_group_id, 'leaseId', lease.id,
          'leaseEpoch', lease.lease_epoch, 'instanceId', lease.instance_id,
          'resourceKind', 'browser_session', 'resourceId', browser.id,
          'checkpoint', browser.capabilities->>'privateCheckpoint' = 'true'
            AND browser.controller_generation IS NOT NULL AND browser.controller_id IS NOT NULL,
          'controllerGeneration', browser.controller_generation,
          'hasProcesses', EXISTS (SELECT 1 FROM %1$I.sandbox_lease_holders process_holder
            WHERE process_holder.lease_id = lease.id AND process_holder.kind = 'process')
        ) AS target, lease.holders_changed_at AS changed_at, lease.id AS lease_id,
          browser.id AS resource_id
        FROM %1$I.sandbox_leases lease
        JOIN %1$I.sandbox_lease_holders holder
          ON holder.lease_id = lease.id AND holder.kind = 'interaction'
        JOIN %1$I.browser_sessions browser
          ON holder.holder_id = 'browser-session:' || browser.id::text
          AND holder.account_id = browser.account_id AND holder.workspace_id = browser.workspace_id
          AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
        WHERE browser.placement_kind = 'sandbox_group' AND browser.lifecycle = 'active'
          AND (browser.placement_instance_id IS NULL OR browser.placement_instance_id = lease.instance_id)
          AND coalesce(greatest(browser.last_used_at, browser.controller_heartbeat_at,
            holder.last_heartbeat_at), browser.created_at) < idle_before
          AND opengeni_private.sandbox_lease_idle_for_interaction_release(lease.id, idle_before)
        UNION ALL
        SELECT jsonb_build_object(
          'accountId', lease.account_id, 'workspaceId', lease.workspace_id,
          'sandboxGroupId', lease.sandbox_group_id, 'leaseId', lease.id,
          'leaseEpoch', lease.lease_epoch, 'instanceId', lease.instance_id,
          'resourceKind', 'computer_session', 'resourceId', computer.id,
          'checkpoint', false, 'controllerGeneration', computer.controller_generation,
          'hasProcesses', EXISTS (SELECT 1 FROM %1$I.sandbox_lease_holders process_holder
            WHERE process_holder.lease_id = lease.id AND process_holder.kind = 'process')
        ), lease.holders_changed_at, lease.id, computer.id
        FROM %1$I.sandbox_leases lease
        JOIN %1$I.sandbox_lease_holders holder
          ON holder.lease_id = lease.id AND holder.kind = 'interaction'
        JOIN %1$I.computer_sessions computer
          ON holder.holder_id = 'computer-session:' || computer.id::text
          AND holder.account_id = computer.account_id AND holder.workspace_id = computer.workspace_id
          AND computer.sandbox_group_id = lease.sandbox_group_id
        WHERE computer.placement_kind = 'sandbox_group' AND computer.lifecycle = 'active'
          AND coalesce(greatest(computer.last_used_at, computer.controller_heartbeat_at,
            holder.last_heartbeat_at), computer.created_at) < idle_before
          AND opengeni_private.sandbox_lease_idle_for_interaction_release(lease.id, idle_before)
      ) candidate
      ORDER BY candidate.changed_at, candidate.lease_id, candidate.resource_id
      LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END
    $body$;
  $create$, data_schema);

  -- Marks one idle Computer, or a Browser that cannot be checkpointed, lost
  -- and releases its holder. Fence -> lease -> holder -> operation -> resource
  -- is the reaper's lock order; every fact is rechecked under those locks.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.release_idle_interaction_session(
      p_target jsonb, p_idle_ms bigint, p_idle_grace_ms bigint)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE
      access_id uuid;
      inventory_id uuid;
      idle_before timestamptz;
      lease %1$I.sandbox_leases%%ROWTYPE;
      holder %1$I.sandbox_lease_holders%%ROWTYPE;
      kind text := p_target->>'resourceKind';
      resource_id uuid := (p_target->>'resourceId')::uuid;
      holder_key text;
      released boolean := false;
    BEGIN
      IF kind NOT IN ('browser_session', 'computer_session') OR p_idle_ms IS NULL
        OR p_idle_ms < 60000 OR p_idle_ms > 604800000
        OR p_idle_grace_ms IS NULL OR p_idle_grace_ms < 0 THEN
        RAISE EXCEPTION 'Invalid idle interaction release' USING ERRCODE = '22023';
      END IF;
      idle_before := now() - p_idle_ms * interval '1 millisecond';
      holder_key := CASE kind WHEN 'browser_session' THEN 'browser-session:'
        ELSE 'computer-session:' END || resource_id::text;
      PERFORM set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);
      PERFORM %1$I.acquire_session_tenancy_fence((p_target->>'workspaceId')::uuid);
      access_id := opengeni_private.open_session_tenancy_fenced_access(
        %1$I.session_tenancy_fence_target_schema());
      -- The group rule reads update and goal rows that have inventory policies only.
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(
        %1$I.session_tenancy_fence_target_schema());
      SELECT candidate.* INTO lease FROM %1$I.sandbox_leases candidate
      WHERE candidate.id = (p_target->>'leaseId')::uuid
        AND candidate.account_id = (p_target->>'accountId')::uuid
        AND candidate.workspace_id = (p_target->>'workspaceId')::uuid
        AND candidate.sandbox_group_id = (p_target->>'sandboxGroupId')::uuid
        AND candidate.lease_epoch = (p_target->>'leaseEpoch')::bigint
        AND candidate.instance_id = p_target->>'instanceId'
      FOR UPDATE;
      IF FOUND AND opengeni_private.sandbox_lease_idle_for_interaction_release(lease.id, idle_before) THEN
        SELECT candidate.* INTO holder FROM %1$I.sandbox_lease_holders candidate
        WHERE candidate.lease_id = lease.id AND candidate.kind = 'interaction'
          AND candidate.account_id = lease.account_id AND candidate.workspace_id = lease.workspace_id
          AND candidate.holder_id = holder_key
        FOR UPDATE;
        -- A live human transition owns the resource; it settles on its own.
        IF FOUND AND NOT EXISTS (
          SELECT 1 FROM %1$I.interaction_operations operation
          WHERE operation.workspace_id = lease.workspace_id
            AND operation.resource_kind = kind AND operation.resource_id = resource_id
            AND operation.state IN ('prepared', 'dispatched')
        ) THEN
          IF kind = 'browser_session' THEN
            PERFORM browser.id FROM %1$I.browser_sessions browser
            WHERE browser.id = resource_id FOR UPDATE;
            UPDATE %1$I.browser_sessions browser
            SET lifecycle = 'lost', failure_code = 'idle_released', updated_at = now()
            WHERE browser.id = resource_id
              AND browser.account_id = lease.account_id AND browser.workspace_id = lease.workspace_id
              AND browser.placement_kind = 'sandbox_group'
              AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
              AND browser.lifecycle = 'active'
              AND coalesce(browser.capabilities->>'privateCheckpoint', '') <> 'true'
              AND coalesce(greatest(browser.last_used_at, browser.controller_heartbeat_at,
                holder.last_heartbeat_at), browser.created_at) < idle_before;
          ELSE
            PERFORM computer.id FROM %1$I.computer_sessions computer
            WHERE computer.id = resource_id FOR UPDATE;
            UPDATE %1$I.computer_sessions computer
            SET lifecycle = 'lost', failure_code = 'idle_released', updated_at = now()
            WHERE computer.id = resource_id
              AND computer.account_id = lease.account_id AND computer.workspace_id = lease.workspace_id
              AND computer.placement_kind = 'sandbox_group'
              AND computer.sandbox_group_id = lease.sandbox_group_id
              AND computer.lifecycle = 'active'
              AND coalesce(greatest(computer.last_used_at, computer.controller_heartbeat_at,
                holder.last_heartbeat_at), computer.created_at) < idle_before;
          END IF;
          IF FOUND THEN
            PERFORM opengeni_private.release_idle_interaction_holder(
              lease.id, holder_key, p_idle_grace_ms);
            UPDATE %1$I.workspace_interaction_revisions SET revision = revision + 1, updated_at = now()
            WHERE workspace_id = lease.workspace_id;
            released := true;
          END IF;
        END IF;
      END IF;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      RETURN released;
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      RAISE;
    END
    $body$;
  $create$, data_schema);

  -- The 0564 checkpoint contract for an idle box: same lock order, own actor
  -- and digest. Preparing requires the idle rule; an in-flight or completed
  -- checkpoint continues on the exact placement it started on.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.browser_idle_checkpoint(
      p_target jsonb, p_prepare boolean, p_touch boolean
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE
      access_id uuid;
      inventory_id uuid;
      idle_before timestamptz;
      lease %1$I.sandbox_leases%%ROWTYPE;
      holder %1$I.sandbox_lease_holders%%ROWTYPE;
      holder_found boolean;
      browser %1$I.browser_sessions%%ROWTYPE;
      operation %1$I.interaction_operations%%ROWTYPE;
      scope_digest text;
      operation_id_value uuid;
      result jsonb;
    BEGIN
      IF p_target->>'reason' IS DISTINCT FROM 'idle' OR (p_target->>'idleMs') IS NULL
        OR (p_target->>'idleMs')::bigint < 60000 OR (p_target->>'idleMs')::bigint > 604800000 THEN
        RAISE EXCEPTION 'Invalid idle browser checkpoint target' USING ERRCODE = '22023';
      END IF;
      idle_before := now() - (p_target->>'idleMs')::bigint * interval '1 millisecond';
      PERFORM set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);
      PERFORM %1$I.acquire_session_tenancy_fence((p_target->>'workspaceId')::uuid);
      access_id := opengeni_private.open_session_tenancy_fenced_access(
        %1$I.session_tenancy_fence_target_schema());
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(
        %1$I.session_tenancy_fence_target_schema());
      SELECT candidate.* INTO lease FROM %1$I.sandbox_leases candidate
      WHERE candidate.id = (p_target->>'leaseId')::uuid
        AND candidate.account_id = (p_target->>'accountId')::uuid
        AND candidate.workspace_id = (p_target->>'workspaceId')::uuid
        AND candidate.sandbox_group_id = (p_target->>'sandboxGroupId')::uuid
        AND candidate.lease_epoch = (p_target->>'leaseEpoch')::bigint
        AND candidate.instance_id = p_target->>'instanceId'
        AND candidate.backend = 'modal' AND candidate.liveness IN ('warming', 'warm')
      FOR UPDATE;
      IF NOT FOUND THEN
        PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
        PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
        RETURN NULL;
      END IF;
      SELECT candidate.* INTO holder FROM %1$I.sandbox_lease_holders candidate
      WHERE candidate.lease_id = lease.id AND candidate.account_id = lease.account_id
        AND candidate.workspace_id = lease.workspace_id AND candidate.kind = 'interaction'
        AND candidate.holder_id = 'browser-session:' || (p_target->>'browserSessionId')
      FOR UPDATE;
      holder_found := FOUND;
      scope_digest := encode(sha256(convert_to(jsonb_build_array(
        'browser-idle.v1', lease.account_id, lease.workspace_id,
        lease.id, lease.lease_epoch, lease.instance_id,
        p_target->>'browserSessionId', p_target->>'controllerGeneration'
      )::text, 'UTF8')), 'hex');
      operation_id_value := (substr(scope_digest, 1, 8) || '-' || substr(scope_digest, 9, 4)
        || '-4' || substr(scope_digest, 14, 3) || '-8' || substr(scope_digest, 18, 3)
        || '-' || substr(scope_digest, 21, 12))::uuid;
      SELECT candidate.* INTO operation FROM %1$I.interaction_operations candidate
      WHERE candidate.workspace_id = lease.workspace_id
        AND candidate.resource_kind = 'browser_session'
        AND candidate.resource_id = (p_target->>'browserSessionId')::uuid
        AND (candidate.state IN ('prepared', 'dispatched') OR candidate.operation_id = operation_id_value)
      ORDER BY (candidate.state IN ('prepared', 'dispatched')) DESC,
        candidate.operation_id LIMIT 1 FOR UPDATE;
      IF FOUND AND (operation.operation_id <> operation_id_value
        OR operation.account_id <> lease.account_id OR operation.kind <> 'suspend'
        OR operation.actor_subject_id <> 'system:sandbox-idle'
        OR operation.request_digest <> scope_digest
        OR operation.state NOT IN ('prepared', 'dispatched', 'completed')) THEN
        PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
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
      IF NOT FOUND
        OR (operation.operation_id IS NULL AND (NOT p_prepare OR browser.lifecycle <> 'active'
          OR NOT holder_found OR lease.liveness <> 'warm'
          OR coalesce(greatest(browser.last_used_at, browser.controller_heartbeat_at,
            holder.last_heartbeat_at), browser.created_at) >= idle_before
          OR NOT opengeni_private.sandbox_lease_idle_for_interaction_release(lease.id, idle_before)))
        OR (operation.state IN ('prepared', 'dispatched')
          AND (browser.lifecycle <> 'suspending' OR NOT holder_found))
        -- The reaper may already have released a suspended browser's holder.
        OR (operation.state = 'completed' AND browser.lifecycle <> 'suspended') THEN
        PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
        PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
        RETURN NULL;
      END IF;
      IF operation.operation_id IS NULL THEN
        INSERT INTO %1$I.interaction_operations (
          operation_id, account_id, workspace_id, resource_kind, resource_id,
          kind, request_digest, state, actor_subject_id
        ) VALUES (operation_id_value, lease.account_id, lease.workspace_id, 'browser_session',
          browser.id, 'suspend', scope_digest, 'prepared', 'system:sandbox-idle')
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
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      RAISE;
    END
    $body$;
  $create$, data_schema);

  -- The checkpoint's final cleanup releases the suspended browser's holder
  -- without moving the holder-activity clock (see release_idle_interaction_holder).
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.release_idle_checkpoint_holder(
      p_target jsonb, p_idle_grace_ms bigint
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE
      access_id uuid;
      lease %1$I.sandbox_leases%%ROWTYPE;
      released boolean := false;
    BEGIN
      IF p_idle_grace_ms IS NULL OR p_idle_grace_ms < 0 THEN
        RAISE EXCEPTION 'Invalid idle grace' USING ERRCODE = '22023';
      END IF;
      PERFORM set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);
      PERFORM %1$I.acquire_session_tenancy_fence((p_target->>'workspaceId')::uuid);
      access_id := opengeni_private.open_session_tenancy_fenced_access(
        %1$I.session_tenancy_fence_target_schema());
      SELECT candidate.* INTO lease FROM %1$I.sandbox_leases candidate
      WHERE candidate.id = (p_target->>'leaseId')::uuid
        AND candidate.account_id = (p_target->>'accountId')::uuid
        AND candidate.workspace_id = (p_target->>'workspaceId')::uuid
        AND candidate.sandbox_group_id = (p_target->>'sandboxGroupId')::uuid
        AND candidate.lease_epoch = (p_target->>'leaseEpoch')::bigint
      FOR UPDATE;
      IF FOUND THEN
        PERFORM holder.id FROM %1$I.sandbox_lease_holders holder
        WHERE holder.lease_id = lease.id AND holder.kind = 'interaction'
          AND holder.holder_id = 'browser-session:' || (p_target->>'browserSessionId')
        FOR UPDATE;
        -- Only the exact idle checkpoint's completed suspension releases.
        IF FOUND AND EXISTS (
          SELECT 1 FROM %1$I.interaction_operations operation
          JOIN %1$I.browser_sessions browser ON browser.id = operation.resource_id
            AND browser.workspace_id = operation.workspace_id
          WHERE operation.workspace_id = lease.workspace_id
            AND operation.resource_kind = 'browser_session'
            AND operation.resource_id = (p_target->>'browserSessionId')::uuid
            AND operation.operation_id = (p_target->>'operationId')::uuid
            AND operation.actor_subject_id = 'system:sandbox-idle'
            AND operation.kind = 'suspend' AND operation.state = 'completed'
            AND browser.lifecycle = 'suspended'
        ) THEN
          PERFORM opengeni_private.release_idle_interaction_holder(
            lease.id, 'browser-session:' || (p_target->>'browserSessionId'), p_idle_grace_ms);
          released := true;
        END IF;
      END IF;
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      RETURN released;
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      RAISE;
    END
    $body$;
  $create$, data_schema);
END
$install$;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_lease_idle_for_interaction_release(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.release_idle_interaction_holder(uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.list_idle_interaction_releases(integer, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.release_idle_interaction_session(jsonb, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.browser_idle_checkpoint(jsonb, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.release_idle_checkpoint_holder(jsonb, bigint) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.list_idle_interaction_releases(integer, bigint) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.release_idle_interaction_session(jsonb, bigint, bigint) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.browser_idle_checkpoint(jsonb, boolean, boolean) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.release_idle_checkpoint_holder(jsonb, bigint) TO opengeni_app;
  END IF;
END
$grant$;

RESET statement_timeout;
RESET lock_timeout;

-- deployment-mode: rolling
-- Saving a managed browser is a system lifecycle operation, not a borrowed
-- session creator grant. The exact lease epoch and controller bind its authority.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
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
      SELECT jsonb_build_object(
        'accountId', lease.account_id, 'workspaceId', lease.workspace_id,
        'sandboxGroupId', lease.sandbox_group_id, 'leaseId', lease.id,
        'leaseEpoch', lease.lease_epoch, 'instanceId', lease.instance_id,
        'browserSessionId', browser.id, 'controllerGeneration', browser.controller_generation
      )
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
      ORDER BY lease.provider_deadline_at, lease.id, browser.id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END
    $body$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.browser_deadline_checkpoint(
      p_target jsonb, p_prepare boolean, p_touch boolean
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE
      access_id uuid;
      lease %1$I.sandbox_leases%%ROWTYPE;
      browser %1$I.browser_sessions%%ROWTYPE;
      operation %1$I.interaction_operations%%ROWTYPE;
      scope_digest text;
      operation_id_value uuid;
      result jsonb;
    BEGIN
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
        AND candidate.rotation_reason = 'provider_deadline'
        AND candidate.rotation_requested_at IS NOT NULL AND candidate.provider_deadline_at > now()
      FOR UPDATE;
      IF NOT FOUND THEN
        PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
        RETURN NULL;
      END IF;
      PERFORM holder.id FROM %1$I.sandbox_lease_holders holder
      WHERE holder.lease_id = lease.id AND holder.account_id = lease.account_id
        AND holder.workspace_id = lease.workspace_id AND holder.kind = 'interaction'
        AND holder.holder_id = 'browser-session:' || (p_target->>'browserSessionId')
      FOR UPDATE;
      IF NOT FOUND THEN
        PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
        RETURN NULL;
      END IF;
      scope_digest := encode(sha256(convert_to(jsonb_build_array(
        'browser-provider-deadline.v1', lease.account_id, lease.workspace_id,
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
      -- A different live operation wins over this checkpoint's completed
      -- receipt, so cleanup cannot cross a concurrent human transition.
      ORDER BY (candidate.state IN ('prepared', 'dispatched')) DESC,
        candidate.operation_id LIMIT 1 FOR UPDATE;
      IF FOUND AND (operation.operation_id <> operation_id_value
        OR operation.account_id <> lease.account_id OR operation.kind <> 'suspend'
        OR operation.actor_subject_id <> 'system:sandbox-provider-deadline'
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
      IF operation.operation_id IS NULL THEN
        INSERT INTO %1$I.interaction_operations (
          operation_id, account_id, workspace_id, resource_kind, resource_id,
          kind, request_digest, state, actor_subject_id
        ) VALUES (operation_id_value, lease.account_id, lease.workspace_id, 'browser_session',
          browser.id, 'suspend', scope_digest, 'prepared', 'system:sandbox-provider-deadline')
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
END
$install$;

-- The existing hard-deadline fallback stays. During the lead window only
-- checkpoint-capable managed browser holders wait for their suspension receipt.
DO $protect_checkpoint_window$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.reap_stale_interaction_transitions(bigint)'::regprocedure);
  IF strpos(definition, '0560 browser checkpoint window') = 0 THEN
    anchor := E'          AND holder.kind = ''interaction''\n        ORDER BY holder.id';
    replacement := E'          AND holder.kind = ''interaction''\n'
      || E'          -- 0560 browser checkpoint window: retain the exact browser holder.\n'
      || format($condition$          AND NOT EXISTS (
            SELECT 1 FROM %1$I.browser_sessions browser
            JOIN %1$I.sandbox_leases lease ON lease.id = holder.lease_id
            WHERE holder.holder_id = 'browser-session:' || browser.id::text
              AND holder.account_id = browser.account_id AND holder.workspace_id = browser.workspace_id
              AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
              AND browser.placement_instance_id = lease.instance_id
              AND browser.placement_kind = 'sandbox_group'
              AND browser.capabilities->>'privateCheckpoint' = 'true'
              AND browser.lifecycle IN ('active', 'suspending', 'suspended')
              AND lease.provider_deadline_at > now()
          )
        ORDER BY holder.id$condition$, current_schema());
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION '0560 checkpoint preemption prerequisite drift' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition, anchor, replacement);
  END IF;
END
$protect_checkpoint_window$;

-- A completed capture remains restorable if local-profile cleanup fails.
-- Retain its holder while that exact source box can still be cleaned up; after
-- physical expiry, clear only the obsolete controller, never its saved state.
DO $complete_expired_checkpoint_cleanup$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.reap_stale_interaction_transitions(bigint)'::regprocedure);
  IF strpos(definition, '0560 expired checkpoint cleanup') = 0 THEN
    anchor := E'      -- Preserve the exact controller binding for cleanup/audit.';
    replacement := format($cleanup$      -- 0560 expired checkpoint cleanup: durable state outlives its source.
      UPDATE %1$I.browser_sessions browser
      SET controller_id = NULL, controller_generation = NULL,
          placement_instance_id = NULL, controller_heartbeat_at = NULL,
          updated_at = pg_catalog.now()
      WHERE browser.id = ANY(deadline_browser_ids)
        AND browser.lifecycle = 'suspended'
        AND browser.private_checkpoint_artifact_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM %1$I.sandbox_lease_holders holder
          JOIN %1$I.sandbox_leases lease ON lease.id = holder.lease_id
          WHERE holder.id = ANY(deadline_holder_ids)
            AND holder.holder_id = 'browser-session:' || browser.id::text
            AND holder.account_id = browser.account_id AND holder.workspace_id = browser.workspace_id
            AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
            AND browser.placement_instance_id = lease.instance_id
            AND lease.provider_deadline_at <= pg_catalog.now()
        );

      -- Preserve the exact controller binding for cleanup/audit.$cleanup$, current_schema());
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION '0560 checkpoint cleanup prerequisite drift' USING ERRCODE = '55000';
    END IF;
    definition := replace(definition, anchor, replacement);

    anchor := E'              AND browser.lifecycle IN (\n'
      || E'                ''starting'', ''active'', ''suspending'', ''restoring'', ''ending''\n'
      || E'              )';
    replacement := E'              AND (browser.lifecycle IN (\n'
      || E'                ''starting'', ''active'', ''suspending'', ''restoring'', ''ending''\n'
      || E'              ) OR (\n'
      || E'                browser.lifecycle = ''suspended''\n'
      || E'                AND browser.private_checkpoint_artifact_id IS NOT NULL\n'
      || E'                AND browser.controller_generation IS NOT NULL\n'
      || E'                AND browser.placement_instance_id = lease.instance_id\n'
      || E'                AND lease.backend = ''modal'' AND lease.rotation_reason = ''provider_deadline''\n'
      || E'                AND lease.provider_deadline_at > pg_catalog.now()\n'
      || E'              ))';
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 2 THEN
      RAISE EXCEPTION '0560 checkpoint orphan prerequisite drift' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition, anchor, replacement);
  END IF;
END
$complete_expired_checkpoint_cleanup$;

REVOKE ALL ON FUNCTION opengeni_private.list_browser_deadline_checkpoints(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.browser_deadline_checkpoint(jsonb, boolean, boolean) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.list_browser_deadline_checkpoints(integer) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.browser_deadline_checkpoint(jsonb, boolean, boolean) TO opengeni_app;
  END IF;
END
$grant$;

RESET statement_timeout;
RESET lock_timeout;

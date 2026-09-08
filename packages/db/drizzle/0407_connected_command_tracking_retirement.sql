-- deployment-mode: rolling
-- Loss here means tracking ended, not proof that an operating-system process died.
-- Preserve historical records without producing new model inputs or waking old sessions.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Give this global cleanup the same owner-only, transaction-capability and
-- workspace-fence policy used by the retained-process reaper. Runtime callers
-- cannot mint these capabilities or inherit the migration owner's identity.
DO $command_owner_policies$
DECLARE data_schema text := current_schema(); owner_name text := current_user;
        schema_oid oid := current_schema()::regnamespace;
BEGIN
  EXECUTE format('CREATE POLICY connected_command_inventory_read ON %1$I.session_background_commands
    FOR SELECT USING (%1$I.session_tenancy_fence_owner_policy_active(current_user,%2$L,%3$s::oid,workspace_id,true))',
    data_schema,owner_name,schema_oid);
  EXECUTE format('CREATE POLICY connected_command_fenced_write ON %1$I.session_background_commands
    FOR ALL USING (%1$I.session_tenancy_fence_owner_policy_active(current_user,%2$L,%3$s::oid,workspace_id,false))
    WITH CHECK (%1$I.session_tenancy_fence_owner_policy_active(current_user,%2$L,%3$s::oid,workspace_id,false))',
    data_schema,owner_name,schema_oid);
  EXECUTE format('DROP POLICY session_visibility_isolation ON %I.session_background_commands',data_schema);
  EXECUTE format('CREATE POLICY session_visibility_isolation ON %1$I.session_background_commands AS RESTRICTIVE
    FOR ALL USING (
      %1$I.session_tenancy_fence_owner_policy_active(current_user,%2$L,%3$s::oid,workspace_id,true)
      OR %1$I.session_tenancy_fence_owner_policy_active(current_user,%2$L,%3$s::oid,workspace_id,false)
      OR %1$I.session_reference_visible(account_id,workspace_id,session_id))
    WITH CHECK (
      %1$I.session_tenancy_fence_owner_policy_active(current_user,%2$L,%3$s::oid,workspace_id,false)
      OR %1$I.session_reference_visible(account_id,workspace_id,session_id))',data_schema,owner_name,schema_oid);
END
$command_owner_policies$;

DO $repair$
DECLARE inventory_id uuid; workspace_ids uuid[]; workspace_value uuid;
BEGIN
  inventory_id := opengeni_private.open_session_tenancy_fence_inventory(session_tenancy_fence_target_schema());
  SELECT array_agg(DISTINCT workspace_id ORDER BY workspace_id) INTO workspace_ids
  FROM session_background_commands WHERE provider = 'connected_machine' AND state IN ('running','stopping');
  FOREACH workspace_value IN ARRAY COALESCE(workspace_ids, ARRAY[]::uuid[]) LOOP
    PERFORM acquire_session_tenancy_fence(workspace_value);
  END LOOP;
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
ALTER TABLE session_background_commands NO FORCE ROW LEVEL SECURITY;
ALTER TABLE enrollments NO FORCE ROW LEVEL SECURITY;
WITH retired AS MATERIALIZED (
  SELECT command.id, CASE
          WHEN enrollment.status = 'revoked' THEN 'op_enrollment_revoked'
          WHEN enrollment.connection_instance_id IS NOT NULL
            AND enrollment.connection_instance_id <> command.connection_instance_id
            THEN 'op_connection_replaced'
          WHEN enrollment.connection_instance_id IS NULL
            AND enrollment.went_offline_reason IN (
              'GOING_OFFLINE_REASON_USER_STOP', 'GOING_OFFLINE_REASON_UPDATE',
              'GOING_OFFLINE_REASON_HOST_SHUTDOWN')
            THEN 'op_connection_stopped'
          ELSE NULL END AS reason
  FROM session_background_commands command
  JOIN enrollments enrollment ON enrollment.id = command.enrollment_id
    AND enrollment.account_id = command.account_id
    AND enrollment.workspace_id = command.control_workspace_id
  WHERE command.provider = 'connected_machine' AND command.state IN ('running', 'stopping')
    AND command.reconcile_proof_outcome IS NULL
    AND command.workspace_id = ANY(workspace_ids)
  FOR UPDATE OF command
)
UPDATE session_background_commands command SET
  state = 'lost', settlement_reason = retired.reason, settled_at = clock_timestamp(),
  reconcile_claim_id = NULL, reconcile_claimed_at = NULL,
  reconcile_proof_outcome = 'lost', reconcile_proof_reason = retired.reason,
  reconcile_proof_observed_at = clock_timestamp(),
  last_reconcile_outcome = 'historical_tracking_retired', updated_at = clock_timestamp()
FROM retired WHERE command.id = retired.id AND retired.reason IS NOT NULL
  AND command.state IN ('running', 'stopping') AND command.reconcile_proof_outcome IS NULL;

ALTER TABLE session_background_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE enrollments FORCE ROW LEVEL SECURITY;
END
$repair$;

-- Keep the three-argument function for rolling compatibility. New workers use
-- a fixed due-time frontier so one sweep cannot repeatedly reclaim its own retries.
DO $connected_claim_function$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_connected_machine_background_commands(
      p_claim_id uuid,
      p_limit integer,
      p_claim_ttl_ms bigint,
      p_due_before timestamptz
    )
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      session_id uuid,
      command_id uuid,
      claim_id uuid,
      command_state text,
      control_workspace_id uuid,
      enrollment_id uuid,
      connection_instance_id text,
      op_id text,
      reconcile_attempts integer,
      reconcile_proof_outcome text,
      reconcile_proof_exit_code integer,
      reconcile_proof_reason text,
      reconcile_proof_observed_at timestamptz
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      inventory_id uuid;
      access_id uuid;
      workspace_ids uuid[];
      workspace_value uuid;
      owns_compute_capability boolean := false;
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'connected-command reconciliation limit must be between 1 and 100'
          USING ERRCODE = '22023';
      END IF;
      IF p_claim_ttl_ms < 0 OR p_claim_ttl_ms > 3600000 THEN
        RAISE EXCEPTION 'connected-command reconciliation claim TTL is invalid'
          USING ERRCODE = '22023';
      END IF;

      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      SELECT array_agg(DISTINCT command.workspace_id ORDER BY command.workspace_id) INTO workspace_ids
      FROM %1$I.session_background_commands command
      WHERE command.provider = 'connected_machine' AND command.state IN ('running','stopping')
        AND command.reconcile_after <= LEAST(p_due_before, pg_catalog.now());
      FOREACH workspace_value IN ARRAY COALESCE(workspace_ids, ARRAY[]::uuid[]) LOOP
        PERFORM %1$I.acquire_session_tenancy_fence(workspace_value);
      END LOOP;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      access_id := opengeni_private.open_session_tenancy_fenced_access(%1$I.session_tenancy_fence_target_schema());
      INSERT INTO opengeni_private.scoped_compute_capabilities(backend_pid, transaction_id, capability_kind)
        VALUES(pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
        ON CONFLICT DO NOTHING;
      owns_compute_capability := FOUND;
      RETURN QUERY
      WITH candidates AS MATERIALIZED (
        SELECT command.id, command.reconcile_after, command.started_at,
          CASE
          WHEN enrollment.status = 'revoked' THEN 'op_enrollment_revoked'
          WHEN enrollment.connection_instance_id IS NOT NULL
            AND enrollment.connection_instance_id <> command.connection_instance_id
            THEN 'op_connection_replaced'
          WHEN enrollment.connection_instance_id IS NULL
            AND enrollment.went_offline_reason IN (
              'GOING_OFFLINE_REASON_USER_STOP', 'GOING_OFFLINE_REASON_UPDATE',
              'GOING_OFFLINE_REASON_HOST_SHUTDOWN')
            THEN 'op_connection_stopped'
          ELSE NULL END AS retirement_reason
        FROM %1$I.session_background_commands command
        JOIN %1$I.enrollments enrollment ON enrollment.id = command.enrollment_id
          AND enrollment.account_id = command.account_id
          AND enrollment.workspace_id = command.control_workspace_id
        WHERE command.provider = 'connected_machine'
          AND command.workspace_id = ANY(workspace_ids)
          AND command.state IN ('running', 'stopping')
          AND command.reconcile_after <= LEAST(p_due_before, pg_catalog.now())
          AND (
            command.reconcile_claim_id IS NULL
            OR command.reconcile_claimed_at <= pg_catalog.now()
              - pg_catalog.make_interval(secs => p_claim_ttl_ms / 1000.0)
          )
        ORDER BY command.reconcile_after, command.started_at, command.id
        FOR UPDATE OF command SKIP LOCKED
        LIMIT p_limit
      ), claimed AS (
        UPDATE %1$I.session_background_commands command SET
          reconcile_after = pg_catalog.now()
            + pg_catalog.make_interval(secs => p_claim_ttl_ms / 1000.0),
          reconcile_claim_id = p_claim_id,
          reconcile_claimed_at = pg_catalog.now(),
          reconcile_attempts = command.reconcile_attempts + 1,
          last_reconcile_outcome = 'claimed',
          reconcile_proof_outcome = COALESCE(command.reconcile_proof_outcome,
            CASE WHEN candidates.retirement_reason IS NOT NULL THEN 'lost' END),
          reconcile_proof_reason = COALESCE(command.reconcile_proof_reason, candidates.retirement_reason),
          reconcile_proof_observed_at = COALESCE(command.reconcile_proof_observed_at,
            CASE WHEN candidates.retirement_reason IS NOT NULL THEN pg_catalog.clock_timestamp() END),
          updated_at = pg_catalog.clock_timestamp()
        FROM candidates
        WHERE command.id = candidates.id
          AND command.provider = 'connected_machine'
          AND command.state IN ('running', 'stopping')
        RETURNING command.*, candidates.reconcile_after AS due_at,
          candidates.started_at AS candidate_started_at
      )
      SELECT claimed.account_id,
        claimed.workspace_id,
        claimed.session_id,
        claimed.id,
        claimed.reconcile_claim_id,
        claimed.state,
        claimed.control_workspace_id,
        claimed.enrollment_id,
        claimed.connection_instance_id,
        claimed.op_id,
        claimed.reconcile_attempts,
        claimed.reconcile_proof_outcome,
        claimed.reconcile_proof_exit_code,
        claimed.reconcile_proof_reason,
        claimed.reconcile_proof_observed_at
      FROM claimed
      ORDER BY claimed.due_at, claimed.candidate_started_at, claimed.id;
      IF owns_compute_capability THEN
        DELETE FROM opengeni_private.scoped_compute_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id() AND capability_kind = 'read';
      END IF;
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      IF owns_compute_capability THEN
        DELETE FROM opengeni_private.scoped_compute_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id() AND capability_kind = 'read';
      END IF;
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END;
    $function$;
  $create$, data_schema);
END
$connected_claim_function$;

REVOKE ALL ON FUNCTION opengeni_private.claim_connected_machine_background_commands(
  uuid, integer, bigint, timestamptz
) FROM PUBLIC;

DO $connected_claim_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_connected_machine_background_commands(
      uuid, integer, bigint, timestamptz
    ) TO opengeni_app;
  END IF;
END
$connected_claim_grant$;
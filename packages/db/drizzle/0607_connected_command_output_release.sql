-- deployment-mode: rolling
-- Durable output-release custody is independent of terminal model observation.
-- Existing terminal rows require a fresh full replay; no receipt is backfilled.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE session_background_commands
  ADD COLUMN output_exit_seq text,
  ADD COLUMN output_attach_generation text,
  ADD COLUMN output_consumed_at timestamptz,
  ADD COLUMN output_release_observed_at timestamptz,
  ADD COLUMN output_unavailable_at timestamptz;
ALTER TABLE session_background_commands ADD CONSTRAINT session_background_commands_output_custody_check CHECK (
  (
    output_exit_seq IS NULL AND output_attach_generation IS NULL
    AND output_consumed_at IS NULL AND output_release_observed_at IS NULL
    AND (output_unavailable_at IS NULL OR (provider = 'connected_machine' AND state = 'exited'))
  ) OR (
    provider = 'connected_machine' AND state = 'exited'
    AND output_exit_seq IS NOT NULL AND output_attach_generation IS NOT NULL
    AND output_consumed_at IS NOT NULL AND output_unavailable_at IS NULL
    AND output_exit_seq ~ '^[1-9][0-9]{0,19}$'
    AND output_attach_generation ~ '^[1-9][0-9]{0,19}$'
    AND output_exit_seq::numeric <= 18446744073709551615
    AND output_attach_generation::numeric <= 18446744073709551615
  )
);
CREATE INDEX session_background_commands_output_release_idx
  ON session_background_commands (reconcile_after, started_at, id)
  WHERE provider = 'connected_machine' AND state = 'exited'
    AND output_release_observed_at IS NULL AND output_unavailable_at IS NULL;

DO $connected_claim_function$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.claim_connected_command_output_releases(
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
      reconcile_proof_observed_at timestamptz,
      output_exit_seq text,
      output_attach_generation text
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
    BEGIN
      IF p_claim_id IS NULL OR p_due_before IS NULL THEN
        RAISE EXCEPTION 'connected-command output claim identity and due frontier are required'
          USING ERRCODE = '22023';
      END IF;
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'connected-command reconciliation limit must be between 1 and 100'
          USING ERRCODE = '22023';
      END IF;
      IF p_claim_ttl_ms IS NULL OR p_claim_ttl_ms < 0 OR p_claim_ttl_ms > 3600000 THEN
        RAISE EXCEPTION 'connected-command reconciliation claim TTL is invalid'
          USING ERRCODE = '22023';
      END IF;

      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      SELECT array_agg(DISTINCT command.workspace_id ORDER BY command.workspace_id) INTO workspace_ids
      FROM %1$I.session_background_commands command
      WHERE command.provider = 'connected_machine' AND command.state = 'exited' AND command.output_release_observed_at IS NULL AND command.output_unavailable_at IS NULL
        AND command.reconcile_after <= LEAST(p_due_before, pg_catalog.now());
      FOREACH workspace_value IN ARRAY COALESCE(workspace_ids, ARRAY[]::uuid[]) LOOP
        PERFORM %1$I.acquire_session_tenancy_fence(workspace_value);
      END LOOP;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      access_id := opengeni_private.open_session_tenancy_fenced_access(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY
      WITH candidates AS MATERIALIZED (
        SELECT command.id, command.reconcile_after, command.started_at
        FROM %1$I.session_background_commands command
        WHERE command.provider = 'connected_machine'
          AND command.workspace_id = ANY(workspace_ids)
          AND command.state = 'exited' AND command.output_release_observed_at IS NULL AND command.output_unavailable_at IS NULL
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
          updated_at = pg_catalog.clock_timestamp()
        FROM candidates
        WHERE command.id = candidates.id
          AND command.provider = 'connected_machine'
          AND command.state = 'exited' AND command.output_release_observed_at IS NULL AND command.output_unavailable_at IS NULL
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
        claimed.reconcile_proof_observed_at,
        claimed.output_exit_seq,
        claimed.output_attach_generation
      FROM claimed
      ORDER BY claimed.due_at, claimed.candidate_started_at, claimed.id;
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END;
    $function$;
  $create$, data_schema);
END
$connected_claim_function$;

REVOKE ALL ON FUNCTION opengeni_private.claim_connected_command_output_releases(
  uuid, integer, bigint, timestamptz
) FROM PUBLIC;

DO $connected_claim_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_connected_command_output_releases(
      uuid, integer, bigint, timestamptz
    ) TO opengeni_app;
  END IF;
END
$connected_claim_grant$;

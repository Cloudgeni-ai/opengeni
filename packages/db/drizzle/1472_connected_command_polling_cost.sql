-- deployment-mode: rolling
-- Connected-command output claims and op lookups stop rereading work they
-- cannot do.
--
-- maintenance_claim_output_release_inner read every due output row twice
-- (once to fence its workspaces, once for its candidate window) and called
-- connected_output_runner_eligible_v1 for each row both times. A row whose
-- runner was offline (not retired) stayed due, because only a claim moves its
-- due time, so every claim of a sweep reread all of them while taking at most
-- 20 others. With a backlog that is quadratic.
--
-- Now one ordered walk of the due window (the captured-release index order)
-- decides each row once. A row whose runner can be asked joins the claim, up
-- to the claim limit. A row whose runner cannot be asked yet is made due
-- again later instead of being reread: its due time moves forward by its age
-- since its command exited, at least 30 seconds and at most 5 minutes. That
-- is the most a row waits after its runner returns, beyond the sweep that
-- finds it (5 minutes is also the longest ordinary output retry). Its claim,
-- attempts, outcome and custody are unchanged, so nothing is released,
-- dropped or expired by this, and the due probe still ignores such rows. At
-- most 200 such rows move per call (each move is a fenced row write), so one
-- call stays short; the rest move in later calls. Past that cap the walk
-- still claims every row it can (it only stops deferring), so output behind
-- a long offline backlog is released in the same call.
--
-- classify_connected_command_ops first asks the private command projection
-- (1471) whether the runner process has a row for any of
-- the operations, or a row older than 1471. Without one it returns nothing,
-- which is what the full lookup returns, and never opens the fence
-- inventory, so a foreground completion notice writes nothing.
--
-- Rolling: both routines keep their signatures, owners, grants and results.
-- The previous release calls them unchanged.
SET LOCAL lock_timeout = '5s';

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.classify_connected_command_ops(p_control_workspace_id uuid, p_enrollment_id uuid, p_connection_instance_id text, p_op_ids text[]) RETURNS TABLE(op_id text, account_id uuid, workspace_id uuid, session_id uuid, command_id uuid, state text, output_exit_seq text, output_consumed boolean, output_released boolean, output_unavailable boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      -- Read-only and exact: every command row is projected in its own
      -- transaction, and a NULL op id (a row from before 1471) may match.
      IF NOT EXISTS (
        SELECT 1 FROM opengeni_private.maintenance_probe_session_background_commands probe
        WHERE probe.provider = 'connected_machine'
          AND probe.control_workspace_id = p_control_workspace_id
          AND probe.enrollment_id = p_enrollment_id
          AND probe.connection_instance_id = p_connection_instance_id
          AND probe.op_id = ANY(p_op_ids)
      ) AND NOT EXISTS (
        SELECT 1 FROM opengeni_private.maintenance_probe_session_background_commands probe
        WHERE probe.provider = 'connected_machine'
          AND probe.control_workspace_id = p_control_workspace_id
          AND probe.enrollment_id = p_enrollment_id
          AND probe.connection_instance_id = p_connection_instance_id
          AND probe.op_id IS NULL
      ) THEN
        RETURN;
      END IF;
      BEGIN
        inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
        RETURN QUERY SELECT command.op_id, command.account_id, command.workspace_id,
            command.session_id, command.id, command.state::text, command.output_exit_seq,
            command.output_consumed_at IS NOT NULL,
            command.output_release_observed_at IS NOT NULL,
            command.output_unavailable_at IS NOT NULL
          FROM %1$I.session_background_commands command
          WHERE command.provider = 'connected_machine'
            AND command.control_workspace_id = p_control_workspace_id
            AND command.enrollment_id = p_enrollment_id
            AND command.connection_instance_id = p_connection_instance_id
            AND command.op_id = ANY(p_op_ids);
        PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      EXCEPTION WHEN OTHERS THEN
        PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
        RAISE;
      END;
    END $body$;
  $create$, data_schema);

  EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.maintenance_claim_output_release_inner(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint, p_due_before timestamp with time zone) RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid, command_id uuid, claim_id uuid, command_state text, control_workspace_id uuid, enrollment_id uuid, connection_instance_id text, op_id text, reconcile_attempts integer, reconcile_proof_outcome text, reconcile_proof_exit_code integer, reconcile_proof_reason text, reconcile_proof_observed_at timestamp with time zone, output_exit_seq text, output_attach_generation text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $body$
    DECLARE
      inventory_id uuid;
      access_id uuid;
      due_frontier timestamptz;
      claim_ttl interval;
      candidate record;
      claim_ids uuid[] := ARRAY[]::uuid[];
      defer_ids uuid[] := ARRAY[]::uuid[];
      workspace_ids uuid[] := ARRAY[]::uuid[];
      workspace_value uuid;
      defer_limit CONSTANT integer := 200;
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
      due_frontier := LEAST(p_due_before, pg_catalog.now());
      claim_ttl := pg_catalog.make_interval(secs => p_claim_ttl_ms / 1000.0);

      -- One walk of the due window in claim order decides each row once:
      -- claim it when its runner can be asked, else move its due time.
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      FOR candidate IN
        SELECT command.id, command.workspace_id,
          opengeni_private.connected_output_runner_eligible_v1(
            command.control_workspace_id, command.enrollment_id,
            command.connection_instance_id) AS eligible
        FROM %1$I.session_background_commands command
        WHERE command.provider = 'connected_machine' AND command.state = 'exited'
          AND command.output_release_observed_at IS NULL AND command.output_unavailable_at IS NULL
          AND command.reconcile_after <= due_frontier
          AND (command.reconcile_claim_id IS NULL
            OR command.reconcile_claimed_at <= pg_catalog.now() - claim_ttl)
        ORDER BY command.output_consumed_at IS NULL,
          command.reconcile_after, command.started_at, command.id
      LOOP
        IF candidate.eligible THEN
          claim_ids := pg_catalog.array_append(claim_ids, candidate.id);
        ELSIF pg_catalog.cardinality(defer_ids) < defer_limit THEN
          defer_ids := pg_catalog.array_append(defer_ids, candidate.id);
        ELSE
          -- Past the deferral cap the walk only looks for rows it can claim,
          -- so claimable output behind a long offline backlog is not held
          -- back; a later call moves the rest.
          CONTINUE;
        END IF;
        IF NOT candidate.workspace_id = ANY(workspace_ids) THEN
          workspace_ids := pg_catalog.array_append(workspace_ids, candidate.workspace_id);
        END IF;
        EXIT WHEN pg_catalog.cardinality(claim_ids) >= p_limit;
      END LOOP;
      FOR workspace_value IN
        SELECT fenced.id FROM pg_catalog.unnest(workspace_ids) AS fenced(id) ORDER BY fenced.id
      LOOP
        PERFORM acquire_session_tenancy_fence(workspace_value);
      END LOOP;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      access_id := opengeni_private.open_session_tenancy_fenced_access(%1$I.session_tenancy_fence_target_schema());

      -- Still due and still unanswerable: due again after its age since
      -- exit, between 30 seconds and 5 minutes. Nothing else changes.
      WITH deferred AS MATERIALIZED (
        SELECT command.id
        FROM %1$I.session_background_commands command
        WHERE command.id = ANY(defer_ids)
          AND command.provider = 'connected_machine'
          AND command.workspace_id = ANY(workspace_ids)
          AND command.state = 'exited'
          AND command.output_release_observed_at IS NULL AND command.output_unavailable_at IS NULL
          AND command.reconcile_after <= due_frontier
          AND (command.reconcile_claim_id IS NULL
            OR command.reconcile_claimed_at <= pg_catalog.now() - claim_ttl)
          AND NOT opengeni_private.connected_output_runner_eligible_v1(
            command.control_workspace_id, command.enrollment_id, command.connection_instance_id)
        FOR UPDATE OF command SKIP LOCKED
      )
      UPDATE %1$I.session_background_commands command SET
        reconcile_after = pg_catalog.now() + LEAST(interval '5 minutes', GREATEST(interval '30 seconds',
          pg_catalog.now() - COALESCE(command.settled_at, command.started_at)))
      FROM deferred WHERE command.id = deferred.id;

      RETURN QUERY
      WITH candidates AS MATERIALIZED (
        SELECT command.id, command.reconcile_after, command.started_at,
          command.output_consumed_at IS NULL AS output_uncaptured
        FROM %1$I.session_background_commands command
        WHERE command.id = ANY(claim_ids)
          AND command.provider = 'connected_machine'
          AND command.workspace_id = ANY(workspace_ids)
          AND command.state = 'exited'
          AND command.output_release_observed_at IS NULL AND command.output_unavailable_at IS NULL
          AND command.reconcile_after <= due_frontier
          AND opengeni_private.connected_output_runner_eligible_v1(
            command.control_workspace_id, command.enrollment_id, command.connection_instance_id)
          AND (command.reconcile_claim_id IS NULL
            OR command.reconcile_claimed_at <= pg_catalog.now() - claim_ttl)
        ORDER BY command.output_consumed_at IS NULL,
          command.reconcile_after, command.started_at, command.id
        FOR UPDATE OF command SKIP LOCKED
        LIMIT p_limit
      ), claimed AS (
        UPDATE %1$I.session_background_commands command SET
          reconcile_after = pg_catalog.now() + claim_ttl,
          reconcile_claim_id = p_claim_id, reconcile_claimed_at = pg_catalog.now(),
          reconcile_attempts = command.reconcile_attempts + 1,
          last_reconcile_outcome = 'claimed', updated_at = pg_catalog.clock_timestamp()
        FROM candidates WHERE command.id = candidates.id
          AND command.provider = 'connected_machine' AND command.state = 'exited'
          AND command.output_release_observed_at IS NULL AND command.output_unavailable_at IS NULL
        RETURNING command.*, candidates.reconcile_after AS due_at,
          candidates.started_at AS candidate_started_at, candidates.output_uncaptured
      )
      SELECT claimed.account_id, claimed.workspace_id, claimed.session_id, claimed.id,
        claimed.reconcile_claim_id, claimed.state, claimed.control_workspace_id,
        claimed.enrollment_id, claimed.connection_instance_id, claimed.op_id,
        claimed.reconcile_attempts, claimed.reconcile_proof_outcome,
        claimed.reconcile_proof_exit_code, claimed.reconcile_proof_reason,
        claimed.reconcile_proof_observed_at, claimed.output_exit_seq,
        claimed.output_attach_generation
      FROM claimed ORDER BY claimed.output_uncaptured, claimed.due_at,
        claimed.candidate_started_at, claimed.id;
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fenced_access(access_id);
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END;
    $body$;
  $create$, data_schema);
END $install$;

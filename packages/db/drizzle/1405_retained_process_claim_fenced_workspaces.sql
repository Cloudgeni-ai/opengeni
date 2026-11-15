-- deployment-mode: rolling
-- The retained-process claim updates only rows whose workspace fence it holds.
--
-- claim_terminal_retained_processes took the session-tenancy fence of every
-- workspace with a due active row (acquire_due_retained_process_session_
-- tenancy_fences) and then selected and updated its candidate window in a
-- later statement. Under READ COMMITTED that statement sees rows committed
-- after the fence loop chose its workspaces: a row of another workspace that
-- became due in between was selected without its fence. When the routine's
-- owner is subject to row security, the fenced-owner policy hides such rows.
-- When the owner bypasses it (for example a superuser migration role), the
-- UPDATE reached the row, the session-tenancy fence trigger rejected it with
-- SQLSTATE 55000 ("session tenancy mutation requires the workspace fence"),
-- and the whole reconcile pass failed.
--
-- Same signature, owner and grants. The claim now takes the fences itself,
-- remembers exactly the workspaces it fenced, and its candidate window keeps
-- to those workspaces. A row that becomes due in another workspace meanwhile
-- is left for the next pass. Fences are taken only for rows this reconciler
-- version may claim. Everything else is unchanged.
--
-- Rolling: the previous release calls the same two signatures, which keep
-- their results. acquire_due_retained_process_session_tenancy_fences() is no
-- longer called; it stays until a later release removes it.
SET LOCAL lock_timeout = '5s';

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.claim_terminal_retained_processes(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint, p_reconciler_version integer) RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid, process_id uuid, claim_id uuid, owner_state text, owner_attempt_outcome text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $body$
    DECLARE
      fenced_access_capability_id uuid;
      inventory_capability_id uuid;
      fenced_workspace_ids uuid[] := ARRAY[]::uuid[];
      workspace_id_value uuid;
    BEGIN
      IF p_reconciler_version IS NULL OR p_reconciler_version < 1 THEN
        RAISE EXCEPTION 'retained-process reconciler version is invalid'
          USING ERRCODE = '22023';
      END IF;
      IF p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'retained-process reconciliation limit must be between 1 and 100'
          USING ERRCODE = '22023';
      END IF;
      IF p_claim_ttl_ms < 0 OR p_claim_ttl_ms > 3600000 THEN
        RAISE EXCEPTION 'retained-process reconciliation claim TTL is invalid'
          USING ERRCODE = '22023';
      END IF;

      PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);

      -- Fence every workspace with a claimable due row and remember exactly
      -- which ones; the candidate window below keeps to them.
      inventory_capability_id :=
        opengeni_private.open_session_tenancy_fence_inventory(
          session_tenancy_fence_target_schema()
        );
      FOR workspace_id_value IN
        SELECT DISTINCT process.workspace_id
        FROM %1$I.sandbox_retained_processes process
        WHERE process.workspace_id IS NOT NULL
          AND process.state = 'active'
          AND process.reconcile_after <= pg_catalog.now()
          AND process.reconciler_version <= p_reconciler_version
        ORDER BY process.workspace_id
      LOOP
        PERFORM acquire_session_tenancy_fence(workspace_id_value);
        fenced_workspace_ids :=
          pg_catalog.array_append(fenced_workspace_ids, workspace_id_value);
      END LOOP;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(
        inventory_capability_id
      );

      fenced_access_capability_id :=
        opengeni_private.open_session_tenancy_fenced_access(
          session_tenancy_fence_target_schema()
        );

      RETURN QUERY
      WITH candidate_window AS MATERIALIZED (
        SELECT process.id,
          process.workspace_id,
          process.parent_admission_id,
          process.owner_actor_kind,
          process.owner_turn_id,
          process.owner_attempt_id,
          process.reconcile_after AS due_at,
          process.started_at
        FROM %1$I.sandbox_retained_processes process
        WHERE process.state = 'active'
          AND process.reconcile_after <= pg_catalog.now()
          AND process.reconciler_version <= p_reconciler_version
          AND process.workspace_id = ANY (fenced_workspace_ids)
        ORDER BY process.reconcile_after, process.started_at, process.id
        FOR UPDATE OF process SKIP LOCKED
        LIMIT p_limit
      ), classified AS MATERIALIZED (
        SELECT candidate.id,
          candidate.due_at,
          candidate.started_at,
          command.state AS command_state,
          command.id IS NOT NULL OR CASE
            WHEN candidate.owner_actor_kind = 'direct' THEN direct_owner.live IS NULL
            ELSE attempt.state = 'closed'
          END AS eligible,
          CASE
            WHEN command.state = 'stopping' THEN 'background_stopping'
            WHEN command.state = 'running' THEN 'background_running'
            WHEN candidate.owner_actor_kind = 'direct' THEN 'direct'
            ELSE COALESCE(turn_row.status, 'missing')
          END AS owner_state,
          attempt.outcome AS owner_attempt_outcome
        FROM candidate_window candidate
        LEFT JOIN %1$I.session_background_commands command
          ON command.retained_process_id = candidate.id
         AND command.state IN ('running', 'stopping')
        LEFT JOIN LATERAL (
          SELECT true AS live
          FROM %1$I.sandbox_workspace_mutation_admissions admission
          JOIN %1$I.sandbox_lease_holders holder
            ON holder.lease_id = admission.lease_id
           AND holder.account_id = admission.account_id
           AND holder.workspace_id = admission.workspace_id
           AND holder.kind = 'direct'
           AND holder.holder_id = admission.holder_id
           AND holder.subject_id = admission.session_id
          WHERE candidate.owner_actor_kind = 'direct'
            AND admission.id = candidate.parent_admission_id
            AND admission.actor_kind = 'direct'
          LIMIT 1
        ) direct_owner ON true
        LEFT JOIN LATERAL (
          SELECT source_turn.status
          FROM %1$I.session_turns source_turn
          WHERE source_turn.workspace_id = candidate.workspace_id
            AND source_turn.id = candidate.owner_turn_id
          LIMIT 1
        ) turn_row ON true
        LEFT JOIN LATERAL (
          SELECT source_attempt.state, source_attempt.outcome
          FROM %1$I.session_turn_attempts source_attempt
          WHERE source_attempt.workspace_id = candidate.workspace_id
            AND source_attempt.id = candidate.owner_attempt_id
          LIMIT 1
        ) attempt ON true
      ), inspected AS (
        UPDATE %1$I.sandbox_retained_processes process SET
          reconcile_after = CASE
            WHEN classified.eligible THEN pg_catalog.now()
              + pg_catalog.make_interval(secs => p_claim_ttl_ms / 1000.0)
            ELSE pg_catalog.now() + interval '30 seconds'
          END,
          reconcile_claim_id = CASE WHEN classified.eligible THEN p_claim_id ELSE NULL END,
          reconcile_claimed_at = CASE
            WHEN classified.eligible THEN pg_catalog.now() ELSE NULL
          END,
          reconcile_attempts = process.reconcile_attempts
            + CASE WHEN classified.eligible THEN 1 ELSE 0 END,
          last_reconcile_outcome = CASE
            WHEN classified.eligible THEN 'claimed' ELSE 'owner_active'
          END
        FROM classified
        WHERE process.id = classified.id
          AND process.state = 'active'
        RETURNING process.account_id,
          process.workspace_id,
          process.session_id,
          process.id,
          process.reconcile_claim_id,
          classified.due_at,
          classified.started_at,
          classified.eligible,
          classified.owner_state,
          classified.owner_attempt_outcome
      )
      SELECT inspected.account_id,
        inspected.workspace_id,
        inspected.session_id,
        inspected.id,
        inspected.reconcile_claim_id,
        inspected.owner_state,
        inspected.owner_attempt_outcome
      FROM inspected
      WHERE inspected.eligible
      ORDER BY inspected.due_at, inspected.started_at, inspected.id;

      SET CONSTRAINTS %1$I.sandbox_retained_processes_identity_v2 IMMEDIATE;
      SET CONSTRAINTS %1$I.sandbox_retained_processes_identity_v2 DEFERRED;
      PERFORM opengeni_private.close_session_tenancy_fenced_access(
        fenced_access_capability_id
      );
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(
        inventory_capability_id
      );
      PERFORM opengeni_private.close_session_tenancy_fenced_access(
        fenced_access_capability_id
      );
      RAISE;
    END;
    $body$
  $create$, data_schema);
END
$install$;

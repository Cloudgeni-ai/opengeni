-- deployment-mode: rolling
-- A direct Channel-A request may retain a provider process while it is still
-- polling that process itself. Reconciliation may start only after the exact
-- direct holder is released (normal return) or TTL-reaped (owner death).

DO $privileged_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_terminal_retained_processes(
      p_claim_id uuid,
      p_limit integer,
      p_claim_ttl_ms bigint
    )
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      session_id uuid,
      process_id uuid,
      claim_id uuid,
      owner_state text,
      owner_attempt_outcome text
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'retained-process reconciliation limit must be between 1 and 100'
          USING ERRCODE = '22023';
      END IF;
      IF p_claim_ttl_ms < 0 OR p_claim_ttl_ms > 3600000 THEN
        RAISE EXCEPTION 'retained-process reconciliation claim TTL is invalid'
          USING ERRCODE = '22023';
      END IF;

      PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);

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
        ORDER BY process.reconcile_after, process.started_at, process.id
        FOR UPDATE OF process SKIP LOCKED
        LIMIT p_limit
      ), classified AS MATERIALIZED (
        SELECT candidate.id,
          candidate.due_at,
          candidate.started_at,
          CASE
            WHEN candidate.owner_actor_kind = 'direct' THEN direct_owner.live IS NULL
            ELSE attempt.state = 'closed'
          END AS eligible,
          CASE
            WHEN candidate.owner_actor_kind = 'direct' THEN 'direct'
            ELSE COALESCE(turn_row.status, 'missing')
          END AS owner_state,
          attempt.outcome AS owner_attempt_outcome
        FROM candidate_window candidate
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
    END;
    $function$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.count_active_retained_processes_by_owner_state()
    RETURNS TABLE (owner_state text, active_count bigint, terminal_owner_count bigint)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      SELECT inventory.owner_state,
        pg_catalog.count(*)::bigint AS active_count,
        pg_catalog.count(*) FILTER (WHERE inventory.terminal_owner)::bigint
          AS terminal_owner_count
      FROM (
        SELECT 'direct'::text AS owner_state,
          NOT EXISTS (
            SELECT 1
            FROM %1$I.sandbox_workspace_mutation_admissions admission
            JOIN %1$I.sandbox_lease_holders holder
              ON holder.lease_id = admission.lease_id
             AND holder.account_id = admission.account_id
             AND holder.workspace_id = admission.workspace_id
             AND holder.kind = 'direct'
             AND holder.holder_id = admission.holder_id
             AND holder.subject_id = admission.session_id
            WHERE admission.id = process.parent_admission_id
              AND admission.actor_kind = 'direct'
          ) AS terminal_owner
        FROM %1$I.sandbox_retained_processes process
        WHERE process.state = 'active'
          AND process.owner_actor_kind = 'direct'
        UNION ALL
        SELECT COALESCE(turn_row.status, 'missing') AS owner_state,
          attempt.state = 'closed' AS terminal_owner
        FROM %1$I.sandbox_retained_processes process
        LEFT JOIN LATERAL (
          SELECT source_turn.status
          FROM %1$I.session_turns source_turn
          WHERE source_turn.workspace_id = process.workspace_id
            AND source_turn.id = process.owner_turn_id
          LIMIT 1
        ) turn_row ON true
        LEFT JOIN LATERAL (
          SELECT source_attempt.state
          FROM %1$I.session_turn_attempts source_attempt
          WHERE source_attempt.workspace_id = process.workspace_id
            AND source_attempt.id = process.owner_attempt_id
          LIMIT 1
        ) attempt ON true
        WHERE process.state = 'active'
          AND process.owner_actor_kind = 'turn'
      ) inventory
      GROUP BY inventory.owner_state;
    $function$;
  $create$, data_schema);
END $privileged_functions$;

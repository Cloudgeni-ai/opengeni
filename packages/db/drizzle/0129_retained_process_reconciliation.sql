-- deployment-mode: rolling
-- Terminal owners do not prove provider quiescence. Persist only a
-- bounded/fair reconciliation claim here; the worker must still obtain an exact
-- provider exit/loss proof before invoking canonical retained-process settlement.

ALTER TABLE "sandbox_retained_processes"
  ADD COLUMN IF NOT EXISTS "reconcile_after" timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "reconcile_claim_id" uuid,
  ADD COLUMN IF NOT EXISTS "reconcile_claimed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "reconcile_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_reconcile_outcome" text,
  ADD COLUMN IF NOT EXISTS "reconcile_proof_outcome" text,
  ADD COLUMN IF NOT EXISTS "reconcile_proof_exit_code" integer,
  ADD COLUMN IF NOT EXISTS "reconcile_proof_reason" text,
  ADD COLUMN IF NOT EXISTS "reconcile_proof_observed_at" timestamptz;

ALTER TABLE "sandbox_retained_processes"
  ADD CONSTRAINT "sandbox_retained_processes_reconcile_claim_check"
  CHECK (
    ("reconcile_claim_id" IS NULL AND "reconcile_claimed_at" IS NULL)
    OR ("reconcile_claim_id" IS NOT NULL AND "reconcile_claimed_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "sandbox_retained_processes_reconcile_attempts_check"
  CHECK ("reconcile_attempts" >= 0),
  ADD CONSTRAINT "sandbox_retained_processes_reconcile_outcome_check"
  CHECK (
    "last_reconcile_outcome" IS NULL
    OR octet_length("last_reconcile_outcome") BETWEEN 1 AND 64
  ),
  ADD CONSTRAINT "sandbox_retained_processes_reconcile_proof_check"
  CHECK (
    (
      "reconcile_proof_outcome" IS NULL
      AND "reconcile_proof_exit_code" IS NULL
      AND "reconcile_proof_reason" IS NULL
      AND "reconcile_proof_observed_at" IS NULL
    ) OR (
      "reconcile_proof_outcome" = 'exited'
      AND "reconcile_proof_exit_code" IS NOT NULL
      AND "reconcile_proof_reason" = 'provider_exit_banner'
      AND "reconcile_proof_observed_at" IS NOT NULL
    ) OR (
      "reconcile_proof_outcome" = 'lost'
      AND "reconcile_proof_exit_code" IS NULL
      AND "reconcile_proof_reason" IN (
        'provider_session_lost_banner', 'provider_instance_not_found'
      )
      AND "reconcile_proof_observed_at" IS NOT NULL
    )
  );

CREATE INDEX "sandbox_retained_processes_reconcile_due_idx"
  ON "sandbox_retained_processes" ("reconcile_after", "started_at", "id")
  WHERE "state" = 'active';

CREATE INDEX "sandbox_retained_processes_active_inventory_idx"
  ON "sandbox_retained_processes" (
    "owner_actor_kind", "workspace_id", "owner_turn_id", "owner_attempt_id"
  )
  WHERE "state" = 'active';

CREATE INDEX "sandbox_leases_expired_draining_inventory_idx"
  ON "sandbox_leases" ("expires_at", "backend")
  WHERE "liveness" = 'draining';

-- The data schema is selected by the migration caller and may be public or a
-- dedicated embed schema. Bind it into every privileged statement at creation
-- time, then expose only pg_catalog at execution time. pg_temp and the caller's
-- search_path can therefore resolve neither relations nor helper functions.
DO $privileged_functions$
DECLARE data_schema text := current_schema();
BEGIN
  -- The claim update fires this pre-existing deferred trigger while the claim
  -- function's pg_catalog-only path is active. Replace its 0117 body in place so
  -- the transitive identity check is equally independent of caller/pg_temp path.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.validate_sandbox_retained_process_v2()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM %1$I.sandbox_workspace_mutation_admissions admission
        WHERE admission.id = NEW.parent_admission_id
          AND admission.account_id = NEW.account_id
          AND admission.workspace_id = NEW.workspace_id
          AND admission.session_id = NEW.session_id
          AND admission.lease_id = NEW.lease_id
          AND admission.sandbox_group_id = NEW.sandbox_group_id
          AND admission.actor_kind = NEW.owner_actor_kind
          AND admission.actor_id = NEW.owner_actor_id
          AND admission.turn_id IS NOT DISTINCT FROM NEW.owner_turn_id
          AND admission.attempt_id IS NOT DISTINCT FROM NEW.owner_attempt_id
          AND admission.execution_generation IS NOT DISTINCT FROM NEW.owner_execution_generation
          AND admission.lease_epoch = NEW.lease_epoch
          AND admission.provider_backend = NEW.provider_backend
          AND admission.provider_instance_id = NEW.provider_instance_id
          AND admission.route_kind = NEW.route_kind
          AND admission.route_target_id IS NOT DISTINCT FROM NEW.route_target_id
          AND admission.route_epoch = NEW.route_epoch
          AND (
            (
              NEW.state = 'active'
              AND admission.provider_outcome = 'retained'
              AND admission.settled_at IS NULL
              AND EXISTS (
                SELECT 1 FROM %1$I.sandbox_lease_holders holder
                WHERE holder.lease_id = NEW.lease_id
                  AND holder.account_id = NEW.account_id
                  AND holder.workspace_id = NEW.workspace_id
                  AND holder.kind = 'process'
                  AND holder.holder_id = NEW.holder_id
                  AND holder.subject_id = NEW.session_id
              )
            ) OR (
              NEW.state IN ('exited', 'lost')
              AND admission.provider_outcome IN ('resolved', 'rejected')
              AND admission.settled_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM %1$I.sandbox_lease_holders holder
                WHERE holder.lease_id = NEW.lease_id
                  AND holder.kind = 'process'
                  AND holder.holder_id = NEW.holder_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM %1$I.sandbox_pty_sessions pty
                WHERE pty.retained_process_id = NEW.id
                  AND pty.status = 'open'
              )
            )
          )
      ) THEN
        RAISE EXCEPTION 'retained process does not match its parent admission and holder state'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $function$;
  $create$, data_schema);

  -- Cross-workspace claim for the sole control-worker reaper. The index-backed
  -- candidate window is locked and limited before owner eligibility joins. A
  -- live owner is deferred so it cannot permanently occupy the oldest due edge.
  -- Claim expiry is represented by reconcile_after; it remains coordination
  -- recovery only and is never physical-exit proof.
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
          candidate.owner_actor_kind = 'direct' OR attempt.state = 'closed' AS eligible,
          CASE
            WHEN candidate.owner_actor_kind = 'direct' THEN 'direct'
            ELSE COALESCE(turn_row.status, 'missing')
          END AS owner_state,
          attempt.outcome AS owner_attempt_outcome
        FROM candidate_window candidate
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

      -- Fire the exact data-schema constraint trigger while the definer still
      -- owns cross-workspace visibility, then restore deferred mode.
      SET CONSTRAINTS %1$I.sandbox_retained_processes_identity_v2 IMMEDIATE;
      SET CONSTRAINTS %1$I.sandbox_retained_processes_identity_v2 DEFERRED;
    END;
    $function$;
  $create$, data_schema);

  -- Fixed-shape global inventories use covering partial indexes over only the
  -- active/draining subsets; retained history and cold/warm lease inventory are
  -- not scanned by a reaper tick. The application normalizes legacy values into
  -- its finite label sets.
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
        SELECT 'direct'::text AS owner_state, true AS terminal_owner
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

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.count_expired_draining_sandbox_leases()
    RETURNS TABLE (backend text, age_bucket text, count bigint)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      SELECT lease.backend,
        CASE
          WHEN pg_catalog.now() - lease.expires_at < interval '5 minutes' THEN 'lt_5m'
          WHEN pg_catalog.now() - lease.expires_at < interval '1 hour' THEN '5m_1h'
          WHEN pg_catalog.now() - lease.expires_at < interval '1 day' THEN '1h_1d'
          ELSE 'gte_1d'
        END AS age_bucket,
        pg_catalog.count(*)::bigint
      FROM %1$I.sandbox_leases lease
      WHERE lease.liveness = 'draining'
        AND lease.expires_at < pg_catalog.now()
      GROUP BY lease.backend, age_bucket;
    $function$;
  $create$, data_schema);
END $privileged_functions$;

-- PostgreSQL grants new functions to PUBLIC by default. These functions bypass
-- workspace RLS, so only the migration owner and explicit application role may
-- execute them.
REVOKE ALL ON FUNCTION opengeni_private.claim_terminal_retained_processes(uuid, integer, bigint)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.count_active_retained_processes_by_owner_state()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.count_expired_draining_sandbox_leases()
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_terminal_retained_processes(uuid, integer, bigint)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.count_active_retained_processes_by_owner_state()
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.count_expired_draining_sandbox_leases()
      TO opengeni_app;
  END IF;
END $$;
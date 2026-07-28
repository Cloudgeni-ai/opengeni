-- deployment-mode: rolling
-- OPE-118: terminal owners do not prove provider quiescence. Persist only a
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

-- Cross-workspace claim for the sole control-worker reaper. A closed attempt or
-- direct request makes a row eligible for provider inspection, never deletion.
-- Claim expiry is coordination recovery only; it is not physical-exit proof.
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
-- EMBED-SAFE: the data tables live in the caller-selected public or dedicated
-- schema. Match the existing cross-workspace reapers by inheriting that
-- schema-aware search_path; opengeni_private is absolute. Execution is revoked
-- from PUBLIC below and granted only to the application role.
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'retained-process reconciliation limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;
  IF p_claim_ttl_ms < 0 OR p_claim_ttl_ms > 3600000 THEN
    RAISE EXCEPTION 'retained-process reconciliation claim TTL is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);

  RETURN QUERY
  WITH candidates AS (
    SELECT process.id
    FROM sandbox_retained_processes process
    LEFT JOIN session_turn_attempts attempt
      ON attempt.workspace_id = process.workspace_id
     AND attempt.id = process.owner_attempt_id
    WHERE process.state = 'active'
      AND process.reconcile_after <= now()
      AND (
        process.reconcile_claim_id IS NULL
        OR process.reconcile_claimed_at
          <= now() - make_interval(secs => p_claim_ttl_ms / 1000.0)
      )
      AND (process.owner_actor_kind = 'direct' OR attempt.state = 'closed')
    ORDER BY process.reconcile_after, process.started_at, process.id
    FOR UPDATE OF process SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE sandbox_retained_processes process SET
      reconcile_claim_id = p_claim_id,
      reconcile_claimed_at = now(),
      reconcile_attempts = process.reconcile_attempts + 1,
      last_reconcile_outcome = 'claimed'
    FROM candidates
    WHERE process.id = candidates.id
      AND process.state = 'active'
    RETURNING process.*
  )
  SELECT claimed.account_id,
    claimed.workspace_id,
    claimed.session_id,
    claimed.id,
    claimed.reconcile_claim_id,
    CASE
      WHEN claimed.owner_actor_kind = 'direct' THEN 'direct'
      ELSE coalesce(turn.status, 'missing')
    END,
    attempt.outcome
  FROM claimed
  LEFT JOIN session_turns turn
    ON turn.workspace_id = claimed.workspace_id
   AND turn.id = claimed.owner_turn_id
  LEFT JOIN session_turn_attempts attempt
    ON attempt.workspace_id = claimed.workspace_id
   AND attempt.id = claimed.owner_attempt_id
  ORDER BY claimed.reconcile_after, claimed.started_at, claimed.id;

  -- This cross-workspace SECURITY DEFINER write is invoked without one
  -- workspace RLS context. Fire the pre-existing deferred identity trigger
  -- while the definer still owns visibility, then restore the caller's normal
  -- deferred mode for any later retained-process work in the transaction.
  SET CONSTRAINTS sandbox_retained_processes_identity_v2 IMMEDIATE;
  SET CONSTRAINTS sandbox_retained_processes_identity_v2 DEFERRED;
END;
$$;

-- Fixed-shape global inventory for app-owned Prometheus gauges. The application
-- normalizes unknown legacy owner states before using them as labels.
CREATE OR REPLACE FUNCTION opengeni_private.count_active_retained_processes_by_owner_state()
RETURNS TABLE (owner_state text, active_count bigint, terminal_owner_count bigint)
LANGUAGE sql
SECURITY DEFINER
-- See the embed-safe/restricted-execution contract on the claim function.
AS $$
  SELECT inventory.owner_state,
    count(*)::bigint AS active_count,
    count(*) FILTER (WHERE inventory.terminal_owner)::bigint AS terminal_owner_count
  FROM (
    SELECT CASE
        WHEN process.owner_actor_kind = 'direct' THEN 'direct'
        ELSE coalesce(turn.status, 'missing')
      END AS owner_state,
      (process.owner_actor_kind = 'direct' OR attempt.state = 'closed') AS terminal_owner
    FROM sandbox_retained_processes process
    LEFT JOIN session_turns turn
      ON turn.workspace_id = process.workspace_id
     AND turn.id = process.owner_turn_id
    LEFT JOIN session_turn_attempts attempt
      ON attempt.workspace_id = process.workspace_id
     AND attempt.id = process.owner_attempt_id
    WHERE process.state = 'active'
  ) inventory
  GROUP BY inventory.owner_state;
$$;

CREATE OR REPLACE FUNCTION opengeni_private.count_expired_draining_sandbox_leases()
RETURNS TABLE (backend text, age_bucket text, count bigint)
LANGUAGE sql
SECURITY DEFINER
-- See the embed-safe/restricted-execution contract on the claim function.
AS $$
  SELECT lease.backend,
    CASE
      WHEN now() - lease.expires_at < interval '5 minutes' THEN 'lt_5m'
      WHEN now() - lease.expires_at < interval '1 hour' THEN '5m_1h'
      WHEN now() - lease.expires_at < interval '1 day' THEN '1h_1d'
      ELSE 'gte_1d'
    END AS age_bucket,
    count(*)::bigint
  FROM sandbox_leases lease
  WHERE lease.liveness = 'draining'
    AND lease.expires_at < now()
  GROUP BY lease.backend, age_bucket;
$$;

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
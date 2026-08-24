-- deployment-mode: rolling
-- Completes the organization-tenancy backfill evidence chain without
-- activating an organization at migration time.
--
-- Migration 0300 made receipts durable, but the membership driver did not
-- write one and 0303 checked only that the ledger migration existed. A new
-- activation could therefore cross the one-way boundary without proving that
-- every executable phase-D classifier had actually settled. This forward
-- repair keeps the existing activation signature and operator arguments, adds
-- the missing membership reason vocabulary, and binds the exact five settled
-- receipts used by every NEW activation.
--
-- Existing activation rows deliberately keep an empty receipt-id array. They
-- predate this evidence contract and remain replayable for identical
-- inventory/parity digests; pretending they had evidence would be worse than
-- preserving that explicit legacy fact. New activations always store five ids.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE tenancy_backfill_unresolved_rows
  DROP CONSTRAINT tenancy_backfill_unresolved_reason_chk,
  ADD CONSTRAINT tenancy_backfill_unresolved_reason_chk CHECK (
    reason_code IN (
      'no_deterministic_evidence',
      'ambiguous_candidate_authority',
      'missing_organization_membership',
      'conflicting_authority_rows',
      'external_lane_owns_row',
      'legacy_shape_unrecognized',
      'missing_login_identity',
      'organization_identity_mismatch',
      'missing_owner_workspace_membership',
      'membership_terminal_status'
    )
  );

ALTER TABLE session_tenancy_activations
  ADD COLUMN backfill_receipt_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  ADD CONSTRAINT session_tenancy_activation_backfill_receipts_check CHECK (
    cardinality(backfill_receipt_ids) IN (0, 5)
  );

-- Owner-only, content-free evidence projection. The newest receipt for each
-- required family is authoritative: a later open/failed attempt must not be
-- hidden behind an older successful run. Resource and session receipts must
-- cover the current full-family population. Membership receipts are produced
-- only by a complete-from-the-start driver walk; partial/resumed walks settle
-- failed and therefore cannot pass this check.
--
-- Sessions deliberately may retain unresolved rows: service/API-key sessions
-- can remain ownerless forever, and migration 0298 owns the truthful
-- attributable-subset gate. Membership residuals are likewise interpreted by
-- the current inventory/parity gates. Variable Sets, Rigs, and Machines have
-- no such legitimate ambiguity, so their completed classification receipts
-- must carry zero unresolved rows.
CREATE OR REPLACE FUNCTION check_tenancy_backfill_activation_evidence(
  p_account_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '5min'
AS $$
DECLARE
  previous_lifecycle_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  resource_report jsonb;
  session_report jsonb;
  result jsonb;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'tenancy backfill activation evidence requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy backfill activation evidence scope mismatch'
      USING ERRCODE = '42501';
  END IF;

  -- These no-run-key calls are read-only and reuse the exact classifiers that
  -- produced the resource/session receipts. Their totals distinguish a full
  -- classifier receipt from a bounded session repair receipt.
  resource_report := verify_organization_resource_classification(p_account_id, NULL);
  session_report := classify_organization_session_ownership(p_account_id, NULL);

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'tenancy_backfill_ledger', true
  );

  WITH required(resource_family, expected_total, unresolved_must_be_zero, family_order) AS (
    VALUES
      ('organization_memberships'::text, NULL::bigint, false, 1),
      (
        'sessions'::text,
        (session_report #>> '{sessions,total}')::bigint,
        false,
        2
      ),
      (
        'variable_sets'::text,
        (resource_report #>> '{families,variable_sets,total}')::bigint,
        true,
        3
      ),
      (
        'rigs'::text,
        (resource_report #>> '{families,rigs,total}')::bigint,
        true,
        4
      ),
      (
        'machines'::text,
        (resource_report #>> '{families,machines,total}')::bigint,
        true,
        5
      )
  ), latest_receipt AS (
    SELECT DISTINCT ON (receipt.resource_family)
      receipt.resource_family,
      receipt.id,
      receipt.run_key,
      receipt.status,
      receipt.classified_count,
      receipt.skipped_count,
      receipt.unresolved_count,
      receipt.started_at
    FROM tenancy_backfill_receipts receipt
    WHERE receipt.account_id = p_account_id
      AND receipt.resource_family IN (SELECT resource_family FROM required)
    ORDER BY receipt.resource_family, receipt.started_at DESC, receipt.id DESC
  ), evaluated AS (
    SELECT required.*,
      latest_receipt.id AS receipt_id,
      latest_receipt.run_key,
      latest_receipt.status,
      latest_receipt.classified_count,
      latest_receipt.skipped_count,
      latest_receipt.unresolved_count,
      CASE
        WHEN latest_receipt.id IS NULL THEN 'missing_receipt'
        WHEN latest_receipt.status <> 'completed' THEN 'receipt_not_completed'
        WHEN required.expected_total IS NOT NULL
          AND latest_receipt.classified_count
            + latest_receipt.skipped_count
            + latest_receipt.unresolved_count
              <> required.expected_total
          THEN 'population_mismatch'
        WHEN required.unresolved_must_be_zero
          AND latest_receipt.unresolved_count <> 0
          THEN 'unresolved_rows'
        ELSE NULL
      END AS blocker
    FROM required
    LEFT JOIN latest_receipt USING (resource_family)
  )
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'organizationId', p_account_id,
    'ready', pg_catalog.bool_and(blocker IS NULL),
    'receiptIds', coalesce(
      pg_catalog.jsonb_agg(receipt_id ORDER BY family_order)
        FILTER (WHERE receipt_id IS NOT NULL),
      '[]'::jsonb
    ),
    'blockers', coalesce(
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'resourceFamily', resource_family,
        'code', blocker
      ) ORDER BY family_order) FILTER (WHERE blocker IS NOT NULL),
      '[]'::jsonb
    ),
    'families', pg_catalog.jsonb_object_agg(
      resource_family,
      pg_catalog.jsonb_build_object(
        'receiptId', receipt_id,
        'runKey', run_key,
        'status', status,
        'classifiedCount', classified_count,
        'skippedCount', skipped_count,
        'unresolvedCount', unresolved_count,
        'expectedTotal', expected_total,
        'blocker', blocker
      )
      ORDER BY family_order
    )
  ) INTO result
  FROM evaluated;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    coalesce(previous_lifecycle_marker, ''), true
  );
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    coalesce(previous_lifecycle_marker, ''), true
  );
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION check_tenancy_backfill_activation_evidence(uuid) FROM PUBLIC;

-- Preserve 0303's exact public/operator signature. Existing identical
-- activations replay before the new evidence check. A new activation checks
-- the evidence only after the application drain and global locks, then stores
-- the five exact receipt ids without accepting a new operator argument.
CREATE OR REPLACE FUNCTION activate_session_tenancy_product(
  p_account_id uuid,
  p_inventory_digest text,
  p_parity_digest text,
  p_activated_by text,
  p_application_roles text[]
) RETURNS TABLE (
  account_id uuid,
  activation_version integer,
  activated_at timestamptz,
  replay boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  existing session_tenancy_activations%ROWTYPE;
  inserted session_tenancy_activations%ROWTYPE;
  backfill_evidence jsonb;
  evidence_receipt_ids uuid[];
BEGIN
  IF p_account_id IS NULL
    OR p_inventory_digest !~ '^[0-9a-f]{64}$'
    OR p_parity_digest !~ '^[0-9a-f]{64}$'
    OR octet_length(btrim(p_activated_by)) NOT BETWEEN 1 AND 256
    OR p_application_roles IS NULL
    OR cardinality(p_application_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM unnest(p_application_roles) role_name
      WHERE role_name IS NULL OR role_name <> btrim(role_name)
        OR octet_length(role_name) NOT BETWEEN 1 AND 63
    )
    OR cardinality(ARRAY(SELECT DISTINCT role_name FROM unnest(p_application_roles) role_name))
      <> cardinality(p_application_roles)
  THEN
    RAISE EXCEPTION 'session tenancy activation request is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    WHERE activity.datname = current_database()
      AND activity.usename = ANY(p_application_roles)
      AND activity.pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'session tenancy activation requires every application role session to be stopped'
      USING ERRCODE = '55000';
  END IF;

  LOCK TABLE sessions, session_turns, session_turn_attempts,
    session_attempt_interruptions, session_system_updates,
    session_human_input_requests, session_pending_tool_calls, agent_run_states,
    session_goals, codex_capacity_waiters, xai_capacity_waiters,
    session_realtime_modes, session_realtime_connections, scheduled_tasks,
    sandbox_workspace_mutation_admissions, sandbox_retained_processes,
    sandbox_lease_holders, organization_user_resource_grants,
    tenancy_backfill_receipts, tenancy_backfill_unresolved_rows,
    session_tenancy_activations IN ACCESS EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    WHERE activity.datname = current_database()
      AND activity.usename = ANY(p_application_roles)
      AND activity.pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'session tenancy activation requires every application role session to be stopped'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO existing FROM session_tenancy_activations activation
  WHERE activation.account_id = p_account_id;
  IF FOUND THEN
    IF existing.inventory_digest <> p_inventory_digest
      OR existing.parity_digest <> p_parity_digest
    THEN
      RAISE EXCEPTION 'session tenancy activation evidence conflicts with the durable receipt'
        USING ERRCODE = '23505';
    END IF;
    account_id := existing.account_id;
    activation_version := existing.activation_version;
    activated_at := existing.activated_at;
    replay := true;
    RETURN NEXT;
    RETURN;
  END IF;

  -- The owner-only activation seam already treats p_account_id as its exact
  -- tenant argument. Establish the same transaction-local scope expected by
  -- the read-only classifier/ledger seams so direct migration-owner callers
  -- keep 0303's existing signature and do not need a new setup statement.
  PERFORM pg_catalog.set_config('opengeni.account_id', p_account_id::text, true);
  backfill_evidence := check_tenancy_backfill_activation_evidence(p_account_id);
  IF coalesce((backfill_evidence ->> 'ready')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'session tenancy activation requires settled backfill evidence'
      USING ERRCODE = '55000', DETAIL = (backfill_evidence -> 'blockers')::text;
  END IF;
  SELECT array_agg(receipt_id::uuid ORDER BY ordinal)
    INTO evidence_receipt_ids
  FROM jsonb_array_elements_text(backfill_evidence -> 'receiptIds')
    WITH ORDINALITY AS evidence(receipt_id, ordinal);
  IF cardinality(evidence_receipt_ids) <> 5 THEN
    RAISE EXCEPTION 'session tenancy activation backfill evidence is structurally invalid'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO session_tenancy_activations (
    account_id, activation_version, inventory_digest, parity_digest,
    activated_by, backfill_receipt_ids
  ) VALUES (
    p_account_id, 1, p_inventory_digest, p_parity_digest,
    btrim(p_activated_by), evidence_receipt_ids
  ) RETURNING * INTO inserted;

  account_id := inserted.account_id;
  activation_version := inserted.activation_version;
  activated_at := inserted.activated_at;
  replay := false;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION
  activate_session_tenancy_product(uuid, text, text, text, text[]) FROM PUBLIC;

DO $tenancy_backfill_activation_search_path$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.check_tenancy_backfill_activation_evidence(uuid) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.activate_session_tenancy_product(uuid,text,text,text,text[]) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema, data_schema
  );
END
$tenancy_backfill_activation_search_path$;

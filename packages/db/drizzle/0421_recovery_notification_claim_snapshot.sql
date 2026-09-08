-- deployment-mode: rolling
-- Lock candidate outbox rows before a fresh statement rechecks immutable delivery
-- evidence. The outbox itself is unchanged by a claim, so a single statement can
-- otherwise use pre-commit attempt eligibility after acquiring a released lock.
-- Existing callers, row limits, leases, idempotency keys and authority are unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $recovery_notification_claim_snapshot$
DECLARE
  definition text;
  current_body text;
  replacement_body text;
  routine_template constant text := $routine$
CREATE OR REPLACE FUNCTION prepare_organization_recovery_notifications(
  p_provider text, p_claim_owner text, p_limit integer, p_lease_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  result jsonb;
  stale_ids uuid[];
  candidate_ids uuid[];
  now_value timestamptz := pg_catalog.clock_timestamp();
  previous_marker text := pg_catalog.current_setting(
    'opengeni.organization_recovery_lifecycle', true
  );
BEGIN
  -- The next statement must observe a claimant or settler that committed before
  -- this transaction acquired the immutable outbox row. Snapshot-isolated
  -- transactions cannot refresh that evidence and must not dispatch a payload.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'organization recovery notification claims require READ COMMITTED isolation'
      USING ERRCODE = '25001';
  END IF;
  IF p_provider IS NULL OR p_provider <> lower(btrim(p_provider))
    OR length(p_provider) NOT BETWEEN 1 AND 64
    OR p_claim_owner IS NULL OR length(btrim(p_claim_owner)) NOT BETWEEN 1 AND 256
    OR p_limit NOT BETWEEN 1 AND 100
    OR p_lease_seconds NOT BETWEEN 15 AND 300
  THEN
    RAISE EXCEPTION 'organization recovery notification claim is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle', 'active', true);

  -- A provider_started lease is not silently forgotten. Its expiry is immutable
  -- evidence that the payload was handed to a dispatcher but was not recorded
  -- as called; the stable provider idempotency key remains unchanged on reclaim.
  -- Retain row custody before consulting delivery evidence with a fresh snapshot.
  WITH stale AS (
    SELECT outbox.id, started.delivery_id, started.provider, started.claim_owner,
      started.attempt_number, started.lease_expires_at
    FROM organization_recovery_notification_outbox outbox
    INNER JOIN LATERAL (
      SELECT attempt.*
      FROM organization_recovery_notification_attempts attempt
      WHERE attempt.outbox_id = outbox.id AND attempt.phase = 'provider_started'
      ORDER BY attempt.attempt_number DESC, attempt.created_at DESC, attempt.id DESC
      LIMIT 1
    ) started ON true
    WHERE started.lease_expires_at <= now_value
      AND NOT EXISTS (
        SELECT 1 FROM organization_recovery_notification_attempts terminal
        WHERE terminal.outbox_id = outbox.id
          AND terminal.delivery_id = started.delivery_id
          AND terminal.phase IN ('sent', 'failed', 'outcome_unknown', 'claim_expired')
      )
    ORDER BY outbox.created_at, outbox.id
    LIMIT p_limit
    FOR UPDATE OF outbox SKIP LOCKED
  )
  SELECT coalesce(pg_catalog.array_agg(id), ARRAY[]::uuid[]) INTO stale_ids
  FROM stale;

  WITH stale AS (
    SELECT outbox.id, started.delivery_id, started.provider, started.claim_owner,
      started.attempt_number, started.lease_expires_at
    FROM organization_recovery_notification_outbox outbox
    INNER JOIN LATERAL (
      SELECT attempt.*
      FROM organization_recovery_notification_attempts attempt
      WHERE attempt.outbox_id = outbox.id AND attempt.phase = 'provider_started'
      ORDER BY attempt.attempt_number DESC, attempt.created_at DESC, attempt.id DESC
      LIMIT 1
    ) started ON true
    WHERE outbox.id = ANY(stale_ids)
      AND started.lease_expires_at <= now_value
      AND NOT EXISTS (
        SELECT 1 FROM organization_recovery_notification_attempts terminal
        WHERE terminal.outbox_id = outbox.id
          AND terminal.delivery_id = started.delivery_id
          AND terminal.phase IN ('sent', 'failed', 'outcome_unknown', 'claim_expired')
      )
    ORDER BY outbox.created_at, outbox.id
    LIMIT p_limit
    FOR UPDATE OF outbox SKIP LOCKED
  )
  INSERT INTO organization_recovery_notification_attempts (
    outbox_id, delivery_id, provider, claim_owner, attempt_number,
    lease_expires_at, phase, created_at
  ) SELECT
    stale.id, stale.delivery_id, stale.provider, stale.claim_owner,
    stale.attempt_number, stale.lease_expires_at, 'claim_expired', now_value
  FROM stale
  ON CONFLICT (outbox_id, delivery_id, phase) DO NOTHING;

  -- An unchanged outbox row does not cause PostgreSQL to refresh an old
  -- statement snapshot after its previous lock holder commits. Lock first.
  WITH candidates AS (
    SELECT outbox.id
    FROM organization_recovery_notification_outbox outbox
    LEFT JOIN LATERAL (
      SELECT attempt.phase, attempt.attempt_number, attempt.created_at
      FROM organization_recovery_notification_attempts attempt
      WHERE attempt.outbox_id = outbox.id
      ORDER BY attempt.created_at DESC, attempt.id DESC
      LIMIT 1
    ) latest ON true
    WHERE NOT EXISTS (
      SELECT 1 FROM organization_recovery_notification_attempts attempt
      WHERE attempt.outbox_id = outbox.id
        AND attempt.phase IN ('sent', 'reconciled_sent')
    )
      AND NOT EXISTS (
        SELECT 1 FROM organization_recovery_notification_attempts ambiguous
        WHERE ambiguous.outbox_id = outbox.id AND ambiguous.phase = 'outcome_unknown'
          AND NOT EXISTS (
            SELECT 1 FROM organization_recovery_notification_attempts reconciliation
            WHERE reconciliation.outbox_id = ambiguous.outbox_id
              AND reconciliation.delivery_id = ambiguous.delivery_id
              AND reconciliation.phase IN ('reconciled_sent', 'reconciled_retry')
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM organization_recovery_notification_attempts started
        WHERE started.outbox_id = outbox.id AND started.phase = 'provider_started'
          AND NOT EXISTS (
            SELECT 1 FROM organization_recovery_notification_attempts terminal
            WHERE terminal.outbox_id = started.outbox_id
              AND terminal.delivery_id = started.delivery_id
              AND terminal.phase IN ('sent', 'failed', 'outcome_unknown', 'claim_expired')
          )
      )
      AND (
        SELECT pg_catalog.count(*)
        FROM organization_recovery_notification_attempts started
        WHERE started.outbox_id = outbox.id AND started.phase = 'provider_started'
      ) < 5
      AND (
        latest.phase IS NULL
        OR latest.phase IN ('claim_expired', 'reconciled_retry')
        OR (
          latest.phase = 'failed'
          AND latest.created_at + pg_catalog.make_interval(
            secs => least(900, 60 * (2 ^ greatest(0, latest.attempt_number - 1))::integer)
          ) <= now_value
        )
      )
    ORDER BY outbox.created_at, outbox.id
    LIMIT p_limit FOR UPDATE OF outbox SKIP LOCKED
  )
  SELECT coalesce(pg_catalog.array_agg(id), ARRAY[]::uuid[]) INTO candidate_ids
  FROM candidates;

  WITH candidates AS (
    SELECT outbox.id
    FROM organization_recovery_notification_outbox outbox
    LEFT JOIN LATERAL (
      SELECT attempt.phase, attempt.attempt_number, attempt.created_at
      FROM organization_recovery_notification_attempts attempt
      WHERE attempt.outbox_id = outbox.id
      ORDER BY attempt.created_at DESC, attempt.id DESC
      LIMIT 1
    ) latest ON true
    WHERE outbox.id = ANY(candidate_ids)
      AND NOT EXISTS (
      SELECT 1 FROM organization_recovery_notification_attempts attempt
      WHERE attempt.outbox_id = outbox.id
        AND attempt.phase IN ('sent', 'reconciled_sent')
    )
      AND NOT EXISTS (
        SELECT 1 FROM organization_recovery_notification_attempts ambiguous
        WHERE ambiguous.outbox_id = outbox.id AND ambiguous.phase = 'outcome_unknown'
          AND NOT EXISTS (
            SELECT 1 FROM organization_recovery_notification_attempts reconciliation
            WHERE reconciliation.outbox_id = ambiguous.outbox_id
              AND reconciliation.delivery_id = ambiguous.delivery_id
              AND reconciliation.phase IN ('reconciled_sent', 'reconciled_retry')
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM organization_recovery_notification_attempts started
        WHERE started.outbox_id = outbox.id AND started.phase = 'provider_started'
          AND NOT EXISTS (
            SELECT 1 FROM organization_recovery_notification_attempts terminal
            WHERE terminal.outbox_id = started.outbox_id
              AND terminal.delivery_id = started.delivery_id
              AND terminal.phase IN ('sent', 'failed', 'outcome_unknown', 'claim_expired')
          )
      )
      AND (
        SELECT pg_catalog.count(*)
        FROM organization_recovery_notification_attempts started
        WHERE started.outbox_id = outbox.id AND started.phase = 'provider_started'
      ) < 5
      AND (
        latest.phase IS NULL
        OR latest.phase IN ('claim_expired', 'reconciled_retry')
        OR (
          latest.phase = 'failed'
          AND latest.created_at + pg_catalog.make_interval(
            secs => least(900, 60 * (2 ^ greatest(0, latest.attempt_number - 1))::integer)
          ) <= now_value
        )
      )
    ORDER BY outbox.created_at, outbox.id
    LIMIT p_limit FOR UPDATE OF outbox SKIP LOCKED
  ), started AS (
    INSERT INTO organization_recovery_notification_attempts (
      outbox_id, delivery_id, provider, claim_owner, attempt_number,
      lease_expires_at, phase, created_at
    )
    SELECT candidate.id, gen_random_uuid(), p_provider, p_claim_owner,
      1 + (
        SELECT pg_catalog.count(*)::integer
        FROM organization_recovery_notification_attempts prior
        WHERE prior.outbox_id = candidate.id AND prior.phase = 'provider_started'
      ), now_value + pg_catalog.make_interval(secs => p_lease_seconds),
      'provider_started', now_value
    FROM candidates candidate
    RETURNING id, outbox_id, delivery_id, provider, claim_owner,
      attempt_number, lease_expires_at, created_at
  )
  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'attemptId', started.id::text,
      'outboxId', outbox.id::text,
      'deliveryId', started.delivery_id::text,
      'provider', started.provider,
      'claimOwner', started.claim_owner,
      'attemptNumber', started.attempt_number,
      'leaseExpiresAt', started.lease_expires_at,
      'idempotencyKey', outbox.idempotency_key,
      'recipientCanonicalIdentityId', outbox.recipient_identity_id::text,
      'notificationType', outbox.notification_type,
      'payloadDigest', outbox.payload_digest,
      'payload', outbox.payload
    ) ORDER BY outbox.created_at, outbox.id
  ), '[]'::jsonb) INTO result
  FROM started
  INNER JOIN organization_recovery_notification_outbox outbox
    ON outbox.id = started.outbox_id;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
  RAISE;
END
$body$;

$routine$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(oid), prosrc
  INTO definition, current_body
  FROM pg_catalog.pg_proc
  WHERE oid = 'prepare_organization_recovery_notifications(text,text,integer,integer)'::regprocedure;
  replacement_body := pg_catalog.split_part(routine_template, '$body$', 2);
  IF current_body = replacement_body THEN
    RETURN;
  END IF;
  IF pg_catalog.md5(current_body) IS DISTINCT FROM 'a82b87db0e2ca832ab87c51f351f4ba6' THEN
    RAISE EXCEPTION '0421 recovery notification claim prerequisite definition drift'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.replace(definition, current_body, replacement_body);
END
$recovery_notification_claim_snapshot$;

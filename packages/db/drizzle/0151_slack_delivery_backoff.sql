SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE slack_interactions
  ADD COLUMN delivery_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN delivery_retry_at timestamptz,
  ADD COLUMN delivery_last_error_code text;

ALTER TABLE slack_interactions
  ADD CONSTRAINT slack_interactions_delivery_attempt_check
    CHECK (delivery_attempt_count >= 0),
  ADD CONSTRAINT slack_interactions_delivery_error_check
    CHECK (
      delivery_last_error_code IS NULL
      OR octet_length(delivery_last_error_code) BETWEEN 1 AND 128
    );

ALTER TABLE slack_interaction_inbox
  ADD COLUMN retry_at timestamptz;

DROP INDEX slack_interaction_inbox_pending_idx;
CREATE INDEX slack_interaction_inbox_pending_idx
  ON slack_interaction_inbox (status, retry_at, created_at, id)
  WHERE status IN ('pending', 'processing');

DROP INDEX slack_interactions_delivery_idx;
CREATE INDEX slack_interactions_delivery_idx
  ON slack_interactions (terminal_delivery_state, delivery_retry_at, updated_at, id)
  WHERE session_id IS NOT NULL AND terminal_delivery_state = 'open';

DO $privileged_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_slack_interaction_inbox(
      p_holder uuid,
      p_lease_ms integer
    )
    RETURNS SETOF %1$I.slack_interaction_inbox
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_lease_ms < 1000 OR p_lease_ms > 300000 THEN
        RAISE EXCEPTION 'invalid Slack inbox claim lease';
      END IF;
      RETURN QUERY
      WITH candidate AS (
        SELECT I.id
        FROM %1$I.slack_interaction_inbox I
        WHERE (
            I.status = 'pending'
            AND (I.retry_at IS NULL OR I.retry_at <= now())
          ) OR (
            I.status = 'processing'
            AND I.claim_expires_at <= now()
          )
        ORDER BY I.retry_at NULLS FIRST, I.created_at, I.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE %1$I.slack_interaction_inbox I
      SET status = 'processing',
          claim_holder_id = p_holder,
          claim_expires_at = now() + make_interval(secs => p_lease_ms::double precision / 1000),
          retry_at = NULL,
          attempt_count = I.attempt_count + 1,
          updated_at = now()
      FROM candidate C
      WHERE I.id = C.id
      RETURNING I.*;
    END
    $function$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_slack_interaction_delivery(
      p_holder uuid,
      p_lease_ms integer
    )
    RETURNS SETOF %1$I.slack_interactions
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_lease_ms < 1000 OR p_lease_ms > 300000 THEN
        RAISE EXCEPTION 'invalid Slack delivery claim lease';
      END IF;
      RETURN QUERY
      WITH candidate AS (
        SELECT I.id
        FROM %1$I.slack_interactions I
        WHERE I.session_id IS NOT NULL
          AND I.terminal_delivery_state = 'open'
          AND (I.delivery_retry_at IS NULL OR I.delivery_retry_at <= now())
          AND (I.delivery_claim_holder_id IS NULL OR I.delivery_claim_expires_at <= now())
          AND EXISTS (
            SELECT 1
            FROM %1$I.session_events E
            WHERE E.workspace_id = I.workspace_id
              AND E.session_id = I.session_id
              AND E.sequence > I.last_delivered_session_event_sequence
              AND E.type IN (
                'agent.message.completed',
                'session.humanInput.requested',
                'turn.completed',
                'turn.failed',
                'turn.cancelled',
                'session.status.changed'
              )
          )
        ORDER BY I.delivery_retry_at NULLS FIRST, I.updated_at, I.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE %1$I.slack_interactions I
      SET delivery_claim_holder_id = p_holder,
          delivery_claim_expires_at = now() + make_interval(secs => p_lease_ms::double precision / 1000),
          delivery_attempt_count = I.delivery_attempt_count + 1,
          updated_at = now()
      FROM candidate C
      WHERE I.id = C.id
      RETURNING I.*;
    END
    $function$
  $ddl$, data_schema);
END
$privileged_functions$;

RESET statement_timeout;
RESET lock_timeout;

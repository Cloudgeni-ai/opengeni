-- deployment-mode: rolling
-- A private human-DM shortcut is initially keyed to a source conversation the
-- workspace bot cannot join. Delivery becomes eligible only after the durable
-- acknowledgement has rekeyed the route to the invoking user's bot-DM thread.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

DO $migration$
DECLARE data_schema text := current_schema();
BEGIN
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
          AND NOT (
            I.visibility = 'private'
            AND I.triggering_provider_event_id LIKE 'shortcut:%%'
            AND I.ack_slack_message_ts IS NULL
          )
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
$migration$;

REVOKE ALL ON FUNCTION opengeni_private.claim_slack_interaction_delivery(uuid, integer)
  FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_slack_interaction_delivery(uuid, integer)
      TO opengeni_app;
  END IF;
END
$grants$;

RESET statement_timeout;
RESET lock_timeout;
-- deployment-mode: rolling
-- Historical, fully quiesced interruptions are audit evidence, not live control work.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

DROP FUNCTION opengeni_private.claim_session_workflow_wakes(integer);

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.claim_session_workflow_wakes(p_limit integer)
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      session_id uuid,
      temporal_workflow_id text,
      wake_revision bigint,
      interruption_requested boolean
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      RETURN QUERY
        WITH due AS (
          SELECT o.session_id
          FROM %1$I.session_workflow_wake_outbox o
          WHERE o.wake_revision > o.delivered_revision
            AND o.next_attempt_at <= now()
          ORDER BY o.next_attempt_at, o.updated_at, o.session_id
          FOR UPDATE SKIP LOCKED
          LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
        )
        UPDATE %1$I.session_workflow_wake_outbox o
        SET attempts = o.attempts + 1,
            next_attempt_at = now() + make_interval(
              secs => least(300, greatest(1, power(2, least(o.attempts, 8))::integer))
            ),
            updated_at = now()
        FROM due
        WHERE o.session_id = due.session_id
        RETURNING o.account_id, o.workspace_id, o.session_id,
          o.temporal_workflow_id, o.wake_revision,
          o.control_revision > o.delivered_revision
          OR EXISTS (
            SELECT 1
            FROM %1$I.session_attempt_interruptions interruption
            JOIN %1$I.session_turn_attempts attempt
              ON attempt.workspace_id = interruption.workspace_id
             AND attempt.session_id = interruption.session_id
             AND attempt.id = interruption.attempt_id
            WHERE interruption.workspace_id = o.workspace_id
              AND interruption.session_id = o.session_id
              AND (
                interruption.state IN ('pending', 'delivered', 'acknowledged')
                OR (
                  interruption.state IN ('settled', 'rejected_stale')
                  AND attempt.quiesced_at IS NULL
                )
              )
          ) AS interruption_requested;
    END $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION opengeni_private.claim_session_workflow_wakes(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_session_workflow_wakes(integer)
      TO opengeni_app;
  END IF;
END $$;

RESET statement_timeout;
RESET lock_timeout;

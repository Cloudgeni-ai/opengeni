-- deployment-mode: rolling
-- Extend the existing bounded, content-free recovery inventory to quiesced
-- logical turns whose workflow wake was lost. Discovery grants no admission;
-- the scoped runtime repair rechecks ordinary Pause/capacity/setup blockers.
-- Historical retirement is opt-in with an exact operator manifest. There is
-- no age-based cancellation or implicit replay of paused accepted work.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $install$
DECLARE target_schema text := current_schema(); dispatcher_owner text; role_name text;
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.list_quiescence_receipt_wake_repairs_v1(
      p_limit integer, p_after_workspace_id uuid, p_after_session_id uuid)
    RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid quiescence repair batch'; END IF;
      IF (p_after_workspace_id IS NULL) <> (p_after_session_id IS NULL) THEN
        RAISE EXCEPTION 'incomplete quiescence repair cursor';
      END IF;
      RETURN QUERY
        SELECT session.account_id, session.workspace_id, session.id
        FROM %1$I.sessions session
        JOIN %1$I.session_turns turn ON turn.workspace_id = session.workspace_id
          AND turn.session_id = session.id AND turn.id = session.active_turn_id
        JOIN LATERAL (
          SELECT candidate.id, candidate.state, candidate.outcome, candidate.quiesced_at,
            coalesce(candidate.closed_at, candidate.updated_at) AS closed_at
          FROM %1$I.session_turn_attempts candidate
          WHERE candidate.workspace_id = turn.workspace_id AND candidate.session_id = turn.session_id
            AND candidate.turn_id = turn.id
          ORDER BY candidate.execution_generation DESC, candidate.updated_at DESC, candidate.id DESC LIMIT 1
        ) attempt ON true
        LEFT JOIN %1$I.session_workflow_wake_outbox wake ON wake.workspace_id = session.workspace_id AND wake.session_id = session.id
        WHERE turn.status = 'recovering' AND turn.active_attempt_id IS NULL
          AND attempt.state = 'closed' AND attempt.outcome = 'interrupted_recoverable'
          AND (attempt.quiesced_at IS NULL AND session.status = 'recovering'
            OR attempt.quiesced_at IS NOT NULL AND session.status NOT IN ('failed', 'cancelled'))
          AND attempt.closed_at < now() - interval '2 minutes'
          AND (EXISTS (
            SELECT 1 FROM %1$I.session_attempt_interruptions interruption
            WHERE interruption.workspace_id = session.workspace_id AND interruption.session_id = session.id
              AND interruption.attempt_id = attempt.id AND interruption.state IN ('settled', 'rejected_stale'))
            OR EXISTS (
              SELECT 1 FROM %1$I.session_events event WHERE event.workspace_id = session.workspace_id
                AND event.session_id = session.id AND event.turn_id = turn.id
                AND event.turn_attempt_id = attempt.id AND event.type = 'turn.recovery.requested'))
          AND (wake.session_id IS NULL OR (wake.wake_revision = wake.delivered_revision
            AND wake.updated_at < now() - interval '10 minutes'))
          AND (p_after_workspace_id IS NULL OR
            (session.workspace_id, session.id) > (p_after_workspace_id, p_after_session_id))
        ORDER BY session.workspace_id, session.id LIMIT p_limit;
    END $body$;
  $definition$, target_schema);
  SELECT pg_get_userbyid(proowner) INTO STRICT dispatcher_owner FROM pg_proc
    WHERE oid = 'opengeni_private.claim_session_workflow_wakes(integer)'::regprocedure;
  EXECUTE format('ALTER FUNCTION opengeni_private.list_quiescence_receipt_wake_repairs_v1(integer, uuid, uuid) OWNER TO %I', dispatcher_owner);
  REVOKE ALL ON FUNCTION opengeni_private.list_quiescence_receipt_wake_repairs_v1(integer, uuid, uuid) FROM PUBLIC;
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname <> current_user
    AND has_function_privilege(oid, 'opengeni_private.claim_session_workflow_wakes(integer)', 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.list_quiescence_receipt_wake_repairs_v1(integer, uuid, uuid) TO %I', role_name);
  END LOOP;
END $install$;

-- OPENGENI_INTERRUPTED_TURN_RETIREMENT_STAGE

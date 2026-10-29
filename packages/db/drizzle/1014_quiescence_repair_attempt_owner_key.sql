-- deployment-mode: rolling
-- The workspace/account foreign keys already require this equality. Exposing
-- it lets latest-attempt lookup use the existing ownership index rather than
-- reading every historical attempt of the session. No index or data rewrite.
-- CREATE OR REPLACE preserves the inventory's owner, grants and signature;
-- old binaries keep the same recovery eligibility and cursor behavior.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.list_quiescence_receipt_wake_repairs_v1(p_limit integer, p_after_workspace_id uuid, p_after_session_id uuid) RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $body$
    #variable_conflict use_column
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid quiescence repair batch'; END IF;
      IF (p_after_workspace_id IS NULL) <> (p_after_session_id IS NULL) THEN
        RAISE EXCEPTION 'incomplete quiescence repair cursor';
      END IF;
      RETURN QUERY
        WITH candidate AS MATERIALIZED (
          SELECT session.account_id AS candidate_account_id,
            session.workspace_id AS candidate_workspace_id,
            session.id AS candidate_session_id,
            session.status = 'recovering' AS projection_recovering,
            session.admission_block IS NOT NULL AS admission_blocked,
            attempt.quiesced_at IS NOT NULL AS quiesced,
            (
              (turn.metadata -> 'sandboxSetupOutcomeUnknown') @> jsonb_build_object(
                'version', 1, 'reason', 'sandbox_command_start_outcome_unknown')
              AND jsonb_typeof(turn.metadata -> 'sandboxSetupOutcomeUnknown' -> 'turnId') = 'string'
              AND turn.metadata -> 'sandboxSetupOutcomeUnknown' ->> 'turnId' <> ''
              AND jsonb_typeof(turn.metadata -> 'sandboxSetupOutcomeUnknown' -> 'attemptId') = 'string'
              AND turn.metadata -> 'sandboxSetupOutcomeUnknown' ->> 'attemptId' <> ''
            ) IS TRUE OR (
              (turn.metadata -> 'sandboxSetupRecoveryExhausted') @> jsonb_build_object(
                'version', 1, 'reason', 'sandbox_command_start_recovery_exhausted',
                'setupOutcome', 'not_started', 'providerRecoveryCount', 5)
              AND jsonb_typeof(turn.metadata -> 'sandboxSetupRecoveryExhausted' -> 'turnId') = 'string'
              AND turn.metadata -> 'sandboxSetupRecoveryExhausted' ->> 'turnId' <> ''
              AND jsonb_typeof(turn.metadata -> 'sandboxSetupRecoveryExhausted' -> 'attemptId') = 'string'
              AND turn.metadata -> 'sandboxSetupRecoveryExhausted' ->> 'attemptId' <> ''
            ) IS TRUE AS setup_blocked
          FROM %1$I.sessions session
          JOIN %1$I.session_turns turn ON turn.workspace_id = session.workspace_id
            AND turn.session_id = session.id AND turn.id = session.active_turn_id
          JOIN LATERAL (
            SELECT latest.id, latest.state, latest.outcome, latest.quiesced_at,
              coalesce(latest.closed_at, latest.updated_at) AS closed_at
            FROM %1$I.session_turn_attempts latest
            WHERE latest.account_id = session.account_id AND latest.workspace_id = turn.workspace_id AND latest.session_id = turn.session_id
              AND latest.turn_id = turn.id
            ORDER BY latest.execution_generation DESC, latest.updated_at DESC, latest.id DESC LIMIT 1
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
        )
        SELECT candidate.candidate_account_id, candidate.candidate_workspace_id,
          candidate.candidate_session_id
        FROM candidate
        CROSS JOIN LATERAL (
          -- Each quiesced candidate walks only its own ancestry through the
          -- primary key. The bound and cycle guard match the canonical
          -- effective-control algebra (packages/db/src/session-control.ts)
          -- and 0633's backlog.
          WITH RECURSIVE ancestry AS (
            SELECT path_row.workspace_id AS ancestry_workspace_id,
              path_row.parent_session_id AS ancestry_parent_id,
              path_row.direct_control_state AS ancestry_direct_state,
              path_row.direct_pause_revision AS ancestry_pause_revision,
              path_row.subtree_run_override_revision AS ancestry_override_revision,
              0::integer AS ancestry_depth,
              ARRAY[path_row.id]::uuid[] AS ancestry_path,
              false AS ancestry_cycle
            FROM %1$I.sessions path_row
            WHERE candidate.quiesced AND path_row.workspace_id = candidate.candidate_workspace_id
              AND path_row.id = candidate.candidate_session_id
            UNION ALL
            SELECT parent.workspace_id, parent.parent_session_id,
              parent.direct_control_state, parent.direct_pause_revision,
              parent.subtree_run_override_revision, child.ancestry_depth + 1,
              child.ancestry_path || parent.id, parent.id = ANY(child.ancestry_path)
            FROM ancestry child
            JOIN %1$I.sessions parent ON parent.workspace_id = child.ancestry_workspace_id
              AND parent.id = child.ancestry_parent_id
            WHERE child.ancestry_parent_id IS NOT NULL AND NOT child.ancestry_cycle
              AND child.ancestry_depth < 10000
          )
          SELECT (
            -- A session pause is defeated only by a strictly newer override
            -- on a strictly deeper (descendant-side) path row.
            EXISTS (
              SELECT 1 FROM ancestry pause
              WHERE NOT pause.ancestry_cycle
                AND pause.ancestry_direct_state = 'paused'
                AND pause.ancestry_pause_revision IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM ancestry override_row
                  WHERE override_row.ancestry_depth < pause.ancestry_depth
                    AND override_row.ancestry_override_revision > pause.ancestry_pause_revision))
            -- A workspace pause is defeated by any newer override on the path.
            OR candidate.quiesced AND EXISTS (
              SELECT 1 FROM %1$I.workspace_inference_controls control_row
              WHERE control_row.workspace_id = candidate.candidate_workspace_id
                AND control_row.workspace_state = 'paused'
                AND NOT EXISTS (
                  SELECT 1 FROM ancestry override_row
                  WHERE control_row.workspace_pause_revision IS NOT NULL
                    AND override_row.ancestry_override_revision > control_row.workspace_pause_revision))
          ) AS effectively_paused
        ) control
        WHERE NOT candidate.quiesced
          OR (control.effectively_paused AND candidate.projection_recovering)
          OR (NOT control.effectively_paused AND NOT candidate.admission_blocked
            AND NOT candidate.setup_blocked)
        ORDER BY candidate.candidate_workspace_id, candidate.candidate_session_id LIMIT p_limit;
    END $body$;
  $create$, data_schema);
END $install$;

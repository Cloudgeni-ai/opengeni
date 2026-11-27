-- deployment-mode: rolling
-- 1677 made the two wake repair inventories open the dispatcher's 'wakes'
-- maintenance claim on every call, so even production's owner, which
-- bypasses row security and never needs the claim, wrote and deleted a
-- claim row and assigned a transaction id on every poll, empty or not.
--
-- Each inventory now opens the claim only when row security applies to its
-- owner on a table it reads (row_security_active, a catalog check that
-- writes nothing). Every such table is FORCE ROW LEVEL SECURITY and owned by
-- the routine's owner, so the check is true under an owner without
-- BYPASSRLS, which keeps 1677's behaviour, and false under production's
-- owner, which again writes no claim row and assigns no transaction id.
-- Queries and results are otherwise unchanged.
--
-- Rolling: the previous release calls the same signatures and gets the same
-- rows. CREATE OR REPLACE keeps the owner, ACL and signature; the SET clauses
-- restate 1677's. CREATE OR REPLACE FUNCTION takes no table lock; each
-- attempt still waits at most 300 ms for any lock and a busy catalog is
-- retried after a short random pause.
DO $migration$
DECLARE
  data_schema constant text := current_schema();
  attempt integer;
BEGIN
  FOR attempt IN 1..30 LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '300ms', true);

      EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.list_pending_child_terminal_wake_repairs_v1(p_limit integer, p_after_workspace_id uuid, p_after_session_id uuid) RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    SET plan_cache_mode TO 'force_generic_plan'
    SET join_collapse_limit TO '1'
    AS $body$
    DECLARE capability_id uuid := gen_random_uuid();
      claim_needed constant boolean :=
        row_security_active('%1$I.session_system_updates'::regclass)
        OR row_security_active('%1$I.sessions'::regclass)
        OR row_security_active('%1$I.session_system_update_outbox'::regclass)
        OR row_security_active('%1$I.session_workflow_wake_outbox'::regclass)
        OR row_security_active('%1$I.session_goals'::regclass);
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid child repair batch'; END IF;
      IF (p_after_workspace_id IS NULL) <> (p_after_session_id IS NULL) THEN
        RAISE EXCEPTION 'incomplete child repair cursor';
      END IF;
      IF claim_needed THEN
        INSERT INTO opengeni_private.maintenance_claim_capabilities VALUES
          (capability_id, pg_backend_pid(), pg_current_xact_id(), 'wakes');
      END IF;
      RETURN QUERY
        SELECT DISTINCT input.account_id, input.workspace_id, input.session_id
        FROM %1$I.session_system_updates input
        JOIN %1$I.sessions parent ON parent.account_id = input.account_id
          AND parent.workspace_id = input.workspace_id AND parent.id = input.session_id
        JOIN %1$I.session_system_update_outbox producer
          ON producer.account_id = input.account_id AND producer.workspace_id = input.workspace_id
          AND producer.target_session_id = input.session_id AND producer.dedupe_key = input.dedupe_key
          AND producer.source_id = input.source_id AND producer.kind = 'child_terminal_result'
          AND producer.status = 'delivered'
        JOIN %1$I.sessions child ON child.account_id = input.account_id
          AND child.workspace_id = input.workspace_id AND child.id = producer.source_session_id
          AND child.parent_session_id = input.session_id AND child.id::text = input.source_id
        LEFT JOIN %1$I.session_workflow_wake_outbox wake
          ON wake.account_id = input.account_id AND wake.workspace_id = input.workspace_id
          AND wake.session_id = input.session_id
        WHERE input.state = 'pending' AND input.kind = 'child_terminal_result'
          AND input.payload ->> 'childSessionId' = input.source_id
          AND parent.status = 'idle' AND parent.active_turn_id IS NULL AND parent.admission_block IS NULL
          AND NOT EXISTS (SELECT 1 FROM %1$I.session_goals goal
            WHERE goal.workspace_id = input.workspace_id AND goal.session_id = input.session_id)
          AND (wake.session_id IS NULL OR wake.wake_revision = wake.delivered_revision)
          AND (p_after_workspace_id IS NULL OR
            (input.workspace_id, input.session_id) > (p_after_workspace_id, p_after_session_id))
        ORDER BY input.workspace_id, input.session_id, input.account_id LIMIT p_limit;
      IF claim_needed THEN
        DELETE FROM opengeni_private.maintenance_claim_capabilities claim WHERE claim.id = capability_id;
      END IF;
    END $body$;
      $create$, data_schema);

      EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.list_quiescence_receipt_wake_repairs_v1(p_limit integer, p_after_workspace_id uuid, p_after_session_id uuid) RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    SET plan_cache_mode TO 'force_generic_plan'
    AS $body$
    #variable_conflict use_column
    DECLARE capability_id uuid := gen_random_uuid();
      claim_needed constant boolean :=
        row_security_active('%1$I.sessions'::regclass)
        OR row_security_active('%1$I.session_turns'::regclass)
        OR row_security_active('%1$I.session_turn_attempts'::regclass)
        OR row_security_active('%1$I.session_workflow_wake_outbox'::regclass)
        OR row_security_active('%1$I.session_attempt_interruptions'::regclass)
        OR row_security_active('%1$I.session_events'::regclass)
        OR row_security_active('%1$I.workspace_inference_controls'::regclass);
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid quiescence repair batch'; END IF;
      IF (p_after_workspace_id IS NULL) <> (p_after_session_id IS NULL) THEN
        RAISE EXCEPTION 'incomplete quiescence repair cursor';
      END IF;
      IF claim_needed THEN
        INSERT INTO opengeni_private.maintenance_claim_capabilities VALUES
          (capability_id, pg_backend_pid(), pg_current_xact_id(), 'wakes');
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
              AND wake.updated_at < now() - interval '2 minutes'))
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
      IF claim_needed THEN
        DELETE FROM opengeni_private.maintenance_claim_capabilities claim WHERE claim.id = capability_id;
      END IF;
    END $body$;
      $create$, data_schema);
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      -- Nothing is held after the rollback to this block; wait and retry.
      IF attempt = 30 THEN RAISE; END IF;
      PERFORM pg_catalog.pg_sleep(pg_catalog.random() * least(0.05 * attempt, 0.4));
    END;
  END LOOP;
END
$migration$;

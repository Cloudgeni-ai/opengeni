-- deployment-mode: rolling
-- Keep the dispatcher ABI/ACL and archive guard unchanged. Claiming a wake
-- must not take its outbox lock before the guard's session lock: canonical
-- turn settlement already owns the session when it enqueues the next wake.
SET lock_timeout = '5s';
SET statement_timeout = '10min';

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_session_workflow_wakes(p_limit integer)
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
    DECLARE
      candidate record;
      claimed_ids uuid[] := ARRAY[]::uuid[];
      claim_limit integer := greatest(1, least(coalesce(p_limit, 100), 1000));
    BEGIN
      -- This is an UNLOCKED preview, not a lease. Traverse the explicit due
      -- ledger in workspace/session UUID order, matching multi-session writers.
      -- Do not LIMIT the preview: busy earlier candidates must not hide later
      -- free wakes. Only actual lockable leases count against p_limit.
      FOR candidate IN
        SELECT o.account_id, o.workspace_id, o.session_id
        FROM %1$I.session_workflow_wake_outbox o
        WHERE o.wake_revision > o.delivered_revision AND o.next_attempt_at <= now()
        ORDER BY o.workspace_id, o.session_id
      LOOP
        -- Nonblocking admission fences precede all rows, as in withRlsContext
        -- and lockSessionEventWriteRows. Never queue while retaining other
        -- tenants' row locks. A later dispatcher pass retries skipped work.
        IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(
          'session-tenancy:' || candidate.workspace_id::text, 0
        )) THEN CONTINUE; END IF;
        IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(
          'workspace-control:' || candidate.workspace_id::text, 0
        )) THEN CONTINUE; END IF;

        PERFORM 1 FROM %1$I.workspace_inference_controls control
        WHERE control.workspace_id = candidate.workspace_id
          AND control.account_id = candidate.account_id
        FOR SHARE SKIP LOCKED;
        IF NOT FOUND THEN CONTINUE; END IF;

        PERFORM 1 FROM %1$I.workspaces workspace
        WHERE workspace.id = candidate.workspace_id
          AND workspace.account_id = candidate.account_id
        FOR KEY SHARE SKIP LOCKED;
        IF NOT FOUND THEN CONTINUE; END IF;

        PERFORM 1 FROM %1$I.sessions session
        WHERE session.id = candidate.session_id
          AND session.workspace_id = candidate.workspace_id
          AND session.account_id = candidate.account_id
        FOR NO KEY UPDATE SKIP LOCKED;
        IF NOT FOUND THEN CONTINUE; END IF;

        -- Recheck eligibility after the session prefix. Lock the CURRENT row,
        -- never the revision/timestamp observed by the unlocked preview.
        PERFORM 1 FROM %1$I.session_workflow_wake_outbox o
        WHERE o.session_id = candidate.session_id
          AND o.workspace_id = candidate.workspace_id
          AND o.account_id = candidate.account_id
          AND o.wake_revision > o.delivered_revision AND o.next_attempt_at <= now()
        FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN CONTINUE; END IF;
        claimed_ids := array_append(claimed_ids, candidate.session_id);
        EXIT WHEN cardinality(claimed_ids) >= claim_limit;
      END LOOP;

      -- Every selected session is already held before ANY wake mutation.
      -- 0560's guard/FK checks now reacquire only locks this transaction owns.
      RETURN QUERY
        UPDATE %1$I.session_workflow_wake_outbox o
        SET attempts = o.attempts + 1,
            next_attempt_at = now() + make_interval(
              secs => least(300, greatest(1, power(2, least(o.attempts, 8))::integer))
            ),
            updated_at = now()
        WHERE o.session_id = ANY(claimed_ids)
          AND o.wake_revision > o.delivered_revision AND o.next_attempt_at <= now()
        RETURNING o.account_id, o.workspace_id, o.session_id,
          o.temporal_workflow_id, o.wake_revision,
          o.control_revision > o.delivered_revision
          OR EXISTS (
            SELECT 1 FROM %1$I.session_attempt_interruptions interruption
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

-- CREATE OR REPLACE preserves the existing app EXECUTE grant and owner.
REVOKE ALL ON FUNCTION opengeni_private.claim_session_workflow_wakes(integer) FROM PUBLIC;
RESET statement_timeout;
RESET lock_timeout;
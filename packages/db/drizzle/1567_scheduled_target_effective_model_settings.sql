-- deployment-mode: rolling
-- Keep the admission fence aligned with getScheduledTargetSessionExecution:
-- compare the effective model settings, not the last turn's execution settings.
-- Both old and new workers already submit that effective policy. Only replace
-- the routine body; keep its signature, owner, privileges and session row lock.
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.admit_scheduled_agent_run_execution()',
    pg_catalog.current_schema())::regprocedure);
  declaration_anchor constant text := 'latest_started record;';
  policy_anchor constant text := $old$        IF target_snapshot ->> 'sessionId' IS DISTINCT FROM target_row.id::text
          OR NOT ((target_snapshot ->> 'authorityEpoch')::integer BETWEEN target_row.execution_authority_epoch AND target_row.authority_epoch)
          OR target_snapshot ->> 'model'
            IS DISTINCT FROM coalesce(latest_started.model, target_row.model)
          OR target_snapshot ->> 'reasoningEffort' IS DISTINCT FROM coalesce(
            latest_started.reasoning_effort,
            CASE WHEN target_row.metadata ->> 'reasoningEffort' IN (
              'none','minimal','low','medium','high','xhigh','max'
            )
              THEN target_row.metadata ->> 'reasoningEffort' ELSE 'medium' END
          )
          OR target_snapshot ->> 'latencyMode' IS DISTINCT FROM coalesce(
            latest_started.latency_mode,
            CASE WHEN target_row.metadata ->> 'latencyMode' IN ('standard','priority','fast','ultrafast')
              THEN target_row.metadata ->> 'latencyMode' ELSE 'standard' END
          )$old$;
  policy_replacement constant text := $new$        -- Match startedSessionTurnQuery(..., true) in session-execution-policy.ts.
        -- A turn queued before the settings command cannot override it just by
        -- starting later; after an explicit write only later user/API turns can.
        -- The locked session row and settings event are written in one commit.
        SELECT coalesce(max(boundary.sequence), -1) INTO settings_boundary
        FROM session_events boundary
        WHERE boundary.workspace_id = NEW.workspace_id
          AND boundary.session_id = expected_target_session_id
          AND boundary.type = 'session.model_settings.updated';

        SELECT candidate.model, candidate.reasoning_effort, candidate.latency_mode
        INTO effective_started
        FROM session_turns candidate
        WHERE candidate.workspace_id = NEW.workspace_id
          AND candidate.session_id = expected_target_session_id
          AND candidate.id = (
            SELECT started.turn_id
            FROM session_events started
            WHERE started.workspace_id = NEW.workspace_id
              AND started.session_id = expected_target_session_id
              AND started.type = 'turn.started'
              AND started.sequence > settings_boundary
              AND (
                SELECT true FROM session_turns eligible
                WHERE eligible.workspace_id = started.workspace_id
                  AND eligible.session_id = started.session_id
                  AND eligible.id = started.turn_id
                  AND coalesce(CASE WHEN eligible.source IN ('user', 'api') THEN (
                    SELECT min(accepted.sequence) FROM session_events accepted
                    WHERE accepted.workspace_id = started.workspace_id
                      AND accepted.session_id = started.session_id
                      AND accepted.turn_id = eligible.id
                      AND accepted.type = 'turn.queued'
                  ) END, 0) > settings_boundary
              )
            ORDER BY started.sequence DESC
            LIMIT 1
          );
        IF target_snapshot ->> 'sessionId' IS DISTINCT FROM target_row.id::text
          OR NOT ((target_snapshot ->> 'authorityEpoch')::integer BETWEEN target_row.execution_authority_epoch AND target_row.authority_epoch)
          OR target_snapshot ->> 'model'
            IS DISTINCT FROM coalesce(effective_started.model, target_row.model)
          OR target_snapshot ->> 'reasoningEffort'
            IS DISTINCT FROM coalesce(effective_started.reasoning_effort, target_row.reasoning_effort)
          OR target_snapshot ->> 'latencyMode'
            IS DISTINCT FROM coalesce(effective_started.latency_mode, target_row.latency_mode)$new$;
  anchor text;
BEGIN
  FOREACH anchor IN ARRAY ARRAY[declaration_anchor, policy_anchor] LOOP
    IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
      RAISE EXCEPTION 'scheduled target effective model settings migration: admission definition drift'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  definition := replace(definition, declaration_anchor, $new$latest_started record;
      settings_boundary integer;
      effective_started record;$new$);
  EXECUTE replace(definition, policy_anchor, policy_replacement);
END
$migration$;

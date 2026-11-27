-- deployment-mode: rolling
-- Scheduled admission into an existing session read the target's effective
-- and latest started turns with joins that a long scheduled chat turns into
-- a scan of every turn for every start: one production chat (8,286 starts
-- since its last settings write, 1,206 turns) read 10.2M buffers and 3.5 s
-- per admission, every 10 minutes. Pick the same turns the way
-- startedSessionTurnQuery in session-execution-policy.ts already does: the
-- newest few starts after the write, each turn probed by id, then the
-- session's person/API turns or the remaining starts. A turn's session is
-- compared with IS NOT DISTINCT FROM, which is never an index operator, so a
-- generic plan cannot probe each turn through (workspace, session). The
-- target session id is never null here, so both comparisons agree.
-- Only the routine body changes; old and new workers submit the same
-- snapshots, and the signature, owner, privileges and row locks stay.
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  definition text;
  declaration_anchor constant text := $old$      effective_started record;
$old$;
  latest_anchor constant text := $old$        SELECT turn_value.* INTO latest_started
        FROM session_events event_value
        JOIN session_turns turn_value
          ON turn_value.workspace_id = event_value.workspace_id
         AND turn_value.session_id = event_value.session_id
         AND turn_value.id = event_value.turn_id
        WHERE event_value.workspace_id = NEW.workspace_id
          AND event_value.session_id = expected_target_session_id
          AND event_value.type = 'turn.started'
        ORDER BY event_value.sequence DESC
        LIMIT 1;
$old$;
  effective_anchor constant text := $old$        SELECT candidate.model, candidate.reasoning_effort, candidate.latency_mode
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
$old$;
  anchor text;
BEGIN
  definition := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.admit_scheduled_agent_run_execution()',
    pg_catalog.current_schema())::regprocedure);
  FOREACH anchor IN ARRAY ARRAY[declaration_anchor, latest_anchor, effective_anchor] LOOP
    IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
      RAISE EXCEPTION 'scheduled target admission turn reads migration: admission definition drift'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  definition := replace(definition, declaration_anchor, $new$      effective_started record;
      effective_turn_id uuid;
$new$);
  -- The newest start whose turn exists, as the join chose it.
  definition := replace(definition, latest_anchor, $new$        SELECT turn_value.* INTO latest_started
        FROM session_turns turn_value
        WHERE turn_value.workspace_id = NEW.workspace_id
          AND turn_value.id = (
            SELECT started.turn_id
            FROM session_events started
            WHERE started.workspace_id = NEW.workspace_id
              AND started.session_id = expected_target_session_id
              AND started.type = 'turn.started'
              AND (
                SELECT true FROM session_turns candidate
                WHERE candidate.workspace_id = NEW.workspace_id
                  AND candidate.id = started.turn_id
                  AND candidate.session_id IS NOT DISTINCT FROM expected_target_session_id
                LIMIT 1
              )
            ORDER BY started.sequence DESC
            LIMIT 1
          )
          AND turn_value.session_id IS NOT DISTINCT FROM expected_target_session_id;
$new$);
  -- The newest start after the write whose turn is eligible. Without a write
  -- every existing turn is eligible and the first walk is unlimited. After a
  -- write only person/API turns queued after it are; when the newest 16 starts
  -- hold none, the same turn comes from those turns (at most 200 of them) or
  -- from the remaining starts.
  definition := replace(definition, effective_anchor, $new$        SELECT recent.turn_id INTO effective_turn_id
        FROM (
          SELECT started.turn_id, started.sequence
          FROM session_events started
          WHERE started.workspace_id = NEW.workspace_id
            AND started.session_id = expected_target_session_id
            AND started.type = 'turn.started'
            AND started.sequence > settings_boundary
          ORDER BY started.sequence DESC
          LIMIT CASE WHEN settings_boundary >= 0 THEN 16 END
        ) recent
        WHERE (
          SELECT true FROM session_turns eligible
          WHERE eligible.workspace_id = NEW.workspace_id
            AND eligible.id = recent.turn_id
            AND eligible.session_id IS NOT DISTINCT FROM expected_target_session_id
            AND coalesce(CASE WHEN eligible.source IN ('user', 'api') THEN (
              SELECT min(accepted.sequence + 0) FROM session_events accepted
              WHERE accepted.workspace_id = NEW.workspace_id
                AND accepted.turn_id = eligible.id
                AND accepted.type = 'turn.queued'
                AND accepted.session_id IS NOT DISTINCT FROM expected_target_session_id
            ) END, 0) > settings_boundary
          LIMIT 1
        )
        ORDER BY recent.sequence DESC
        LIMIT 1;
        IF effective_turn_id IS NULL AND settings_boundary >= 0 AND EXISTS (
          SELECT 1 FROM session_events started
          WHERE started.workspace_id = NEW.workspace_id
            AND started.session_id = expected_target_session_id
            AND started.type = 'turn.started'
            AND started.sequence > settings_boundary
          OFFSET 16
        ) THEN
          IF (
            SELECT count(*) FROM (
              SELECT 1 FROM session_turns person
              WHERE person.workspace_id = NEW.workspace_id
                AND person.session_id = expected_target_session_id
                AND person.source IN ('user', 'api')
              LIMIT 201
            ) counted
          ) <= 200 THEN
            SELECT person.id INTO effective_turn_id
            FROM session_turns person
            CROSS JOIN LATERAL (
              SELECT
                max(own.sequence + 0) FILTER (WHERE own.type = 'turn.started') AS started,
                min(own.sequence + 0) FILTER (WHERE own.type = 'turn.queued') AS queued
              FROM session_events own
              WHERE own.workspace_id = NEW.workspace_id
                AND own.turn_id = person.id
                AND own.type IN ('turn.started', 'turn.queued')
                AND own.session_id IS NOT DISTINCT FROM expected_target_session_id
            ) own_events
            WHERE person.workspace_id = NEW.workspace_id
              AND person.session_id = expected_target_session_id
              AND person.source IN ('user', 'api')
              AND own_events.started > settings_boundary
              AND coalesce(own_events.queued, 0) > settings_boundary
            ORDER BY own_events.started DESC
            LIMIT 1;
          ELSE
            SELECT recent.turn_id INTO effective_turn_id
            FROM (
              SELECT started.turn_id, started.sequence
              FROM session_events started
              WHERE started.workspace_id = NEW.workspace_id
                AND started.session_id = expected_target_session_id
                AND started.type = 'turn.started'
                AND started.sequence > settings_boundary
              ORDER BY started.sequence DESC
            ) recent
            WHERE (
              SELECT true FROM session_turns eligible
              WHERE eligible.workspace_id = NEW.workspace_id
                AND eligible.id = recent.turn_id
                AND eligible.session_id IS NOT DISTINCT FROM expected_target_session_id
                AND coalesce(CASE WHEN eligible.source IN ('user', 'api') THEN (
                  SELECT min(accepted.sequence + 0) FROM session_events accepted
                  WHERE accepted.workspace_id = NEW.workspace_id
                    AND accepted.turn_id = eligible.id
                    AND accepted.type = 'turn.queued'
                    AND accepted.session_id IS NOT DISTINCT FROM expected_target_session_id
                ) END, 0) > settings_boundary
              LIMIT 1
            )
            ORDER BY recent.sequence DESC
            LIMIT 1;
          END IF;
        END IF;
        SELECT candidate.model, candidate.reasoning_effort, candidate.latency_mode
        INTO effective_started
        FROM session_turns candidate
        WHERE candidate.workspace_id = NEW.workspace_id
          AND candidate.id = effective_turn_id
          AND candidate.session_id IS NOT DISTINCT FROM expected_target_session_id;
$new$);
  EXECUTE definition;
END
$migration$;

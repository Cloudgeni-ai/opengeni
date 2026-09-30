-- deployment-mode: rolling
-- Preserve execution-context validation, invoker authority, and soft references.
-- CREATE OR REPLACE retains the existing function owner and revoked ACLs.

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.validate_usage_event_execution_context()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      -- Usage is an immutable billing/audit fact. Validate newly supplied
      -- execution identity under row locks, but keep those UUIDs as soft
      -- references after the source session or turn is deleted. An unchanged
      -- idempotent retry after deletion must also remain valid.
      IF TG_OP = 'INSERT'
        OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
        OR NEW.session_id IS DISTINCT FROM OLD.session_id
        OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
        OR NEW.turn_attempt_id IS DISTINCT FROM OLD.turn_attempt_id THEN
        -- Match lifecycle writers: workspace before session, turn, and attempt.
        -- The workspace FK runs AFTER this BEFORE trigger. Leaving it until
        -- then inverts the lock order and can deadlock a completed model call.
        PERFORM 1 FROM %1$I.workspaces w
        WHERE w.id = NEW.workspace_id AND w.account_id = NEW.account_id
        FOR KEY SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'usage event workspace does not belong to its account'
            USING ERRCODE = '23503';
        END IF;
        IF NEW.session_id IS NOT NULL THEN
          PERFORM 1 FROM %1$I.sessions s
          WHERE s.workspace_id = NEW.workspace_id AND s.id = NEW.session_id
          FOR KEY SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'usage event session does not exist in its workspace'
              USING ERRCODE = '23514';
          END IF;
        END IF;
        IF NEW.turn_id IS NOT NULL THEN
          PERFORM 1 FROM %1$I.session_turns t
          WHERE t.workspace_id = NEW.workspace_id
            AND t.session_id = NEW.session_id
            AND t.id = NEW.turn_id
          FOR KEY SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'usage event turn does not belong to its session'
              USING ERRCODE = '23514';
          END IF;
        END IF;
        IF NEW.turn_attempt_id IS NOT NULL THEN
          PERFORM 1 FROM %1$I.session_turn_attempts a
          WHERE a.workspace_id = NEW.workspace_id
            AND a.session_id = NEW.session_id
            AND a.turn_id = NEW.turn_id
            AND a.id = NEW.turn_attempt_id
          FOR KEY SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'usage event attempt does not belong to its turn'
              USING ERRCODE = '23514';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $function$;
  $create$, target_schema);
END $migration$;


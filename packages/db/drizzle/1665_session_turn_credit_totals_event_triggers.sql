-- deployment-mode: rolling
-- Step 3 of the per-turn credit totals (1663): the session_events triggers.
-- session_events is the only table this step locks (CREATE TRIGGER takes
-- SHARE ROW EXCLUSIVE on it), with a short lock timeout retried with jitter,
-- so it never waits while holding another busy table. No turn's rows are
-- ready until 1667, so every terminal event still takes the full sum.
-- The BEFORE INSERT trigger's name sorts after session_events_fill_* and
-- session_events_normalize_legacy_*, so the row's sequence and payload are
-- final when it runs. Rerunning replaces the same triggers.
DO $session_turn_credit_totals_event_triggers$
DECLARE previous_lock_timeout constant text := pg_catalog.current_setting('lock_timeout');
BEGIN
  FOR attempt IN 1..30 LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '300ms', true);
      CREATE OR REPLACE TRIGGER session_events_turn_credit_totals_v1 BEFORE INSERT ON session_events
        FOR EACH ROW WHEN (NEW.turn_id IS NOT NULL
          AND NEW.type IN ('agent.model.usage', 'turn.event.rejected_late'))
        EXECUTE FUNCTION opengeni_private.session_turn_credit_record_event();
      CREATE OR REPLACE TRIGGER session_events_turn_credit_totals_inexact_v1 AFTER UPDATE ON session_events
        FOR EACH ROW WHEN ((OLD.turn_id IS NOT NULL OR NEW.turn_id IS NOT NULL)
          AND (OLD.type IN ('agent.model.usage', 'turn.event.rejected_late')
            OR NEW.type IN ('agent.model.usage', 'turn.event.rejected_late'))
          AND (OLD.type, OLD.payload, OLD.turn_id, OLD.session_id, OLD.workspace_id, OLD.sequence, OLD.turn_association)
            IS DISTINCT FROM (NEW.type, NEW.payload, NEW.turn_id, NEW.session_id, NEW.workspace_id, NEW.sequence, NEW.turn_association))
        EXECUTE FUNCTION opengeni_private.session_turn_credit_mark_inexact();
      CREATE OR REPLACE TRIGGER session_events_turn_credit_totals_delete_v1 AFTER DELETE ON session_events
        FOR EACH ROW WHEN (OLD.turn_id IS NOT NULL
          AND OLD.type IN ('agent.model.usage', 'turn.event.rejected_late'))
        EXECUTE FUNCTION opengeni_private.session_turn_credit_mark_inexact();
      CREATE OR REPLACE TRIGGER session_events_turn_credit_totals_truncate_v1 AFTER TRUNCATE ON session_events
        FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.clear_session_turn_credit_totals();
      PERFORM pg_catalog.set_config('lock_timeout', previous_lock_timeout, true);
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_catalog.pg_sleep(0.05 + pg_catalog.random() * 0.25);
    END;
  END LOOP;
  RAISE EXCEPTION 'session turn credit totals: session_events stayed busy' USING ERRCODE = 'lock_not_available';
END $session_turn_credit_totals_event_triggers$;

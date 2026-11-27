-- deployment-mode: rolling
-- Step 2 of the per-turn credit totals (1663): the usage_events triggers.
-- usage_events is the only table this step locks (CREATE TRIGGER takes SHARE
-- ROW EXCLUSIVE on it), with a short lock timeout retried with jitter, so it
-- never waits while holding another busy table. No turn's rows are ready
-- until 1667, so rows these triggers create meanwhile are only kept for the
-- 1668 recount and every terminal event still takes the full sum. Rerunning
-- replaces the same triggers.
DO $session_turn_credit_totals_usage_triggers$
DECLARE previous_lock_timeout constant text := pg_catalog.current_setting('lock_timeout');
BEGIN
  FOR attempt IN 1..30 LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '300ms', true);
      CREATE OR REPLACE TRIGGER usage_events_turn_credit_totals_v1 AFTER INSERT ON usage_events
        FOR EACH ROW WHEN (NEW.turn_id IS NOT NULL AND NEW.unit = 'usd_micros'
          AND (NEW.event_type LIKE '%.cost' OR (NEW.event_type LIKE '%.refund' AND NEW.event_type <> 'model.refund')))
        EXECUTE FUNCTION opengeni_private.session_turn_credit_record_usage();
      CREATE OR REPLACE TRIGGER usage_events_turn_credit_totals_inexact_v1 AFTER UPDATE ON usage_events
        FOR EACH ROW WHEN ((OLD.turn_id IS NOT NULL OR NEW.turn_id IS NOT NULL)
          AND (OLD.turn_id, OLD.session_id, OLD.workspace_id, OLD.event_type, OLD.unit, OLD.quantity, OLD.source_resource_id)
            IS DISTINCT FROM (NEW.turn_id, NEW.session_id, NEW.workspace_id, NEW.event_type, NEW.unit, NEW.quantity, NEW.source_resource_id))
        EXECUTE FUNCTION opengeni_private.session_turn_credit_mark_inexact();
      CREATE OR REPLACE TRIGGER usage_events_turn_credit_totals_delete_v1 AFTER DELETE ON usage_events
        FOR EACH ROW WHEN (OLD.turn_id IS NOT NULL AND OLD.unit = 'usd_micros')
        EXECUTE FUNCTION opengeni_private.session_turn_credit_mark_inexact();
      CREATE OR REPLACE TRIGGER usage_events_turn_credit_totals_truncate_v1 AFTER TRUNCATE ON usage_events
        FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.clear_session_turn_credit_totals();
      PERFORM pg_catalog.set_config('lock_timeout', previous_lock_timeout, true);
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_catalog.pg_sleep(0.05 + pg_catalog.random() * 0.25);
    END;
  END LOOP;
  RAISE EXCEPTION 'session turn credit totals: usage_events stayed busy' USING ERRCODE = 'lock_not_available';
END $session_turn_credit_totals_usage_triggers$;

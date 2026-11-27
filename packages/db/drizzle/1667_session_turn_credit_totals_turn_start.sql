-- deployment-mode: rolling
-- Step 5 of the per-turn credit totals (1663), last: a turn created from now
-- on starts with ready rows (its records all come later, and 1664/1665 keep
-- them), so its terminal event reads the kept totals. Before this step no
-- turn's rows are ready. session_turns is the only table this step locks
-- (CREATE TRIGGER takes SHARE ROW EXCLUSIVE on it), with a short lock timeout
-- retried with jitter. Rerunning replaces the same trigger.
DO $session_turn_credit_totals_turn_start$
DECLARE previous_lock_timeout constant text := pg_catalog.current_setting('lock_timeout');
BEGIN
  FOR attempt IN 1..30 LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '300ms', true);
      CREATE OR REPLACE TRIGGER session_turns_credit_totals_start_v1 AFTER INSERT ON session_turns
        FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_turn_credit_start_turn();
      PERFORM pg_catalog.set_config('lock_timeout', previous_lock_timeout, true);
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_catalog.pg_sleep(0.05 + pg_catalog.random() * 0.25);
    END;
  END LOOP;
  RAISE EXCEPTION 'session turn credit totals: session_turns stayed busy' USING ERRCODE = 'lock_not_available';
END $session_turn_credit_totals_turn_start$;

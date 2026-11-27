-- deployment-mode: rolling
-- Step 4 of the per-turn credit totals (1663): deleting a session deletes its
-- turns' kept rows. sessions is the only table this step locks (CREATE
-- TRIGGER takes SHARE ROW EXCLUSIVE on it), with a short lock timeout
-- retried with jitter. A session deleted before this step leaves rows no
-- reader uses (their turn is gone). Rerunning replaces the same trigger.
DO $session_turn_credit_totals_session_cleanup$
DECLARE previous_lock_timeout constant text := pg_catalog.current_setting('lock_timeout');
BEGIN
  FOR attempt IN 1..30 LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '300ms', true);
      CREATE OR REPLACE TRIGGER sessions_turn_credit_totals_forget_v1 AFTER DELETE ON sessions
        FOR EACH ROW EXECUTE FUNCTION opengeni_private.forget_session_turn_credit_totals();
      PERFORM pg_catalog.set_config('lock_timeout', previous_lock_timeout, true);
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_catalog.pg_sleep(0.05 + pg_catalog.random() * 0.25);
    END;
  END LOOP;
  RAISE EXCEPTION 'session turn credit totals: sessions stayed busy' USING ERRCODE = 'lock_not_available';
END $session_turn_credit_totals_session_cleanup$;

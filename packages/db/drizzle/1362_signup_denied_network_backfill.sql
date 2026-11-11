-- deployment-mode: rolling
-- Denied network backfill (1361), in its own transaction so that 1361's
-- settings-table lock is released before it runs: the running binary reads
-- those settings at every Free admission and setup. Every capture is
-- per account and best-effort; the rule tolerates an incomplete backfill,
-- --network-holds reports the coverage and --network-capture-flagged runs
-- the capture again.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

-- Backfill: the owners of every account denied or held now (including those
-- decided before 1354), account by account, and the setups of the last
-- seven days, which can still be evaluated. A failure is reported as a
-- warning with counts; capture_all_flagged_owner_session_networks can be run
-- again by an operator.
DO $backfill$
DECLARE target_schema text := current_schema(); recent record; outcome jsonb;
BEGIN
  outcome := opengeni_private.capture_all_flagged_owner_session_networks(target_schema);
  IF (outcome->>'failed')::integer > 0 THEN
    RAISE WARNING 'denied network backfill incomplete: %', outcome;
  ELSE
    RAISE NOTICE 'denied network backfill: %', outcome;
  END IF;
  FOR recent IN SELECT s.account_id, s.owner_auth_user_id, s.set_up_at FROM opengeni_private.signup_network_sources s
    WHERE s.data_schema = target_schema AND s.set_up_at >= clock_timestamp() - interval '7 days'
    ORDER BY s.set_up_at DESC LIMIT 5000
  LOOP
    BEGIN
      INSERT INTO opengeni_private.signup_network_owner_setups(data_schema, account_id, set_up_at)
        VALUES (target_schema, recent.account_id, recent.set_up_at) ON CONFLICT (data_schema, account_id) DO NOTHING;
      PERFORM opengeni_private.record_signup_owner_session_networks(target_schema, recent.account_id,
        recent.owner_auth_user_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'recent owner session networks skipped (%)', SQLSTATE;
    END;
  END LOOP;
END $backfill$;

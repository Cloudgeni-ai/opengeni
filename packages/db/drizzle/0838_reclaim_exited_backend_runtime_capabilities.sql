-- deployment-mode: rolling
-- Runtime capability rows still leaked, one per database connection.
--
-- Each row is keyed by (backend_pid, transaction_id) and can only authorize
-- its own transaction. Since 0807 a grant first removes its backend's rows
-- from earlier transactions, so a live backend keeps at most its latest row.
-- The last row of a backend that disconnects was never removed, so the table
-- grew with connection churn (hundreds of rows an hour on a busy deployment),
-- and its heap and primary key still carried gigabytes of bloat from the leak
-- before 0807.
--
-- 1. Empty the table once. TRUNCATE needs ACCESS EXCLUSIVE, which is granted
--    only after every transaction that inserted or read a capability row has
--    ended, so every row it removes belongs to a finished transaction and can
--    never authorize anything again. It also releases the bloated heap and
--    index storage, which DELETE and VACUUM cannot shrink. A busy database
--    must not fail the deploy, and a queued ACCESS EXCLUSIVE request stalls
--    every new grant, so the lock is only tried briefly a few times. When it
--    stays unavailable, the finished rows are deleted instead without waiting
--    for any lock, and the bloat is left to a later VACUUM FULL.
-- 2. Every grant additionally removes a few rows of any backend whose
--    transaction ended before the oldest running transaction began
--    (transaction_id below the snapshot xmin). A running transaction's own
--    xid is never below xmin, and its uncommitted rows are invisible to
--    other backends, so live grants are untouched. The sweep walks the
--    primary key, where only the rows of running transactions precede the
--    finished ones, so it needs no extra index. Each grant removes up to
--    eight finished rows and each backend leaks at most one, so the sweep
--    keeps up with any rate of connection churn.
--
-- Rows can now be removed by a backend other than their owner, so both
-- deletes claim rows with SKIP LOCKED: a grant never waits for another
-- grant's transaction, and two grants never deadlock. Reclaiming runs only
-- under READ COMMITTED. Under REPEATABLE READ or SERIALIZABLE, deleting or
-- locking a row that another grant removed after the snapshot was taken
-- raises a serialization failure, so such a grant leaves finished rows to
-- the next READ COMMITTED grant. Writers that grant under REPEATABLE READ or
-- SERIALIZABLE therefore leave at most one finished row per backend, which
-- the stale sweep of later READ COMMITTED grants removes.
SET LOCAL lock_timeout = '5s';

DO $reclaim$
BEGIN
  FOR attempt IN 1..4 LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '200ms', true);
      LOCK TABLE opengeni_private.subscription_runtime_capabilities
        IN ACCESS EXCLUSIVE MODE;
      TRUNCATE opengeni_private.subscription_runtime_capabilities;
      PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      -- The failed attempt's lock request and setting are rolled back.
      IF attempt < 4 THEN
        PERFORM pg_catalog.pg_sleep(0.5);
      END IF;
    END;
  END LOOP;
  DELETE FROM opengeni_private.subscription_runtime_capabilities finished
  WHERE finished.ctid = ANY (ARRAY(
    SELECT stale.ctid
    FROM opengeni_private.subscription_runtime_capabilities stale
    WHERE stale.transaction_id
      < pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot())
    FOR UPDATE SKIP LOCKED
  ));
  RAISE NOTICE 'subscription_runtime_capabilities stayed busy; deleted finished rows instead of truncating';
END
$reclaim$;

CREATE OR REPLACE FUNCTION opengeni_private.reclaim_finished_subscription_runtime_capabilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RETURN NEW;
  END IF;
  -- This backend's rows from its earlier transactions.
  DELETE FROM opengeni_private.subscription_runtime_capabilities finished
  WHERE finished.ctid = ANY (ARRAY(
    SELECT own.ctid
    FROM opengeni_private.subscription_runtime_capabilities own
    WHERE own.backend_pid = NEW.backend_pid
      AND own.transaction_id < NEW.transaction_id
    FOR UPDATE SKIP LOCKED
  ));
  -- A few rows of any backend's ended transactions, including backends that
  -- have disconnected.
  DELETE FROM opengeni_private.subscription_runtime_capabilities finished
  WHERE finished.ctid = ANY (ARRAY(
    SELECT stale.ctid
    FROM opengeni_private.subscription_runtime_capabilities stale
    WHERE stale.transaction_id
      < pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot())
    ORDER BY stale.backend_pid, stale.transaction_id
    LIMIT 8
    FOR UPDATE SKIP LOCKED
  ));
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.reclaim_finished_subscription_runtime_capabilities() FROM PUBLIC;

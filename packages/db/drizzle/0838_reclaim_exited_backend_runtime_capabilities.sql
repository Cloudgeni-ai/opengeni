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
--    index storage, which DELETE and VACUUM cannot shrink. The lock is held for
--    the remaining few statements of this migration only.
-- 2. Index transaction_id, so finished rows can be found without a scan.
-- 3. Every grant additionally removes a few rows of any backend whose
--    transaction ended before the oldest running transaction began
--    (transaction_id below the snapshot xmin). A running transaction's own
--    xid is never below xmin, so live grants are untouched. Rows are claimed
--    with SKIP LOCKED, so concurrent grants never wait on each other. The
--    sweep runs only under READ COMMITTED: under REPEATABLE READ or
--    SERIALIZABLE, locking a row that another grant just removed would raise
--    a serialization failure in the caller's transaction. Each grant removes
--    up to eight finished rows and each backend leaks at most one, so the
--    sweep keeps up with any rate of connection churn.
SET LOCAL lock_timeout = '5s';

TRUNCATE opengeni_private.subscription_runtime_capabilities;

CREATE INDEX subscription_runtime_capabilities_transaction_idx
  ON opengeni_private.subscription_runtime_capabilities (transaction_id);

CREATE OR REPLACE FUNCTION opengeni_private.reclaim_finished_subscription_runtime_capabilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  DELETE FROM opengeni_private.subscription_runtime_capabilities finished
  WHERE finished.backend_pid = NEW.backend_pid
    AND finished.transaction_id < NEW.transaction_id;
  IF pg_catalog.current_setting('transaction_isolation') = 'read committed' THEN
    DELETE FROM opengeni_private.subscription_runtime_capabilities finished
    WHERE finished.ctid = ANY (ARRAY(
      SELECT stale.ctid
      FROM opengeni_private.subscription_runtime_capabilities stale
      WHERE stale.transaction_id
        < pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot())
      ORDER BY stale.transaction_id
      LIMIT 8
      FOR UPDATE SKIP LOCKED
    ));
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.reclaim_finished_subscription_runtime_capabilities() FROM PUBLIC;

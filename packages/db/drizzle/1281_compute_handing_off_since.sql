-- deployment-mode: rolling
-- The agent gateway records since when the host of a compute sandbox has
-- said it is handing the sandbox off to another host. A host refuses wakes
-- during the first moments of a hand-off, so the sandbox list shows it as
-- recovering and an agent that does not answer meanwhile is not restarted.
-- Null while no hand-off is reported (every existing row).
--
-- Rolling: one nullable column. The previous release never reads or
-- writes it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE sandbox_leases
  ADD COLUMN compute_handing_off_since timestamptz;

COMMENT ON COLUMN sandbox_leases.compute_handing_off_since IS
  'Compute leases only: when the current sandbox''s host began handing it off, as the agent gateway last reported; null while it reports none.';

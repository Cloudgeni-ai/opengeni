-- deployment-mode: rolling
-- When a Connected Machine began its current run of unsuccessful agent
-- updates: the first attempt after its last success. Each retry or
-- postponement records a new update operation, so the operation's own
-- request time restarts every time. This column keeps the start of the run,
-- so the automatic updater can back off retries of a failed download and
-- bound how long it postpones an update for open browsers.
--
-- Rolling: the column is nullable and additive. The previous release never
-- reads or writes it. The next attempt on a row the previous release wrote
-- starts its run at that row's failed attempt (agent_update_requested_at).
SET LOCAL lock_timeout = '5s';

ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS agent_update_pending_since timestamp with time zone;

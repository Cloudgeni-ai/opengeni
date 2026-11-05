-- deployment-mode: rolling
-- What the automatic agent updater remembers about a Connected Machine's
-- current run of unsuccessful updates. Each retry or postponement records a
-- new update operation, so the operation's own fields restart every time.
--
-- agent_update_pending_since: when the run began, the first attempt after
--   the last success. It bounds how long an update waits for managed
--   browsers that are in use.
-- agent_update_failed_attempts: how many attempts of the run failed for a
--   reason other than a busy machine, before the current one. Retries of a
--   failed download back off from it.
-- agent_update_browsers_close_at: the announced time at which an update
--   closes the managed browsers of an older agent. Kept through refusals of
--   a busy machine, so a refusal never restarts the wait.
--
-- Rolling: the columns are additive, nullable or defaulted. The previous
-- release never reads or writes them. The next attempt on a row the previous
-- release wrote starts its run at that row's failed attempt
-- (agent_update_requested_at).
SET LOCAL lock_timeout = '5s';

ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS agent_update_pending_since timestamp with time zone;
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS agent_update_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS agent_update_browsers_close_at timestamp with time zone;

-- deployment-mode: rolling
-- What the automatic agent updater remembers about a Connected Machine's
-- current run of unsuccessful updates. Each retry or postponement records a
-- new update operation, so the operation's own fields restart every time. A
-- run continues while the latest attempt failed retryably or was postponed;
-- a success or a non-retryable failure ends it.
--
-- agent_update_browsers_wait_since: when the run first postponed the update
--   for managed browsers in use. It bounds how long browsers hold an update.
-- agent_update_failed_attempts: attempts of the run for the current target
--   that failed for a reason other than a busy machine, before the current
--   one. Retries of a failed download back off from it.
-- agent_update_browsers_close_at: the announced time at which an update
--   closes the managed browsers of an older agent. Kept through refusals of
--   a busy machine, so a refusal never restarts the wait.
--
-- Rolling: the columns are additive, nullable or defaulted. The previous
-- release never reads or writes them.
SET LOCAL lock_timeout = '5s';

ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS agent_update_browsers_wait_since timestamp with time zone;
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS agent_update_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS agent_update_browsers_close_at timestamp with time zone;

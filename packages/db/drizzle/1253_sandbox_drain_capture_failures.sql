-- deployment-mode: rolling
-- Consecutive settled drain snapshot failures per sandbox lease epoch.
--
-- A zero-holder drain retries its workspace snapshot until it succeeds. The
-- reaper had no durable record of how often one lease had already failed, so
-- every retry started a new full snapshot about every 1.5 minutes with no
-- backoff, and nothing could alert on a lease that kept failing. These
-- columns count settled failures of one lease epoch: a count is valid only
-- while drain_capture_failure_epoch equals lease_epoch, so a new box starts
-- from zero without any existing epoch writer having to reset it.
--
-- Only new nullable columns and a NOT NULL column with a constant default
-- (metadata only, no table rewrite); the previous release never reads or
-- writes them.
ALTER TABLE sandbox_leases
  ADD COLUMN IF NOT EXISTS drain_capture_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS drain_capture_failure_epoch integer,
  ADD COLUMN IF NOT EXISTS drain_capture_first_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS drain_capture_last_failed_at timestamptz;

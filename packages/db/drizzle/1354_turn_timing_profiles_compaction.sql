-- deployment-mode: rolling
-- Turn timing profiles get their own category for context compaction inside
-- a turn. Without it, a compaction whose model call is not audited as a model
-- request was charged to the gap after the tool call that preceded it.
--
-- Rolling: a column with a constant default (metadata only, no rewrite). The
-- previous release does not write it, so its rows keep 0.
SET LOCAL lock_timeout = '5s';

ALTER TABLE turn_timing_profiles ADD COLUMN IF NOT EXISTS compaction_ms bigint NOT NULL DEFAULT 0;

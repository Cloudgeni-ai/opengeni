-- deployment-mode: rolling
-- sessions and session_event_cursors hold one row per session, and almost
-- every agent event updates that row. With the default autovacuum settings a
-- busy deployment re-analyzes both tables every two or three minutes, even
-- though their row count and value distributions barely move between runs.
--
-- Each ANALYZE (and each VACUUM that moves relpages, reltuples or
-- relallvisible) rewrites the table's pg_class statistics, which invalidates
-- every cached plan that depends on the table in every backend. sessions is
-- referenced by the row-level security policies of most session-scoped tables,
-- so each refresh makes all connections re-plan their hottest prepared
-- statements. The planner then dominates CPU for statements that otherwise
-- run in well under a millisecond.
--
-- Refresh statistics after a fixed number of modified rows instead of a share
-- of the table: often enough to follow real growth, rare enough that cached
-- plans survive. Vacuum cadence is unchanged. Row-count drift between analyzes
-- is still tracked by VACUUM's reltuples estimate, and range endpoints by the
-- planner's live index probes.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.sessions SET (
  autovacuum_analyze_scale_factor = 0,
  autovacuum_analyze_threshold = 50000
);

ALTER TABLE public.session_event_cursors SET (
  autovacuum_analyze_scale_factor = 0,
  autovacuum_analyze_threshold = 50000
);

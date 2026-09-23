-- deployment-mode: rolling
-- Session identity determines workspace and account. Independent column
-- estimates otherwise multiply the same scope selectivity several times.
-- No index, payload, pagination boundary, grant or planner setting changes.
SET LOCAL lock_timeout = '5s';

CREATE STATISTICS session_events_scope_statistics (dependencies, mcv)
ON account_id, workspace_id, session_id FROM session_events;
ALTER STATISTICS session_events_scope_statistics SET STATISTICS 1000;

-- Populate existing installations immediately; autovacuum ANALYZE maintains
-- this statistics object afterward. Only scope and cursor columns are sampled.
-- The policy DDL is deliberately in 0476's separate transaction so its lock
-- cannot be retained across this scan.
ANALYZE session_events (account_id, workspace_id, session_id, sequence);
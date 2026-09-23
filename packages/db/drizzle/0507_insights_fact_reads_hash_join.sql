-- deployment-mode: rolling
-- The five insights fact authority functions (0359, 0484) join the exact fact window
-- against a MATERIALIZED visible-session CTE so private-session checks run once
-- per session rather than once per fact. The planner estimates the fact window
-- from occurred_at statistics, and a time-series window newer than the last
-- ANALYZE (always true for "today", and for a week whenever autovacuum lags)
-- is estimated as ~1 row. That misestimate turns the CTE join into a Nested
-- Loop that rescans the whole CTE for every fact row: with 11k sessions and a
-- 175k-row usage week the join costs ~2 billion comparisons (observed 5-14
-- minutes per request on a staging workspace) while a hash join over the same
-- inputs completes in well under a second.
--
-- Pin the hash-join-safe planner setting on the functions themselves. The
-- setting is scoped to each function's own statements, the authorization,
-- window, filter, and capability protocol is byte-for-byte unchanged, and
-- ordinary statements planned outside these functions are unaffected.
ALTER FUNCTION opengeni_private.visible_workspace_insights_usage_projection(
  uuid, timestamp with time zone, timestamp with time zone, text[]
) SET enable_nestloop = off;
ALTER FUNCTION opengeni_private.visible_workspace_insights_usage_events(
  uuid, timestamp with time zone, timestamp with time zone, text[]
) SET enable_nestloop = off;
ALTER FUNCTION opengeni_private.visible_workspace_insights_usage_events(
  uuid, timestamp with time zone, timestamp with time zone
) SET enable_nestloop = off;
ALTER FUNCTION opengeni_private.visible_workspace_insights_model_call_facts(
  uuid, timestamp with time zone, timestamp with time zone, text, text
) SET enable_nestloop = off;
ALTER FUNCTION opengeni_private.visible_workspace_insights_model_call_facts(
  uuid, timestamp with time zone, timestamp with time zone
) SET enable_nestloop = off;

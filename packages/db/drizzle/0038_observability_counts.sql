-- 0038_observability_counts.sql
-- Cross-workspace aggregate reads for Prometheus gauges. These mirror the
-- sandbox reaper's SECURITY DEFINER pattern so workers can refresh global
-- process metrics without disabling FORCE RLS on workspace-scoped tables.

CREATE OR REPLACE FUNCTION opengeni_private.count_queued_turns()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT count(*)::bigint
  FROM session_turns
  WHERE status = 'queued';
$$;

CREATE OR REPLACE FUNCTION opengeni_private.count_sandbox_leases_by_liveness()
RETURNS TABLE (liveness text, count bigint)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT L.liveness, count(*)::bigint
  FROM sandbox_leases L
  GROUP BY L.liveness;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.count_queued_turns() TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.count_sandbox_leases_by_liveness() TO opengeni_app;
  END IF;
END $$;

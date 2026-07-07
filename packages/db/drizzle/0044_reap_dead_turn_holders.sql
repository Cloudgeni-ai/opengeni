-- 0044_reap_dead_turn_holders.sql
-- Dead-worker turn holders were TTL-exempt forever: a live turn refreshes its
-- holder every 10s (even a legit multi-day turn), but a worker killed without
-- cleanup (SIGKILL/OOM/deploy churn) leaves a holder whose heartbeat is frozen.
-- Left in place it pins refcount >= 1 FOREVER, so the lease never drains, the
-- reaper never persists /workspace, and the box rides the provider hard-timeout
-- to an UNPERSISTED death (2026-07-06 staging deploy churn left turn holders
-- frozen for hours). Reap turn holders whose heartbeat is older than the
-- caller-supplied horizon (the worker passes warming-budget + lease-TTL: the
-- heartbeat only starts once establish returns, so the horizon must cover the
-- longest legitimate silent stretch; a redispatched turn re-acquires under a
-- NEW holder id, so a live execution is never touched).

CREATE OR REPLACE FUNCTION opengeni_private.reap_sandbox_leases(
  p_viewer_holder_ttl_ms bigint,
  p_turn_holder_ttl_ms   bigint,
  p_idle_grace_ms        bigint
)
RETURNS TABLE (workspace_id uuid, sandbox_group_id uuid, instance_id text, lease_epoch integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM sandbox_lease_holders h
  WHERE h.kind = 'viewer'
    AND h.last_heartbeat_at < now() - make_interval(secs => p_viewer_holder_ttl_ms / 1000.0);

  -- Dead-worker turn holders (see header). p_turn_holder_ttl_ms <= 0 preserves
  -- the legacy never-reap behaviour.
  IF p_turn_holder_ttl_ms > 0 THEN
    DELETE FROM sandbox_lease_holders h
    WHERE h.kind = 'turn'
      AND h.last_heartbeat_at < now() - make_interval(secs => p_turn_holder_ttl_ms / 1000.0);
  END IF;

  UPDATE sandbox_leases L SET
    refcount       = c.total,
    turn_holders   = c.turns,
    viewer_holders = c.viewers,
    liveness = CASE WHEN L.liveness = 'warm' AND c.total = 0 AND c.turns = 0
                    THEN 'draining' ELSE L.liveness END,
    expires_at = CASE WHEN L.liveness = 'warm' AND c.total = 0 AND c.turns = 0
                    THEN now() + make_interval(secs => p_idle_grace_ms / 1000.0)
                    ELSE L.expires_at END,
    updated_at = now()
  FROM (
    SELECT L2.id,
           (SELECT count(*) FROM sandbox_lease_holders h WHERE h.lease_id = L2.id)::int                       AS total,
           (SELECT count(*) FROM sandbox_lease_holders h WHERE h.lease_id = L2.id AND h.kind = 'turn')::int   AS turns,
           (SELECT count(*) FROM sandbox_lease_holders h WHERE h.lease_id = L2.id AND h.kind = 'viewer')::int AS viewers
    FROM sandbox_leases L2
  ) c
  WHERE L.id = c.id;

  -- Warming died before provider create returned: no instance was ever tracked.
  UPDATE sandbox_leases AS L SET
    liveness = 'cold', instance_id = NULL,
    resume_backend_id = NULL, resume_state = NULL,
    data_plane_url = NULL, terminal_data_plane_url = NULL, updated_at = now()
  WHERE L.liveness = 'warming' AND L.expires_at < now() AND L.instance_id IS NULL;

  -- Warming died after provider create returned: keep the instance_id and hand it
  -- to the normal provider termination path in this same sweep.
  UPDATE sandbox_leases AS L SET
    liveness = 'draining',
    refcount = 0,
    turn_holders = 0,
    viewer_holders = 0,
    data_plane_url = NULL,
    terminal_data_plane_url = NULL,
    expires_at = now() - interval '1 millisecond',
    updated_at = now()
  WHERE L.liveness = 'warming' AND L.expires_at < now() AND L.instance_id IS NOT NULL;

  RETURN QUERY
    SELECT L.workspace_id, L.sandbox_group_id, L.instance_id, L.lease_epoch
    FROM sandbox_leases L
    WHERE L.liveness = 'draining' AND L.expires_at < now() AND L.refcount = 0;
END;
$$;

-- Rolling-deploy compat: workers built before this migration call the 2-arg
-- form. Delegate with turn-holder reaping OFF (legacy behaviour) until every
-- worker passes the explicit TTL.
CREATE OR REPLACE FUNCTION opengeni_private.reap_sandbox_leases(
  p_viewer_holder_ttl_ms bigint,
  p_idle_grace_ms        bigint
)
RETURNS TABLE (workspace_id uuid, sandbox_group_id uuid, instance_id text, lease_epoch integer)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT * FROM opengeni_private.reap_sandbox_leases(p_viewer_holder_ttl_ms, 0::bigint, p_idle_grace_ms);
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.reap_sandbox_leases(bigint, bigint, bigint) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.reap_sandbox_leases(bigint, bigint) TO opengeni_app;
  END IF;
END $$;

-- 0036_modal_lease_orphan_reaper.sql
-- Modal lease leak hardening:
--   1. An expired warming lease with a persisted instance_id is now surfaced as
--      immediately drainable instead of being reset cold and losing the only DB
--      pointer to the provider sandbox.
--   2. The worker's provider-side Modal orphan sweep gets a SECURITY DEFINER
--      live-lease attribution read so it can compare Modal tags against current
--      lease rows across workspaces without disabling FORCE RLS.

CREATE OR REPLACE FUNCTION opengeni_private.reap_sandbox_leases(
  p_viewer_holder_ttl_ms bigint,
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

CREATE OR REPLACE FUNCTION opengeni_private.list_live_modal_sandbox_leases()
RETURNS TABLE (
  lease_id uuid,
  workspace_id uuid,
  sandbox_group_id uuid,
  instance_id text,
  liveness text
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT L.id, L.workspace_id, L.sandbox_group_id, L.instance_id, L.liveness
  FROM sandbox_leases L
  WHERE L.liveness IN ('warming', 'warm', 'draining')
    AND (L.backend = 'modal' OR L.resume_backend_id = 'modal');
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.reap_sandbox_leases(bigint, bigint) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.list_live_modal_sandbox_leases() TO opengeni_app;
  END IF;
END $$;

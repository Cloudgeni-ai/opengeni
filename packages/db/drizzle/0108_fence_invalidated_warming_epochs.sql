-- deployment-mode: rolling
-- Fence provider creates that outlive a failed or expired warming acquisition.
--
-- A warming row can be invalidated while a provider create is still
-- non-abortably in flight. Advancing lease_epoch in the same transaction that
-- exposes cold/draining means a successor can never reuse the old acquisition
-- epoch, so late record/commit/fail/cleanup callbacks fail their existing CAS.

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

  -- The old warming epoch is permanently closed before a successor can acquire.
  UPDATE sandbox_leases AS L SET
    liveness = 'cold', instance_id = NULL,
    resume_backend_id = NULL, resume_state = NULL,
    data_plane_url = NULL, terminal_data_plane_url = NULL,
    lease_epoch = L.lease_epoch + 1,
    updated_at = now()
  WHERE L.liveness = 'warming' AND L.expires_at < now() AND L.instance_id IS NULL;

  -- Keep an attributed provider id for the drain/terminate path, but fence the
  -- expired creator before exposing the row as drainable.
  UPDATE sandbox_leases AS L SET
    liveness = 'draining',
    refcount = 0,
    turn_holders = 0,
    viewer_holders = 0,
    data_plane_url = NULL,
    terminal_data_plane_url = NULL,
    lease_epoch = L.lease_epoch + 1,
    expires_at = now() - interval '1 millisecond',
    updated_at = now()
  WHERE L.liveness = 'warming' AND L.expires_at < now() AND L.instance_id IS NOT NULL;

  RETURN QUERY
    SELECT L.workspace_id, L.sandbox_group_id, L.instance_id, L.lease_epoch
    FROM sandbox_leases L
    WHERE L.liveness = 'draining' AND L.expires_at < now() AND L.refcount = 0;
END;
$$;
-- deployment-mode: rolling
-- Open requests and PTYs left on a Modal box whose lease epoch has ended.
--
-- A request or PTY recorded on an earlier lease epoch and a different box can
-- never progress once that box is gone, yet nothing settled it after the lease
-- moved on (legacy losses before exact loss settlement, or a cold commit that
-- left it open). It pins its attempt's quiescence, and with it the session's
-- work claim, forever.
--
-- Lease succession alone is not proof that the old box is gone. The reaper
-- lists every such exact provider tuple through this function, inspects the
-- exact historical Modal sandbox, and only a terminal observation lets it
-- settle the tuple in its own workspace-scoped transaction (requests rejected,
-- never replayed; PTYs closed; owners woken). Tuples with an active retained
-- process are left to retained-process reconciliation, which settles the
-- process and its requests from its own exact provider proof. Other backends,
-- Connected Machine routes and selfhosted boxes are never listed.
CREATE OR REPLACE FUNCTION opengeni_private.list_sandbox_ended_epoch_blockers()
RETURNS TABLE (
  account_id uuid,
  workspace_id uuid,
  lease_id uuid,
  sandbox_group_id uuid,
  lease_epoch bigint,
  provider_backend text,
  provider_instance_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- EMBED-SAFE: inherit the caller's target-schema search_path, matching the
-- existing cross-workspace sandbox inventory functions (0144).
AS $$
  WITH blockers AS (
    SELECT A.account_id, A.workspace_id, A.lease_id, A.sandbox_group_id,
      A.lease_epoch, A.provider_backend, A.provider_instance_id
    FROM sandbox_workspace_mutation_admissions A
    WHERE A.settled_at IS NULL
      AND A.route_kind = 'home'
    UNION
    SELECT P.account_id, P.workspace_id, P.lease_id, P.sandbox_group_id,
      P.lease_epoch, P.provider_backend, P.provider_instance_id
    FROM sandbox_pty_sessions P
    WHERE P.status = 'open'
      AND P.route_kind = 'home'
  )
  SELECT B.account_id, B.workspace_id, B.lease_id, B.sandbox_group_id,
    B.lease_epoch::bigint, B.provider_backend, B.provider_instance_id
  FROM blockers B
  JOIN sandbox_leases L
    ON L.id = B.lease_id
   AND L.account_id = B.account_id
   AND L.workspace_id = B.workspace_id
   AND L.sandbox_group_id = B.sandbox_group_id
  WHERE B.provider_backend = 'modal'
    AND B.provider_instance_id IS NOT NULL
    AND L.backend = 'modal'
    AND L.lease_epoch > B.lease_epoch
    AND L.instance_id IS DISTINCT FROM B.provider_instance_id
    AND NOT EXISTS (
      SELECT 1 FROM sandbox_retained_processes R
      WHERE R.lease_id = B.lease_id
        AND R.lease_epoch = B.lease_epoch
        AND R.provider_backend = B.provider_backend
        AND R.provider_instance_id = B.provider_instance_id
        AND R.state = 'active'
    )
  ORDER BY B.workspace_id, B.lease_id, B.lease_epoch, B.provider_instance_id;
$$;

REVOKE ALL ON FUNCTION opengeni_private.list_sandbox_ended_epoch_blockers() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE
      ON FUNCTION opengeni_private.list_sandbox_ended_epoch_blockers()
      TO opengeni_app;
  END IF;
END $$;

-- The inventory scans only open PTYs; a partial index keeps each sweep cheap.
CREATE INDEX IF NOT EXISTS sandbox_pty_sessions_open_tuple_idx
  ON sandbox_pty_sessions (lease_id, lease_epoch)
  WHERE status = 'open';

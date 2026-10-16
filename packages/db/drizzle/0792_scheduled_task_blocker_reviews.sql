-- deployment-mode: rolling
-- A schedule whose runs keep being blocked tells its owner once, and pauses
-- itself when no later run can start until a person acts. One review row per
-- task records which run was reviewed, the blocker and the owner notice, so
-- every run is reviewed once and a notice is posted and withdrawn once. New
-- table only: older binaries never read or write it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE scheduled_task_blocker_reviews (
  task_id uuid PRIMARY KEY REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The newest settled scheduled run already reviewed.
  reviewed_run_id uuid,
  -- clear: nothing to report. notified: the owner was told about runs that
  -- keep failing or being skipped; the schedule keeps running. paused: the
  -- schedule paused itself because no later run could start.
  state text NOT NULL DEFAULT 'clear' CHECK (state IN ('clear', 'notified', 'paused')),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 128),
  message text CHECK (message IS NULL OR char_length(message) BETWEEN 1 AND 1000),
  blocked_run_id uuid,
  blocked_since timestamptz,
  -- The session that carries the owner notice and its notification key.
  notice_session_id uuid,
  notice_key text CHECK (notice_key IS NULL OR notice_key ~ '^[A-Za-z0-9._:-]{1,120}$'),
  -- A notice post or withdrawal still to deliver, retried until it lands.
  notice_pending text CHECK (notice_pending IS NULL OR notice_pending IN ('post', 'withdraw')),
  notice_payload jsonb CHECK (notice_payload IS NULL OR (jsonb_typeof(notice_payload) = 'object'
    AND octet_length(notice_payload::text) <= 4096)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_task_blocker_reviews_state_chk CHECK (
    (state = 'clear' AND reason IS NULL AND message IS NULL AND blocked_run_id IS NULL
      AND blocked_since IS NULL)
    OR (state <> 'clear' AND reason IS NOT NULL AND message IS NOT NULL
      AND blocked_run_id IS NOT NULL AND blocked_since IS NOT NULL)),
  CONSTRAINT scheduled_task_blocker_reviews_notice_chk CHECK (
    (notice_session_id IS NULL) = (notice_key IS NULL)
    AND (notice_pending IS NULL OR notice_session_id IS NOT NULL)
    AND ((notice_pending IS NOT DISTINCT FROM 'post') = (notice_payload IS NOT NULL)))
);
CREATE INDEX scheduled_task_blocker_reviews_workspace_idx
  ON scheduled_task_blocker_reviews(workspace_id, task_id);
ALTER TABLE scheduled_task_blocker_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_blocker_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON scheduled_task_blocker_reviews
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  -- Exact-owner, read-only capability used solely by bounded system inventory,
  -- the same capability the schedule lifecycle inventory already uses.
  EXECUTE format('CREATE POLICY blocker_review_inventory_read ON %I.scheduled_task_blocker_reviews FOR SELECT USING (%I.session_tenancy_fence_owner_policy_active(current_user, %L, %s::oid, workspace_id, true))',
    data_schema, data_schema, current_user, data_schema::regnamespace::oid);
  -- Identity-only inventory of tasks with a run to review or a notice to
  -- deliver. Every mutation is tenant-scoped and rechecked under the task lock.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.list_scheduled_task_blocker_reviews(p_limit integer)
    RETURNS TABLE (id uuid, workspace_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'Invalid schedule blocker inventory bound' USING ERRCODE = '22023';
      END IF;
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY SELECT task.id, task.workspace_id
        FROM %1$I.scheduled_tasks task
        LEFT JOIN %1$I.scheduled_task_blocker_reviews review
          ON review.task_id = task.id AND review.workspace_id = task.workspace_id
        LEFT JOIN LATERAL (
          SELECT run.id, run.status FROM %1$I.scheduled_task_runs run
          WHERE run.workspace_id = task.workspace_id AND run.task_id = task.id
            AND run.account_id = task.account_id
            AND run.trigger_type = 'scheduled' AND run.action_kind = 'agent_turn'
          ORDER BY run.created_at DESC, run.id DESC LIMIT 1
        ) latest ON true
        WHERE review.notice_pending IS NOT NULL
          OR (task.deleted_at IS NOT NULL AND review.state IN ('notified', 'paused'))
          OR (task.deleted_at IS NULL AND review.state = 'paused' AND task.status = 'active')
          OR (task.deleted_at IS NULL AND review.state = 'notified' AND task.status <> 'active')
          OR (task.deleted_at IS NULL AND task.status = 'active'
            AND latest.status IN ('succeeded', 'failed', 'skipped')
            AND latest.id IS DISTINCT FROM review.reviewed_run_id
            AND (latest.status <> 'succeeded' OR review.state = 'notified'))
        ORDER BY task.updated_at, task.id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END
    $body$;
  $create$, data_schema);
END
$install$;
REVOKE ALL ON FUNCTION opengeni_private.list_scheduled_task_blocker_reviews(integer) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.list_scheduled_task_blocker_reviews(integer) TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scheduled_task_blocker_reviews TO opengeni_app;
  END IF;
END
$grant$;

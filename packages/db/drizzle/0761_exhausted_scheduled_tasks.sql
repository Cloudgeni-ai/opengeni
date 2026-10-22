-- deployment-mode: rolling
-- Preserve the existing active/paused API. Exhausted schedules become paused,
-- after accepted work settles and Temporal's existing 24-hour catch-up window.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Separate from deletion cleanup: old API replicas must never interpret a
-- retirement reconciliation as permission to delete a newly edited schedule.
CREATE TABLE scheduled_task_schedule_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  temporal_schedule_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_task_schedule_outbox_due_idx ON scheduled_task_schedule_outbox(next_attempt_at, id);
ALTER TABLE scheduled_task_schedule_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_schedule_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON scheduled_task_schedule_outbox
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE FUNCTION scheduled_task_is_exhausted(p_task_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT coalesce((SELECT
    NOT EXISTS (SELECT 1 FROM scheduled_task_runs pending
      WHERE pending.task_id = task.id AND pending.account_id = task.account_id
        AND pending.workspace_id = task.workspace_id
        AND pending.status IN ('queued', 'dispatched', 'running'))
    AND CASE
      WHEN task.schedule->>'type' = 'interval'
        AND pg_input_is_valid(task.schedule->>'endAt', 'timestamptz')
      THEN (task.schedule->>'endAt')::timestamptz + interval '24 hours' < now()
      WHEN task.schedule->>'type' = 'once'
        AND pg_input_is_valid(task.schedule->>'runAt', 'timestamptz')
      THEN (task.schedule->>'runAt')::timestamptz < now() AND (
        (task.schedule->>'runAt')::timestamptz + interval '24 hours' < now()
        OR EXISTS (SELECT 1 FROM scheduled_task_runs consumed
          WHERE consumed.task_id = task.id AND consumed.account_id = task.account_id
            AND consumed.workspace_id = task.workspace_id
            AND consumed.trigger_type = 'scheduled'
            AND consumed.status IN ('succeeded', 'failed', 'skipped')
            AND (consumed.accepted_execution_snapshot->'task'->'schedule' = task.schedule
              OR (consumed.task_authority_revision = task.authority_revision
                AND consumed.task_execution_digest = task.execution_digest))))
      ELSE false
    END
    FROM scheduled_tasks task WHERE task.id = p_task_id), false)
$$;
REVOKE ALL ON FUNCTION scheduled_task_is_exhausted(uuid) FROM PUBLIC;
DO $install$
DECLARE data_schema text := current_schema(); table_name text;
BEGIN
  EXECUTE format('ALTER FUNCTION %I.scheduled_task_is_exhausted(uuid) SET search_path = pg_catalog, %I, pg_temp', data_schema, data_schema);
  -- Exact-owner, read-only capability used solely by bounded system inventory.
  FOREACH table_name IN ARRAY ARRAY['scheduled_tasks', 'scheduled_task_runs', 'scheduled_task_schedule_outbox'] LOOP
    EXECUTE format('CREATE POLICY exhausted_schedule_inventory_read ON %I.%I FOR SELECT USING (%I.session_tenancy_fence_owner_policy_active(current_user, %L, %s::oid, workspace_id, true))',
      data_schema, table_name, data_schema, current_user, data_schema::regnamespace::oid);
  END LOOP;
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.list_exhausted_scheduled_tasks(p_limit integer)
    RETURNS TABLE (id uuid, workspace_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'Invalid exhausted schedule inventory bound' USING ERRCODE = '22023';
      END IF;
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY SELECT task.id, task.workspace_id FROM %1$I.scheduled_tasks task
        WHERE task.status = 'active' AND task.deleted_at IS NULL
          AND %1$I.scheduled_task_is_exhausted(task.id)
        ORDER BY task.updated_at, task.id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END
    $body$;
  $create$, data_schema);
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.list_scheduled_task_schedule_reconciliations(p_limit integer)
    RETURNS TABLE (id uuid, task_id uuid, workspace_id uuid, temporal_schedule_id text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'Invalid schedule reconciliation inventory bound' USING ERRCODE = '22023';
      END IF;
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY SELECT pending.id, pending.task_id, pending.workspace_id, pending.temporal_schedule_id
        FROM %1$I.scheduled_task_schedule_outbox pending WHERE pending.next_attempt_at <= now()
        ORDER BY pending.next_attempt_at, pending.id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END
    $body$;
  $create$, data_schema);
END
$install$;
REVOKE ALL ON FUNCTION opengeni_private.list_exhausted_scheduled_tasks(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.list_scheduled_task_schedule_reconciliations(integer) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION scheduled_task_is_exhausted(uuid) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.list_exhausted_scheduled_tasks(integer) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.list_scheduled_task_schedule_reconciliations(integer) TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scheduled_task_schedule_outbox TO opengeni_app;
  END IF;
END
$grant$;

-- The owner-only window sees every tenant. No advisory lock follows these
-- table locks; the repair has no unclaimed runs for the pause cutoff to drain.
ALTER TABLE scheduled_tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_schedule_outbox NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks DISABLE TRIGGER session_tenancy_workspace_fence;
WITH retired AS (
  UPDATE scheduled_tasks SET status = 'paused', updated_at = now()
  WHERE status = 'active' AND deleted_at IS NULL AND scheduled_task_is_exhausted(id)
  RETURNING id, account_id, workspace_id, temporal_schedule_id
)
INSERT INTO scheduled_task_schedule_outbox(account_id, workspace_id, temporal_schedule_id, task_id)
SELECT account_id, workspace_id, temporal_schedule_id, id FROM retired
ON CONFLICT (task_id) DO NOTHING;
ALTER TABLE scheduled_tasks ENABLE TRIGGER session_tenancy_workspace_fence;
ALTER TABLE scheduled_task_schedule_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;

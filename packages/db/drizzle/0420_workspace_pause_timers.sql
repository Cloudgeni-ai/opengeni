-- deployment-mode: maintenance
-- Drain old API/control/turn workers before activation. New timer event actions
-- and manual-control cancellation semantics must be installed together.
ALTER TABLE workspace_inference_controls
  ADD COLUMN timer_id uuid,
  ADD COLUMN timer_action text,
  ADD COLUMN timer_due_at timestamptz,
  ADD COLUMN timer_pause_for_seconds integer,
  ADD COLUMN timer_pause_revision bigint,
  ADD CONSTRAINT workspace_pause_timer_shape CHECK (
    (timer_id IS NULL AND timer_action IS NULL AND timer_due_at IS NULL
      AND timer_pause_for_seconds IS NULL AND timer_pause_revision IS NULL)
    OR (timer_id IS NOT NULL AND timer_action IS NOT NULL AND timer_due_at IS NOT NULL
      AND ((timer_action = 'pause' AND timer_pause_revision IS NULL)
        OR (timer_action = 'resume' AND timer_pause_revision IS NOT NULL AND timer_pause_for_seconds IS NULL))
      AND (timer_pause_for_seconds IS NULL OR timer_pause_for_seconds BETWEEN 60 AND 2592000))
  );
CREATE INDEX workspace_pause_timer_due_idx ON workspace_inference_controls(timer_due_at, workspace_id)
  WHERE timer_id IS NOT NULL;
ALTER TABLE workspace_control_events DROP CONSTRAINT workspace_control_events_action_check;
ALTER TABLE workspace_control_events ADD CONSTRAINT workspace_control_events_action_check
  CHECK (action IN ('pause', 'resume', 'timer_set', 'timer_cancelled'));

-- Narrow, read-only inventory capability. FORCE RLS stays enabled; only the
-- table owner inside this SECURITY DEFINER function gets cross-tenant discovery.
DO $migration$
DECLARE data_schema text := current_schema(); owner_name text := current_user;
BEGIN
  EXECUTE format('CREATE POLICY workspace_pause_timer_discovery ON %I.workspace_inference_controls
    FOR SELECT TO %I USING (current_setting(''opengeni.pause_timer_discovery'', true) = ''1'')',
    data_schema, owner_name);
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.list_due_workspace_pause_timers(p_limit integer)
    RETURNS TABLE(workspace_id uuid, timer_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE previous text := current_setting('opengeni.pause_timer_discovery', true);
    BEGIN
      PERFORM set_config('opengeni.pause_timer_discovery', '1', true);
      RETURN QUERY SELECT c.workspace_id, c.timer_id FROM %I.workspace_inference_controls c
        WHERE c.timer_id IS NOT NULL AND c.timer_due_at <= clock_timestamp()
        ORDER BY c.timer_due_at, c.workspace_id LIMIT greatest(1, least(coalesce(p_limit, 100), 1000));
      PERFORM set_config('opengeni.pause_timer_discovery', coalesce(previous, ''), true);
    END $body$;
  $create$, data_schema);
END $migration$;
REVOKE ALL ON FUNCTION opengeni_private.list_due_workspace_pause_timers(integer) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.list_due_workspace_pause_timers(integer) TO opengeni_app;
  END IF;
END $grant$;

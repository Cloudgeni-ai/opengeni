-- deployment-mode: rolling
-- Pausing or soft-deleting a scheduled task is a durable first-claim cutoff.
-- Runs whose scheduler-owned turn already exists remain accepted work and keep
-- their normal attempt/recovery lifecycle. Every earlier occurrence becomes a
-- terminal receipt, so a later Resume cannot revive a deposit accepted before
-- the lifecycle boundary.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Old claimers do not inspect scheduled_task_runs.status after this migration
-- marks an occurrence terminal. Keep the rolling boundary safe in the database:
-- every binary must cross this state transition before it can create the
-- scheduler-owned turn or start provider work.
CREATE FUNCTION fence_terminal_scheduled_occurrence_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  run_status text;
BEGIN
  SELECT run.status INTO run_status
  FROM scheduled_task_runs run
  WHERE run.id = OLD.scheduled_task_run_id
    AND run.account_id = OLD.account_id
    AND run.workspace_id = OLD.workspace_id
    AND run.session_id = OLD.session_id
    AND run.action_kind = 'agent_turn'
  FOR UPDATE;

  IF run_status IS DISTINCT FROM 'dispatched' THEN
    RAISE EXCEPTION 'terminal scheduled occurrence cannot be delivered'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER scheduled_terminal_occurrence_delivery_fence
BEFORE UPDATE OF state ON session_system_updates
FOR EACH ROW
WHEN (
  OLD.scheduled_task_run_id IS NOT NULL
  AND OLD.state = 'pending'
  AND NEW.state = 'delivered'
)
EXECUTE FUNCTION fence_terminal_scheduled_occurrence_delivery();

CREATE FUNCTION invalidate_unclaimed_scheduled_agent_runs_on_task_inactive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  run_row record;
  invalidation_error text := CASE
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
      THEN 'scheduled_task_deleted_before_claim'
    ELSE 'scheduled_task_paused_before_claim'
  END;
BEGIN
  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (
    pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'run_lifecycle'
  )
  ON CONFLICT DO NOTHING;

  -- Run admission takes the task row first. Deposit and claim both lock the run
  -- before they can publish an occurrence or a scheduler-owned turn. Once this
  -- loop owns a run, a fresh turn lookup therefore decides the race exactly:
  -- no turn means no claim crossed the lifecycle boundary.
  FOR run_row IN
    SELECT run.id
    FROM scheduled_task_runs run
    WHERE run.account_id = NEW.account_id
      AND run.workspace_id = NEW.workspace_id
      AND run.task_id = NEW.id
      AND run.action_kind = 'agent_turn'
      AND run.status IN ('queued', 'dispatched')
    ORDER BY run.id
    FOR UPDATE
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM session_turns turn_value
      WHERE turn_value.account_id = NEW.account_id
        AND turn_value.workspace_id = NEW.workspace_id
        AND turn_value.scheduled_task_run_id = run_row.id
    ) THEN
      UPDATE scheduled_task_runs run
      SET status = 'skipped',
        error = invalidation_error,
        completed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
      WHERE run.id = run_row.id
        AND run.account_id = NEW.account_id
        AND run.workspace_id = NEW.workspace_id
        AND run.status IN ('queued', 'dispatched');
    END IF;
  END LOOP;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_lifecycle';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_lifecycle';
  RAISE;
END
$body$;

CREATE TRIGGER scheduled_task_unclaimed_occurrence_invalidation
AFTER UPDATE OF status, deleted_at ON scheduled_tasks
FOR EACH ROW
WHEN (
  (OLD.status = 'active' AND NEW.status = 'paused')
  OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
)
EXECUTE FUNCTION invalidate_unclaimed_scheduled_agent_runs_on_task_inactive();

REVOKE ALL ON FUNCTION
  invalidate_unclaimed_scheduled_agent_runs_on_task_inactive()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION fence_terminal_scheduled_occurrence_delivery() FROM PUBLIC;

DO $pin_scheduled_task_unclaimed_invalidation$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.invalidate_unclaimed_scheduled_agent_runs_on_task_inactive() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema,
    data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.fence_terminal_scheduled_occurrence_delivery() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema,
    data_schema
  );
END
$pin_scheduled_task_unclaimed_invalidation$;

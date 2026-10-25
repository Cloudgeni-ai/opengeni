-- deployment-mode: rolling
-- An automation whose event triggers repeat keeps listening after its
-- schedule's last run: a spent one-time date or an ended interval no longer
-- retires it while it has repeating triggers. A run-once automation is still
-- exhausted after its run, and an automation without event triggers is
-- unchanged. The body is 0929's with the repeating-trigger guard added; the
-- event settings row exists exactly while the automation has triggers.
CREATE OR REPLACE FUNCTION scheduled_task_is_exhausted(p_task_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT coalesce((SELECT
    NOT EXISTS (SELECT 1 FROM scheduled_task_runs pending
      WHERE pending.task_id = task.id AND pending.account_id = task.account_id
        AND pending.workspace_id = task.workspace_id
        AND pending.status IN ('queued', 'dispatched', 'running'))
    AND ((CASE
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
    AND NOT EXISTS (SELECT 1 FROM scheduled_task_event_settings repeating
      WHERE repeating.task_id = task.id AND repeating.account_id = task.account_id
        AND repeating.workspace_id = task.workspace_id AND NOT repeating.once))
    OR EXISTS (SELECT 1 FROM scheduled_task_event_settings settings
      WHERE settings.task_id = task.id AND settings.account_id = task.account_id
        AND settings.workspace_id = task.workspace_id
        AND settings.once AND settings.completed_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM scheduled_task_event_occurrences occurrence
          WHERE occurrence.task_id = task.id AND occurrence.workspace_id = task.workspace_id
            AND (occurrence.status = 'pending'
              OR (occurrence.started_at > now() - interval '1 hour'
                AND NOT EXISTS (SELECT 1 FROM scheduled_task_runs run
                  WHERE run.workspace_id = task.workspace_id AND run.task_id = task.id
                    AND run.producer_key = 'scheduled-task-event:' || occurrence.id::text))))))
    FROM scheduled_tasks task WHERE task.id = p_task_id), false)
$$;
DO $repeating_event_triggers$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.scheduled_task_is_exhausted(uuid) SET search_path = pg_catalog, %I, pg_temp', data_schema, data_schema);
END
$repeating_event_triggers$;

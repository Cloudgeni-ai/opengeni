-- deployment-mode: rolling
CREATE INDEX scheduled_tasks_workspace_session_target_idx
  ON scheduled_tasks (workspace_id, reusable_session_id)
  WHERE deleted_at IS NULL;

-- deployment-mode: rolling

-- A goal_update operation belongs to the target goal/session, not to one
-- replaceable worker attempt. The receipt retains its original attempt FK for
-- audit, while this partial identity lets a recovered attempt reconcile the
-- exact committed result.
CREATE UNIQUE INDEX "session_command_receipts_goal_update_operation_uq"
  ON "session_command_receipts" (
    "workspace_id", "action", "target_session_id", "operation_key"
  )
  WHERE "action" = 'goal.update';
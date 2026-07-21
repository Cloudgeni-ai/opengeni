-- Workspace Pause is a first-class durable control kind. The 0057 constraint
-- predates that control path and must match the canonical runtime state machine.

ALTER TABLE "sessions"
  DROP CONSTRAINT "sessions_pending_control_kind_check";

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_pending_control_kind_check"
  CHECK (
    "pending_control_kind" IS NULL
    OR "pending_control_kind" IN ('pause', 'workspace_pause', 'steer')
  );

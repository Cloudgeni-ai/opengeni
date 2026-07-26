-- A failed internal-only inference preserves ordinary internal updates without
-- making them independently runnable again. They become eligible when a real
-- prompt or a genuinely new pending internal update starts the next inference.

ALTER TABLE "session_system_updates"
  DROP CONSTRAINT "system_updates_state_check";

ALTER TABLE "session_system_updates"
  ADD CONSTRAINT "system_updates_state_check"
  CHECK ("state" IN ('pending', 'deferred', 'delivered', 'cancelled', 'failed'));

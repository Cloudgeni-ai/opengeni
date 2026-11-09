-- deployment-mode: rolling
-- online-safety-exception: explicit-lock: Takes the two locks this FK drop needs anyway, in work-claim order, so a concurrent claim waits instead of deadlocking; acquisition fails within five seconds.
-- system_updates_workspace_turn_fk was
--   FOREIGN KEY (workspace_id, delivered_turn_id) ... ON DELETE SET NULL
-- with no column list, so deleting a delivered turn tried to null both
-- columns, and workspace_id is NOT NULL (23502). The FK now nulls only
-- delivered_turn_id, as other composite workspace FKs do (for example 1071).
-- It stays DEFERRABLE INITIALLY DEFERRED; that defers only the reference
-- check, while the SET NULL action still runs at the end of the deleting
-- statement. The same defect on
-- codex_capacity_waiters_workspace_resumed_update_fk made every archived
-- session with a resumed waiter fail its purge until 1285 dropped that table.
--
-- Dropping the FK takes ACCESS EXCLUSIVE on both tables. Take them in the
-- order work claims do (session_turns, then session_system_updates) so a
-- concurrent claim waits instead of deadlocking; lock_timeout bounds the wait.
--
-- NOT VALID; 1342 validates it. Every existing row already satisfies the
-- identical reference, so the previous release is unaffected.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

LOCK TABLE session_turns, session_system_updates IN ACCESS EXCLUSIVE MODE;

ALTER TABLE session_system_updates
  DROP CONSTRAINT system_updates_workspace_turn_fk,
  ADD CONSTRAINT system_updates_workspace_turn_fk
    FOREIGN KEY (workspace_id, delivered_turn_id)
    REFERENCES session_turns(workspace_id, id)
    ON DELETE SET NULL (delivered_turn_id)
    DEFERRABLE INITIALLY DEFERRED NOT VALID;

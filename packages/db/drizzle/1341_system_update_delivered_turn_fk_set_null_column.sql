-- deployment-mode: rolling
-- system_updates_workspace_turn_fk was
--   FOREIGN KEY (workspace_id, delivered_turn_id) ... ON DELETE SET NULL
-- with no column list, so deleting a delivered turn tried to null both
-- columns, and workspace_id is NOT NULL (23502). The FK now nulls only
-- delivered_turn_id, as other composite workspace FKs do (for example 1071),
-- and keeps its deferral. The same defect on
-- codex_capacity_waiters_workspace_resumed_update_fk made every archived
-- session with a resumed waiter fail its purge until 1285 dropped that table.
--
-- NOT VALID; 1342 validates it. Every existing row already satisfies the
-- identical reference, so the previous release is unaffected.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE session_system_updates
  DROP CONSTRAINT system_updates_workspace_turn_fk,
  ADD CONSTRAINT system_updates_workspace_turn_fk
    FOREIGN KEY (workspace_id, delivered_turn_id)
    REFERENCES session_turns(workspace_id, id)
    ON DELETE SET NULL (delivered_turn_id)
    DEFERRABLE INITIALLY DEFERRED NOT VALID;

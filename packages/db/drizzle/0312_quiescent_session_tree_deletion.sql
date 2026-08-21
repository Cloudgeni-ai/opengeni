-- deployment-mode: rolling
-- Allow the explicit quiescent session-tree deletion lifecycle to remove the
-- rows that are owned exclusively by that tree. Cross-session and workspace
-- provenance keeps its existing RESTRICT fence, so published artifacts,
-- governed learning evidence, forks, and other durable external references
-- fail closed instead of being silently orphaned.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE sessions
  DROP CONSTRAINT sessions_workspace_parent_fk,
  ADD CONSTRAINT sessions_workspace_parent_fk
    FOREIGN KEY (workspace_id, parent_session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE session_turn_attempts
  DROP CONSTRAINT session_turn_attempts_workspace_session_fk,
  ADD CONSTRAINT session_turn_attempts_workspace_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE session_command_receipts
  DROP CONSTRAINT session_command_receipts_target_session_fk,
  ADD CONSTRAINT session_command_receipts_target_session_fk
    FOREIGN KEY (workspace_id, target_session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE workspace_control_events
  DROP CONSTRAINT workspace_control_events_root_session_fk,
  ADD CONSTRAINT workspace_control_events_root_session_fk
    FOREIGN KEY (workspace_id, root_session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE session_attempt_interruptions
  DROP CONSTRAINT session_attempt_interruptions_workspace_session_fk,
  ADD CONSTRAINT session_attempt_interruptions_workspace_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

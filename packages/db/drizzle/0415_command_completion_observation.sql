-- deployment-mode: rolling
ALTER TABLE session_background_commands
  ADD COLUMN completion_observed_at timestamptz,
  ADD CONSTRAINT session_background_commands_observation_check
    CHECK (completion_observed_at IS NULL OR state IN ('exited', 'lost'));

CREATE INDEX session_events_command_output_page_idx
  ON session_events (workspace_id, session_id, (payload ->> 'commandId'), sequence)
  WHERE type = 'sandbox.command.output.delta';
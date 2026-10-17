-- deployment-mode: rolling
-- Additive native cleanup evidence. Old runners/rows remain unknown (false),
-- never inferred from shell syntax, exit codes, or the presence of a shell.
SET LOCAL lock_timeout = '5s';
ALTER TABLE session_background_commands
  ADD COLUMN background_children_stopped boolean NOT NULL DEFAULT false;

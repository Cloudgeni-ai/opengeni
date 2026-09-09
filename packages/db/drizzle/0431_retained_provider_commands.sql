-- deployment-mode: rolling
-- Additive control-plane receipts. Historical SDK-local handles have no
-- reconstructible provider execution identity and deliberately remain NULL.
ALTER TABLE sandbox_retained_processes
  ADD COLUMN provider_command jsonb,
  ADD COLUMN provider_command_input_index bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT sandbox_retained_processes_provider_command_chk CHECK (
    provider_command IS NULL OR ((
      provider_backend = 'modal'
      AND jsonb_typeof(provider_command) = 'object'
      AND provider_command->>'kind' = 'modal-control-v1'
      AND provider_command->>'sandboxId' = provider_instance_id
      AND length(provider_command->>'taskId') > 0
      AND length(provider_command->>'execId') > 0
    ) IS TRUE)
  ),
  ADD CONSTRAINT sandbox_retained_processes_provider_input_index_chk CHECK (
    provider_command_input_index BETWEEN 0 AND 9007199254740991
  );
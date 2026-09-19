-- deployment-mode: maintenance
-- Old readers cannot interpret router byte offsets. Drain old worker owners
-- before activating new starts. Existing legacy locators remain unchanged and
-- are reconciled by the explicit legacy reader; never reinterpret their IDs.
ALTER TABLE sandbox_retained_processes
  DROP CONSTRAINT sandbox_retained_processes_provider_command_chk;
ALTER TABLE sandbox_retained_processes
  ADD CONSTRAINT sandbox_retained_processes_provider_command_chk CHECK (
    provider_command IS NULL OR ((
      provider_backend = 'modal'
      AND jsonb_typeof(provider_command) = 'object'
      AND provider_command->>'kind' IN ('modal-control-v1', 'modal-router-v1')
      AND provider_command->>'sandboxId' = provider_instance_id
      AND length(provider_command->>'taskId') > 0
      AND length(provider_command->>'execId') > 0
    ) IS TRUE)
  );
-- deployment-mode: rolling
-- Additive reason: existing capture/termination fences remain unchanged.
ALTER TABLE sandbox_leases
  DROP CONSTRAINT sandbox_leases_command_containment_reason_check,
  ADD CONSTRAINT sandbox_leases_command_containment_reason_check
  CHECK (command_containment_reason IS NULL OR command_containment_reason IN
    ('idle_containment', 'provider_deadline_containment', 'quiescence_containment'));

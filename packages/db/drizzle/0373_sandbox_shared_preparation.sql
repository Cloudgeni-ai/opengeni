-- deployment-mode: rolling
-- Durable single-flight coordination for immutable, lease-scoped sandbox setup.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE sandbox_leases
  ADD COLUMN shared_preparation_lease_epoch integer,
  ADD COLUMN shared_preparation_instance_id text,
  ADD COLUMN shared_preparation_spec_hash text,
  ADD COLUMN shared_preparation_status text,
  ADD COLUMN shared_preparation_claim_id uuid,
  ADD COLUMN shared_preparation_owner_attempt_id uuid,
  ADD COLUMN shared_preparation_attempt integer,
  ADD COLUMN shared_preparation_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN shared_preparation_started_at timestamptz,
  ADD COLUMN shared_preparation_deadline_at timestamptz,
  ADD COLUMN shared_preparation_settled_at timestamptz;

ALTER TABLE sandbox_leases
  ADD CONSTRAINT sandbox_leases_shared_preparation_check CHECK (
    (
      shared_preparation_status IS NULL
      AND shared_preparation_lease_epoch IS NULL
      AND shared_preparation_instance_id IS NULL
      AND shared_preparation_spec_hash IS NULL
      AND shared_preparation_claim_id IS NULL
      AND shared_preparation_owner_attempt_id IS NULL
      AND shared_preparation_attempt IS NULL
      AND shared_preparation_started_at IS NULL
      AND shared_preparation_deadline_at IS NULL
      AND shared_preparation_settled_at IS NULL
    ) OR (
      shared_preparation_status IN ('running', 'completed', 'failed')
      AND shared_preparation_lease_epoch IS NOT NULL
      AND shared_preparation_lease_epoch >= 0
      AND nullif(btrim(shared_preparation_instance_id), '') IS NOT NULL
      AND shared_preparation_spec_hash ~ '^sha256:[0-9a-f]{64}$'
      AND shared_preparation_claim_id IS NOT NULL
      AND shared_preparation_owner_attempt_id IS NOT NULL
      AND shared_preparation_attempt IS NOT NULL
      AND shared_preparation_attempt > 0
      AND shared_preparation_started_at IS NOT NULL
      AND shared_preparation_deadline_at > shared_preparation_started_at
      AND (
        (shared_preparation_status = 'running' AND shared_preparation_settled_at IS NULL)
        OR (shared_preparation_status IN ('completed', 'failed')
          AND shared_preparation_settled_at IS NOT NULL)
      )
    )
  ) NOT VALID;

ALTER TABLE sandbox_leases
  VALIDATE CONSTRAINT sandbox_leases_shared_preparation_check;

COMMENT ON COLUMN sandbox_leases.shared_preparation_spec_hash IS
  'Non-secret immutable setup specification coordinated once for the exact lease epoch and provider instance.';
COMMENT ON COLUMN sandbox_leases.shared_preparation_revision IS
  'Monotonic durable join cursor. Waiters treat notifications as hints and always re-read this lease row.';
-- deployment-mode: maintenance
-- Add an optional, revision-fenced command resource policy to each Connected
-- Machine enrollment. NULL remains the unrestricted product default. New
-- control planes may write the policy while old runners are still present;
-- runtime capability gating fails commands closed until an enforcing runner is
-- authoritative. Pre-feature control-plane workers must not overlap this release:
-- they do not read the desired columns and could dispatch a command without them.
-- Rollback to one of those binaries requires every desired limit to be cleared
-- under the same maintenance fence first.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

ALTER TABLE enrollments
  ADD COLUMN operation_memory_max_bytes bigint,
  ADD COLUMN operation_memory_high_bytes bigint,
  ADD COLUMN operation_cpu_max_millicores bigint,
  ADD COLUMN operation_policy_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN operation_policy_updated_at timestamptz,
  ADD CONSTRAINT enrollments_operation_memory_max_shape_chk CHECK (
    operation_memory_max_bytes IS NULL OR (
      operation_memory_max_bytes > 0
      AND operation_memory_max_bytes <= 9007199254740991
    )
  ),
  ADD CONSTRAINT enrollments_operation_memory_high_shape_chk CHECK (
    operation_memory_high_bytes IS NULL OR (
      operation_memory_high_bytes > 0
      AND operation_memory_high_bytes <= 9007199254740991
    )
  ),
  ADD CONSTRAINT enrollments_operation_memory_order_chk CHECK (
    operation_memory_max_bytes IS NULL
    OR operation_memory_high_bytes IS NULL
    OR operation_memory_high_bytes <= operation_memory_max_bytes
  ),
  -- Positive uint32 millicores. The runner chooses a cgroup-v2 period within the
  -- kernel ABI that represents every accepted value exactly (no silent rounding).
  ADD CONSTRAINT enrollments_operation_cpu_shape_chk CHECK (
    operation_cpu_max_millicores IS NULL
    OR operation_cpu_max_millicores BETWEEN 1 AND 4294967295
  ),
  ADD CONSTRAINT enrollments_operation_policy_revision_chk CHECK (
    operation_policy_revision >= 0
  );

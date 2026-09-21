-- deployment-mode: rolling
-- Retain the cadence clock independently of an in-flight capture claim or a
-- successful archive. Failed provider attempts must not re-pause the workspace
-- on every heartbeat. Nullable expansion is compatible with old readers.
ALTER TABLE sandbox_leases
  ADD COLUMN archive_capture_last_attempt_at timestamptz;
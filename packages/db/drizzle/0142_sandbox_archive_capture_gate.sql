-- deployment-mode: maintenance
-- A provider-native workspace snapshot pauses the Modal container while it is
-- captured. The previous generation preflight prevented a stale snapshot from
-- being published, but it did not prevent a new provider command from being
-- admitted after preflight and rejected by Modal while the container was
-- paused. Activate one durable lease-local capture gate that both snapshot
-- paths claim before provider I/O and every holder/mutation path honors.
--
-- Old application workers do not honor this gate. Stop every opengeni_app
-- session before activation and never restart a pre-0142 image afterward.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

DO $maintenance_preflight_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'sandbox archive-capture gate activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_preflight_guard$;

LOCK TABLE sandbox_leases IN ACCESS EXCLUSIVE MODE;

DO $maintenance_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'sandbox archive-capture gate activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_guard$;

ALTER TABLE sandbox_leases
  ADD COLUMN archive_capture_id uuid,
  ADD COLUMN archive_capture_generation integer,
  ADD COLUMN archive_capture_started_at timestamptz,
  ADD COLUMN archive_capture_deadline_at timestamptz;

ALTER TABLE sandbox_leases
  ADD CONSTRAINT sandbox_leases_archive_capture_check
  CHECK (
    (
      archive_capture_id IS NULL
      AND archive_capture_generation IS NULL
      AND archive_capture_started_at IS NULL
      AND archive_capture_deadline_at IS NULL
    )
    OR
    (
      archive_capture_id IS NOT NULL
      AND archive_capture_generation IS NOT NULL
      AND archive_capture_generation = workspace_generation
      AND archive_capture_started_at IS NOT NULL
      AND archive_capture_deadline_at > archive_capture_started_at
    )
  );

CREATE INDEX sandbox_leases_archive_capture_deadline_idx
  ON sandbox_leases (archive_capture_deadline_at, id)
  WHERE archive_capture_id IS NOT NULL;

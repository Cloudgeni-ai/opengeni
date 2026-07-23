-- deployment-mode: rolling
-- Migration 0097 installs lineage capture before its outbox producers become
-- visible, and its NOT VALID constraint rejects every later session-scoped row
-- without a captured root. Validate that invariant online without rewriting
-- durable export history. Any unexpected legacy gap fails closed for explicit
-- operator disposition instead of guessing lineage from mutable current data.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'host_export_outbox_root_session_check'
      AND conrelid = 'host_export_outbox'::regclass
  ) THEN
    ALTER TABLE "host_export_outbox"
      ADD CONSTRAINT "host_export_outbox_root_session_check"
      CHECK ("session_id" IS NULL OR "root_session_id" IS NOT NULL)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE "host_export_outbox"
  VALIDATE CONSTRAINT "host_export_outbox_root_session_check";

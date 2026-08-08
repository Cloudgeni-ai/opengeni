-- deployment-mode: rolling
-- Distinguish a known provider success whose bytes could not be retained from
-- an ambiguous provider request. Both remain non-replayable.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "image_generation_operations"
  DROP CONSTRAINT "image_generation_operations_status_chk",
  DROP CONSTRAINT "image_generation_operations_state_chk",
  ADD CONSTRAINT "image_generation_operations_status_chk"
    CHECK ("status" IN ('prepared', 'provider_started', 'completed', 'outcome_unknown', 'retention_failed')) NOT VALID,
  ADD CONSTRAINT "image_generation_operations_state_chk"
    CHECK (
      ("status" = 'prepared' AND "provider_started_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" IN ('provider_started', 'outcome_unknown', 'retention_failed') AND "provider_started_at" IS NOT NULL AND "completed_at" IS NULL)
      OR ("status" = 'completed' AND "provider_started_at" IS NOT NULL AND "completed_at" IS NOT NULL)
    ) NOT VALID;

-- Validation uses a weaker lock than adding an immediately-valid check, so a
-- large operations table remains writable during the scan.
ALTER TABLE "image_generation_operations"
  VALIDATE CONSTRAINT "image_generation_operations_status_chk";
ALTER TABLE "image_generation_operations"
  VALIDATE CONSTRAINT "image_generation_operations_state_chk";

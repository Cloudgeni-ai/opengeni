-- deployment-mode: rolling
-- Validate 0968's credit check over existing rows. Validation takes a weaker
-- lock than adding an immediately valid check, so the operations table stays
-- writable during the scan; every existing row holds the unpriced defaults.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "image_generation_operations"
  VALIDATE CONSTRAINT "image_generation_operations_credit_chk";

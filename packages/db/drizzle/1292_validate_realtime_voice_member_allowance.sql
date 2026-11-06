-- deployment-mode: rolling
-- Validate the receipt constraints 1290 replaced NOT VALID. Every existing row
-- satisfies the widened definitions, and VALIDATE takes only SHARE UPDATE
-- EXCLUSIVE, so receipts keep being written while it scans.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE opengeni_private.usage_allowance_attribution_receipts
  VALIDATE CONSTRAINT usage_attribution_source_kind;
ALTER TABLE opengeni_private.usage_allowance_attribution_receipts
  VALIDATE CONSTRAINT usage_attribution_source_shape;

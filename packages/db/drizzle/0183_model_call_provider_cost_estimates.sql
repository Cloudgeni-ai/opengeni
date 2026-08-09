-- deployment-mode: rolling
-- Preserve the captured provider-rate comparison separately from the OpenGeni
-- credit price. Existing facts remain unknown rather than being rewritten with
-- today's rates or incorrectly treating credit markup as provider cost.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "model_call_facts"
  ADD COLUMN IF NOT EXISTS "estimated_provider_cost_micros" bigint,
  ADD COLUMN IF NOT EXISTS "pricing_source" text;

ALTER TABLE "model_call_facts"
  DROP CONSTRAINT IF EXISTS "model_call_facts_estimated_provider_cost_check",
  ADD CONSTRAINT "model_call_facts_estimated_provider_cost_check"
    CHECK (
      "estimated_provider_cost_micros" IS NULL
      OR "estimated_provider_cost_micros" >= 0
    ) NOT VALID;

ALTER TABLE "model_call_facts"
  VALIDATE CONSTRAINT "model_call_facts_estimated_provider_cost_check";

ALTER TABLE "model_call_facts"
  DROP CONSTRAINT IF EXISTS "model_call_facts_pricing_source_check",
  ADD CONSTRAINT "model_call_facts_pricing_source_check"
    CHECK (
      ("estimated_provider_cost_micros" IS NULL AND "pricing_source" IS NULL)
      OR (
        "estimated_provider_cost_micros" IS NOT NULL
        AND "pricing_source" IN ('configured_list_price', 'gateway_reported')
      )
    ) NOT VALID;

ALTER TABLE "model_call_facts"
  VALIDATE CONSTRAINT "model_call_facts_pricing_source_check";

RESET statement_timeout;
RESET lock_timeout;
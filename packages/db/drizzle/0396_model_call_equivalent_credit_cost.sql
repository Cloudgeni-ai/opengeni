-- deployment-mode: rolling
-- Preserve the hypothetical OpenGeni credit price separately from both the
-- upstream provider estimate and the amount actually priced to credits.
-- Historical external facts remain unknown rather than being recomputed with
-- today's margin or provider rates.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "model_call_facts"
  ADD COLUMN IF NOT EXISTS "equivalent_credit_cost_micros" bigint;

ALTER TABLE "model_call_facts"
  DROP CONSTRAINT IF EXISTS "model_call_facts_equivalent_credit_cost_check",
  ADD CONSTRAINT "model_call_facts_equivalent_credit_cost_check"
    CHECK (
      "equivalent_credit_cost_micros" IS NULL
      OR (
        "equivalent_credit_cost_micros" >= 0
        AND "estimated_provider_cost_micros" IS NOT NULL
      )
    ) NOT VALID;

ALTER TABLE "model_call_facts"
  VALIDATE CONSTRAINT "model_call_facts_equivalent_credit_cost_check";

RESET statement_timeout;
RESET lock_timeout;

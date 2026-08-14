-- deployment-mode: rolling
-- Persist the existing content-free Company Brain contribution estimate beside
-- each authoritative model-call fact so Workspace Insights can report it.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "model_call_facts"
  ADD COLUMN IF NOT EXISTS "context_contributions" jsonb;

ALTER TABLE "model_call_facts"
  DROP CONSTRAINT IF EXISTS "model_call_facts_context_contributions_check",
  ADD CONSTRAINT "model_call_facts_context_contributions_check"
  CHECK (
    "context_contributions" IS NULL OR (
      jsonb_typeof("context_contributions") = 'array'
      AND octet_length("context_contributions"::text) <= 8192
    )
  ) NOT VALID;

ALTER TABLE "model_call_facts"
  VALIDATE CONSTRAINT "model_call_facts_context_contributions_check";

-- deployment-mode: rolling
-- Opengeni-credit funding for adapter image generation. A priced operation
-- freezes its customer price and the turn's chat model (whose plan and trial
-- grants may pay) at admission, and is debited once, in the same transaction
-- that makes its image ready; a failed or ambiguous request is never charged.
-- Existing rows and previous binaries keep the unpriced defaults, and a
-- previous binary can never complete a priced operation without its debit
-- because the credit check rejects that state.
-- The check is enforced for every new write at once; 0969 validates existing
-- rows separately so this file's table lock is not held during the scan.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "image_generation_operations"
  ADD COLUMN "priced_cost_micros" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "credit_state" text NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN "credit_usage_model_id" text,
  ADD CONSTRAINT "image_generation_operations_credit_chk"
    CHECK (
      ("priced_cost_micros" = 0 AND "credit_state" = 'not_applicable'
        AND "credit_usage_model_id" IS NULL)
      OR ("priced_cost_micros" BETWEEN 1 AND 1000000000
        AND ("credit_usage_model_id" IS NULL
          OR octet_length("credit_usage_model_id") BETWEEN 1 AND 256)
        AND (("credit_state" = 'pending' AND "status" <> 'completed')
          OR ("credit_state" = 'debited' AND "status" = 'completed')))
    ) NOT VALID;

-- deployment-mode: rolling
-- Add connected SuperGrok as a zero-credit, credential-frozen video route.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE "workspace_video_generation_policies"
  DROP CONSTRAINT "workspace_video_generation_policies_funding_source_chk";
ALTER TABLE "workspace_video_generation_policies"
  ADD CONSTRAINT "workspace_video_generation_policies_funding_source_chk"
  CHECK ("funding_source" IN ('opengeni_credits', 'workspace_gateway', 'supergrok_subscription'))
  NOT VALID;

ALTER TABLE "video_generation_operations"
  DROP CONSTRAINT "video_generation_operations_funding_state_chk",
  DROP CONSTRAINT "video_generation_operations_funding_values_chk";
ALTER TABLE "video_generation_operations"
  ADD CONSTRAINT "video_generation_operations_funding_state_chk" CHECK (
    ("funding_source" = 'workspace_gateway'
      AND "connection_id" IS NOT NULL
      AND "priced_cost_micros" = 0
      AND "credit_state" = 'not_applicable')
    OR ("funding_source" = 'opengeni_credits'
      AND "connection_id" IS NULL
      AND (("priced_cost_micros" = 0 AND "credit_state" = 'not_applicable')
        OR ("priced_cost_micros" > 0
          AND ((("status" IN ('provider_failed','cancelled_before_submit','outcome_unknown','retention_failed'))
                AND "credit_state" = 'refunded')
            OR (("status" NOT IN ('provider_failed','cancelled_before_submit','outcome_unknown','retention_failed'))
                AND "credit_state" = 'debited')))))
    OR ("funding_source" = 'supergrok_subscription'
      AND "connection_id" IS NULL
      AND "priced_cost_micros" = 0
      AND "credit_state" = 'not_applicable')
  ) NOT VALID,
  ADD CONSTRAINT "video_generation_operations_funding_values_chk" CHECK (
    "funding_source" IN ('opengeni_credits', 'workspace_gateway', 'supergrok_subscription')
    AND "priced_cost_micros" BETWEEN 0 AND 1000000000
    AND "credit_state" IN ('not_applicable', 'debited', 'refunded')
  ) NOT VALID;

ALTER TABLE "workspace_video_generation_policies"
  VALIDATE CONSTRAINT "workspace_video_generation_policies_funding_source_chk";
ALTER TABLE "video_generation_operations"
  VALIDATE CONSTRAINT "video_generation_operations_funding_state_chk";
ALTER TABLE "video_generation_operations"
  VALIDATE CONSTRAINT "video_generation_operations_funding_values_chk";

RESET statement_timeout;
RESET lock_timeout;

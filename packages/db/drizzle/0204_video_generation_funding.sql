-- deployment-mode: rolling
-- Add one frozen funding choice to the existing durable video operation.
-- Existing rows retain the original workspace-Gateway behavior.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "workspace_video_generation_policies"
  ADD COLUMN "funding_source" text NOT NULL DEFAULT 'workspace_gateway';
ALTER TABLE "workspace_video_generation_policies"
  ADD CONSTRAINT "workspace_video_generation_policies_funding_source_chk"
  CHECK ("funding_source" IN ('opengeni_credits', 'workspace_gateway')) NOT VALID;
ALTER TABLE "workspace_video_generation_policies"
  VALIDATE CONSTRAINT "workspace_video_generation_policies_funding_source_chk";

ALTER TABLE "video_generation_operations"
  ADD COLUMN "funding_source" text NOT NULL DEFAULT 'workspace_gateway',
  ADD COLUMN "priced_cost_micros" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "credit_state" text NOT NULL DEFAULT 'not_applicable';
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
          AND (("status" IN ('provider_failed','cancelled_before_submit','outcome_unknown','retention_failed')
                AND "credit_state" = 'refunded')
            OR ("status" NOT IN ('provider_failed','cancelled_before_submit','outcome_unknown','retention_failed')
                AND "credit_state" = 'debited')))))
  ) NOT VALID;
ALTER TABLE "video_generation_operations"
  ADD CONSTRAINT "video_generation_operations_funding_values_chk" CHECK (
    "funding_source" IN ('opengeni_credits', 'workspace_gateway')
    AND "priced_cost_micros" BETWEEN 0 AND 1000000000
    AND "credit_state" IN ('not_applicable', 'debited', 'refunded')
  ) NOT VALID;
ALTER TABLE "video_generation_operations"
  VALIDATE CONSTRAINT "video_generation_operations_funding_state_chk";
ALTER TABLE "video_generation_operations"
  VALIDATE CONSTRAINT "video_generation_operations_funding_values_chk";

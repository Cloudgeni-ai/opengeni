-- deployment-mode: rolling
-- Persist the exact running Connected Machine build/capabilities and one
-- authoritative self-update state. Progress is fenced to the process connection
-- generation that accepted it; completion is confirmed by the successor Hello.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE "enrollments"
  ADD COLUMN "agent_version" text,
  ADD COLUMN "agent_binary_sha256" text,
  ADD COLUMN "agent_update_channel" text,
  ADD COLUMN "agent_capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "agent_update_operation_id" uuid,
  ADD COLUMN "agent_update_status" text,
  ADD COLUMN "agent_update_target_version" text,
  ADD COLUMN "agent_update_expected_binary_sha256" text,
  ADD COLUMN "agent_update_error_code" text,
  ADD COLUMN "agent_update_retryable" boolean NOT NULL DEFAULT false,
  ADD COLUMN "agent_update_rolled_back" boolean NOT NULL DEFAULT false,
  ADD COLUMN "agent_update_connection_instance_id" text,
  ADD COLUMN "agent_update_connection_generation" integer,
  ADD COLUMN "agent_update_requested_at" timestamptz,
  ADD COLUMN "agent_update_updated_at" timestamptz,
  ADD COLUMN "agent_update_completed_at" timestamptz;

ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_agent_binary_sha256_chk" CHECK (
    "agent_binary_sha256" IS NULL OR "agent_binary_sha256" ~ '^[0-9a-f]{64}$'
  ) NOT VALID,
  ADD CONSTRAINT "enrollments_agent_update_channel_chk" CHECK (
    "agent_update_channel" IS NULL OR "agent_update_channel" IN ('stable', 'beta')
  ) NOT VALID,
  ADD CONSTRAINT "enrollments_agent_update_expected_binary_sha256_chk" CHECK (
    "agent_update_expected_binary_sha256" IS NULL
      OR "agent_update_expected_binary_sha256" ~ '^[0-9a-f]{64}$'
  ) NOT VALID,
  ADD CONSTRAINT "enrollments_agent_update_state_shape_chk" CHECK (
    ("agent_update_operation_id" IS NULL
      AND "agent_update_status" IS NULL
      AND "agent_update_target_version" IS NULL
      AND "agent_update_connection_instance_id" IS NULL
      AND "agent_update_connection_generation" IS NULL
      AND "agent_update_requested_at" IS NULL
      AND "agent_update_updated_at" IS NULL)
    OR
    ("agent_update_operation_id" IS NOT NULL
      AND "agent_update_status" IN (
        'requested', 'accepted', 'waiting_for_idle', 'downloading', 'verifying',
        'applying', 'restarting', 'succeeded', 'failed'
      )
      AND "agent_update_target_version" IS NOT NULL
      AND "agent_update_connection_instance_id" IS NOT NULL
      AND "agent_update_connection_generation" IS NOT NULL
      AND "agent_update_connection_generation" >= 0
      AND "agent_update_requested_at" IS NOT NULL
      AND "agent_update_updated_at" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "enrollments"
  VALIDATE CONSTRAINT "enrollments_agent_binary_sha256_chk";
ALTER TABLE "enrollments"
  VALIDATE CONSTRAINT "enrollments_agent_update_channel_chk";
ALTER TABLE "enrollments"
  VALIDATE CONSTRAINT "enrollments_agent_update_expected_binary_sha256_chk";
ALTER TABLE "enrollments"
  VALIDATE CONSTRAINT "enrollments_agent_update_state_shape_chk";

RESET statement_timeout;
RESET lock_timeout;

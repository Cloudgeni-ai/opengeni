-- deployment-mode: rolling
-- Fence each Connected Machine to one live runner instance. The credential
-- generation proves enrollment authority; this independent connection lease
-- prevents two processes holding the same still-valid credential from sharing
-- one RPC subject and receiving work nondeterministically.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE "enrollments"
  ADD COLUMN "connection_instance_id" text,
  ADD COLUMN "connection_generation" integer NOT NULL DEFAULT 0,
  ADD COLUMN "connection_lease_expires_at" timestamptz,
  ADD COLUMN "connection_duplicate_denied_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "connection_duplicate_denied_at" timestamptz;

ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_connection_authority_shape_chk" CHECK (
    ("connection_instance_id" IS NULL AND "connection_lease_expires_at" IS NULL)
    OR ("connection_instance_id" IS NOT NULL
      AND length("connection_instance_id") BETWEEN 1 AND 128
      AND "connection_lease_expires_at" IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT "enrollments_connection_generation_chk" CHECK (
    "connection_generation" >= 0
  ) NOT VALID,
  ADD CONSTRAINT "enrollments_connection_duplicate_denied_count_chk" CHECK (
    "connection_duplicate_denied_count" >= 0
  ) NOT VALID;

ALTER TABLE "enrollments"
  VALIDATE CONSTRAINT "enrollments_connection_authority_shape_chk";
ALTER TABLE "enrollments"
  VALIDATE CONSTRAINT "enrollments_connection_generation_chk";
ALTER TABLE "enrollments"
  VALIDATE CONSTRAINT "enrollments_connection_duplicate_denied_count_chk";

RESET statement_timeout;
RESET lock_timeout;

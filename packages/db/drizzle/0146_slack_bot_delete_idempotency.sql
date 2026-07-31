-- deployment-mode: rolling
-- Slack chat.delete has no provider idempotency key. Persist the exact tenant,
-- principal, connection, tool, target, and protected request digest before the
-- mutation; an abandoned provider_started claim becomes outcome_unknown and is
-- reconciled before another delete is admitted.
--
-- This migration originally landed as 0141 after 0142 was already deployed.
-- Never rewrite that production history. A staging database may have applied
-- the withdrawn 0141 name before the ordering defect was caught; only that
-- exact committed legacy receipt may make an existing table idempotent here.

DO $migration$
BEGIN
  IF to_regclass('slack_bot_delete_operations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM "schema_migrations"
       WHERE "name" = '0141_slack_bot_delete_idempotency.sql'
     )
  THEN
    RAISE EXCEPTION
      'slack_bot_delete_operations exists without the exact withdrawn 0141 migration receipt';
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS "slack_bot_delete_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "principal_type" text NOT NULL,
  "principal_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "channel_id" text NOT NULL,
  "message_timestamp" text NOT NULL,
  "request_digest" text NOT NULL,
  "status" text NOT NULL,
  "claim_holder_id" uuid,
  "claim_expires_at" timestamptz,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_failure_code" text,
  "slack_channel_id" text,
  "slack_message_timestamp" text,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_bot_delete_operations_workspace_operation_uq"
    UNIQUE ("workspace_id", "operation_id"),
  CONSTRAINT "slack_bot_delete_operations_principal_check"
    CHECK (
      "principal_type" IN ('subject', 'service')
      AND length("principal_id") BETWEEN 1 AND 512
    ),
  CONSTRAINT "slack_bot_delete_operations_identity_check"
    CHECK (
      "tool_name" = 'slack_bot_delete_message'
      AND length("channel_id") BETWEEN 1 AND 64
      AND length("message_timestamp") BETWEEN 1 AND 64
      AND "request_digest" ~ '^[0-9a-f]{64}$'
      AND "attempt_count" > 0
      AND (("claim_holder_id" IS NULL) = ("claim_expires_at" IS NULL))
    ),
  CONSTRAINT "slack_bot_delete_operations_status_check"
    CHECK ("status" IN ('pending', 'provider_started', 'outcome_unknown', 'completed')),
  CONSTRAINT "slack_bot_delete_operations_completion_check"
    CHECK (
      (
        "status" <> 'completed'
        AND "slack_channel_id" IS NULL
        AND "slack_message_timestamp" IS NULL
        AND "completed_at" IS NULL
      )
      OR (
        "status" = 'completed'
        AND "claim_holder_id" IS NULL
        AND "claim_expires_at" IS NULL
        AND "slack_channel_id" IS NOT NULL
        AND "slack_message_timestamp" IS NOT NULL
        AND "completed_at" IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS "slack_bot_delete_operations_workspace_status_idx"
  ON "slack_bot_delete_operations" ("workspace_id", "status", "updated_at");

ALTER TABLE "slack_bot_delete_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_bot_delete_operations" FORCE ROW LEVEL SECURITY;
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = 'slack_bot_delete_operations'::regclass
      AND polname = 'workspace_isolation'
  )
  THEN
    CREATE POLICY workspace_isolation ON "slack_bot_delete_operations"
      USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
      WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
  END IF;
END
$migration$;

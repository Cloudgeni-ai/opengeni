-- deployment-mode: rolling

ALTER TABLE "slack_interactions"
  ADD COLUMN "initiating_slack_user_id" text;

ALTER TABLE "slack_interaction_inbox"
  DROP CONSTRAINT "slack_interaction_inbox_trigger_check";

ALTER TABLE "slack_interaction_inbox"
  ADD CONSTRAINT "slack_interaction_inbox_trigger_check"
  CHECK (
    "trigger_kind" IN (
      'app_mention', 'dm', 'reaction', 'slash_command',
      'message_shortcut', 'thread_reply', 'block_action'
    )
  ) NOT VALID;

ALTER TABLE "slack_interaction_inbox"
  VALIDATE CONSTRAINT "slack_interaction_inbox_trigger_check";

ALTER TABLE "slack_interactions"
  ADD CONSTRAINT "slack_interactions_initiating_user_check"
  CHECK (
    "initiating_slack_user_id" IS NULL
    OR octet_length("initiating_slack_user_id") BETWEEN 1 AND 64
  ) NOT VALID;

ALTER TABLE "slack_interactions"
  VALIDATE CONSTRAINT "slack_interactions_initiating_user_check";

CREATE TABLE "slack_interaction_action_handles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "interaction_id" uuid NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "session_event_sequence" integer NOT NULL,
  "action_kind" text NOT NULL,
  "action_key" text NOT NULL,
  "target_id" text,
  "target_value" text,
  "authorized_subject_id" text NOT NULL,
  "authorized_slack_user_id" text NOT NULL,
  "message_operation_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "result" text,
  "expires_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_interaction_action_handles_interaction_fk"
    FOREIGN KEY ("account_id", "workspace_id", "interaction_id")
    REFERENCES "slack_interactions"("account_id", "workspace_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "slack_interaction_action_handles_identity_uq"
    UNIQUE ("interaction_id", "session_event_sequence", "action_key"),
  CONSTRAINT "slack_interaction_action_handles_bounds_check" CHECK (
    "session_event_sequence" >= 0
    AND octet_length("action_kind") BETWEEN 1 AND 64
    AND octet_length("action_key") BETWEEN 1 AND 512
    AND ("target_id" IS NULL OR octet_length("target_id") BETWEEN 1 AND 512)
    AND ("target_value" IS NULL OR octet_length("target_value") BETWEEN 1 AND 1024)
    AND octet_length("authorized_subject_id") BETWEEN 1 AND 512
    AND octet_length("authorized_slack_user_id") BETWEEN 1 AND 64
    AND "action_kind" IN (
      'approval_approve', 'approval_reject', 'human_input_select',
      'human_input_skip', 'session_status', 'session_pause', 'session_resume'
    )
    AND "status" IN ('pending', 'completed', 'stale')
    AND ("result" IS NULL OR octet_length("result") BETWEEN 1 AND 64)
    AND (
      ("status" = 'pending' AND "result" IS NULL AND "completed_at" IS NULL)
      OR ("status" IN ('completed', 'stale') AND "result" IS NOT NULL AND "completed_at" IS NOT NULL)
    )
  )
);

CREATE INDEX "slack_interaction_action_handles_pending_idx"
  ON "slack_interaction_action_handles" ("workspace_id", "status", "expires_at", "id");

CREATE TABLE "slack_bot_update_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "slack_channel_id" text NOT NULL,
  "slack_message_timestamp" text NOT NULL,
  "request_digest" text NOT NULL,
  "status" text NOT NULL,
  "claim_holder_id" uuid,
  "claim_expires_at" timestamptz,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_failure_code" text,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_bot_update_operations_workspace_operation_uq"
    UNIQUE ("workspace_id", "connection_id", "operation_id"),
  CONSTRAINT "slack_bot_update_operations_bounds_check" CHECK (
    octet_length("slack_channel_id") BETWEEN 1 AND 64
    AND octet_length("slack_message_timestamp") BETWEEN 1 AND 64
    AND "request_digest" ~ '^[0-9a-f]{64}$'
    AND "status" IN ('provider_started', 'completed')
    AND "attempt_count" > 0
    AND (("claim_holder_id" IS NULL) = ("claim_expires_at" IS NULL))
    AND (
      ("status" = 'provider_started' AND "completed_at" IS NULL)
      OR (
        "status" = 'completed'
        AND "claim_holder_id" IS NULL
        AND "claim_expires_at" IS NULL
        AND "completed_at" IS NOT NULL
      )
    )
  )
);

CREATE INDEX "slack_bot_update_operations_workspace_status_idx"
  ON "slack_bot_update_operations" ("workspace_id", "status", "updated_at");

ALTER TABLE "slack_interaction_action_handles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_interaction_action_handles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_bot_update_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_bot_update_operations" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "slack_interaction_action_handles"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

CREATE POLICY workspace_isolation ON "slack_bot_update_operations"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "slack_interaction_action_handles",
      "slack_bot_update_operations"
    TO opengeni_app;
  END IF;
END
$$;

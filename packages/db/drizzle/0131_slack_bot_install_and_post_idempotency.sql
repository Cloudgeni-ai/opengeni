-- deployment-mode: rolling
-- New readers trust only dedicated-route Slack installs whose server marker
-- matches the exact credential version. Existing rows and rows created by old
-- generic API pods remain markerless and fail closed. The trigger also clears a
-- marker if a rolling old writer mutates credential/identity fields without a
-- fresh verification in that same statement.

ALTER TABLE "connections"
  ADD COLUMN IF NOT EXISTS "verified_install_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "verified_install_version" integer;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'connections_verified_install_check'
      AND conrelid = 'connections'::regclass
  ) THEN
    ALTER TABLE "connections"
      ADD CONSTRAINT "connections_verified_install_check"
      CHECK (
        (
          "verified_install_at" IS NULL
          AND "verified_install_version" IS NULL
        )
        OR (
          "verified_install_at" IS NOT NULL
          AND "verified_install_version" = "version"
          AND "verified_install_version" > 0
          AND "subject_id" IS NULL
          AND "provider_domain" = 'slack.com'
          AND "kind" = 'app_install'
        )
      );
  END IF;
END $constraint$;

CREATE OR REPLACE FUNCTION opengeni_private.invalidate_stale_verified_install()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF (
    NEW."subject_id" IS DISTINCT FROM OLD."subject_id"
    OR NEW."provider_domain" IS DISTINCT FROM OLD."provider_domain"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."credential_encrypted" IS DISTINCT FROM OLD."credential_encrypted"
    OR NEW."granted_scopes" IS DISTINCT FROM OLD."granted_scopes"
    OR NEW."metadata" IS DISTINCT FROM OLD."metadata"
    OR NEW."version" IS DISTINCT FROM OLD."version"
  )
  AND NEW."verified_install_at" IS NOT DISTINCT FROM OLD."verified_install_at"
  AND NEW."verified_install_version" IS NOT DISTINCT FROM OLD."verified_install_version"
  THEN
    NEW."verified_install_at" := NULL;
    NEW."verified_install_version" := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS connections_invalidate_stale_verified_install ON "connections";
CREATE TRIGGER connections_invalidate_stale_verified_install
  BEFORE UPDATE OF
    "subject_id", "provider_domain", "kind", "credential_encrypted",
    "granted_scopes", "metadata", "version",
    "verified_install_at", "verified_install_version"
  ON "connections"
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.invalidate_stale_verified_install();

CREATE TABLE "slack_bot_post_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "client_message_id" uuid NOT NULL,
  "target_kind" text NOT NULL,
  "target_id" text NOT NULL,
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
  CONSTRAINT "slack_bot_post_operations_workspace_operation_uq"
    UNIQUE ("workspace_id", "connection_id", "operation_id"),
  CONSTRAINT "slack_bot_post_operations_target_kind_check"
    CHECK ("target_kind" IN ('channel', 'user')),
  CONSTRAINT "slack_bot_post_operations_status_check"
    CHECK ("status" IN ('provider_started', 'completed')),
  CONSTRAINT "slack_bot_post_operations_identity_check"
    CHECK (
      "client_message_id" = "operation_id"
      AND length("target_id") BETWEEN 1 AND 64
      AND "request_digest" ~ '^[0-9a-f]{64}$'
      AND "attempt_count" > 0
      AND (("claim_holder_id" IS NULL) = ("claim_expires_at" IS NULL))
    ),
  CONSTRAINT "slack_bot_post_operations_completion_check"
    CHECK (
      (
        "status" = 'provider_started'
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

CREATE INDEX "slack_bot_post_operations_workspace_status_idx"
  ON "slack_bot_post_operations" ("workspace_id", "status", "updated_at");

ALTER TABLE "slack_bot_post_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_bot_post_operations" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "slack_bot_post_operations"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
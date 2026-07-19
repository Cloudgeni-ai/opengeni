-- deployment-mode: maintenance
-- OPE-24: trustworthy Codex subscription overview, allocator OCC/audit, and
-- owning-human reset-credit redemption.
--
-- Old API binaries do not write connected_by_subject_id and do not fence
-- disconnect/reconnect against unresolved provider attempts. Drain every old
-- API replica before applying this migration, then start only this revision;
-- mixed-version writers would invalidate the owning-human redemption boundary.
--
-- OPE-21 exclusively owns allocator_enabled in migration 0053. This migration
-- only adds the independent OCC/audit fields, provider summary cache, connecting
-- human attribution, and the durable ambiguity-safe redemption state machine.

ALTER TABLE "codex_subscription_credentials"
  ADD COLUMN IF NOT EXISTS "allocator_version" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "allocator_updated_by_subject_id" text,
  ADD COLUMN IF NOT EXISTS "allocator_updated_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "reset_credit_available_count" integer,
  ADD COLUMN IF NOT EXISTS "reset_credits_checked_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "connected_by_subject_id" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'codex_subscription_credentials_allocator_version_check'
      AND conrelid = 'codex_subscription_credentials'::regclass
  ) THEN
    ALTER TABLE "codex_subscription_credentials"
      ADD CONSTRAINT "codex_subscription_credentials_allocator_version_check"
      CHECK (allocator_version > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'codex_subscription_credentials_reset_count_check'
      AND conrelid = 'codex_subscription_credentials'::regclass
  ) THEN
    ALTER TABLE "codex_subscription_credentials"
      ADD CONSTRAINT "codex_subscription_credentials_reset_count_check"
      CHECK (reset_credit_available_count IS NULL OR reset_credit_available_count >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'codex_subscription_credentials_human_owner_check'
      AND conrelid = 'codex_subscription_credentials'::regclass
  ) THEN
    ALTER TABLE "codex_subscription_credentials"
      ADD CONSTRAINT "codex_subscription_credentials_human_owner_check"
      CHECK (connected_by_subject_id IS NULL OR connected_by_subject_id LIKE 'user:_%') NOT VALID;
  END IF;
END $$;

ALTER TABLE "codex_subscription_credentials"
  VALIDATE CONSTRAINT "codex_subscription_credentials_allocator_version_check";
ALTER TABLE "codex_subscription_credentials"
  VALIDATE CONSTRAINT "codex_subscription_credentials_reset_count_check";
ALTER TABLE "codex_subscription_credentials"
  VALIDATE CONSTRAINT "codex_subscription_credentials_human_owner_check";

CREATE TABLE IF NOT EXISTS "codex_reset_redemption_attempts" (
  -- Browser-generated logical id. Reusing it is what prevents one ambiguous
  -- click/reload/retry from becoming a second logical redemption.
  "id" uuid PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "credential_id" uuid NOT NULL,
  "subject_id" text NOT NULL,
  -- SHA-256 of the Better Auth session id. The raw session id and cookies never
  -- enter product tables, logs, audit metadata, or browser responses.
  "browser_session_hash" text NOT NULL,
  -- Required for an ambiguity retry. It is intentionally absent from audit and
  -- event metadata; provider opaque ids are not observability dimensions.
  "credit_id" text NOT NULL,
  -- Generated once by the server and reused for every upstream retry.
  "upstream_idempotency_key" uuid NOT NULL DEFAULT gen_random_uuid(),
  "status" text NOT NULL DEFAULT 'processing',
  "outcome" text,
  "claim_holder_id" uuid,
  "claim_expires_at" timestamptz,
  "confirmation_expires_at" timestamptz NOT NULL,
  "provider_started_at" timestamptz,
  "completed_at" timestamptz,
  "last_failure_kind" text,
  "retry_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "codex_reset_redemption_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id")
    ON DELETE CASCADE,
  -- Deliberately no credential FK: a disconnect must never cascade-delete the
  -- only durable upstream redeem_request_id after provider work may have begun.
  -- Accessors validate and lock the workspace credential before every send;
  -- completed history may outlive a later safe credential disconnect.
  CONSTRAINT "codex_reset_redemption_status_check"
    CHECK (status IN ('processing', 'provider_started', 'completed')),
  CONSTRAINT "codex_reset_redemption_outcome_check"
    CHECK (outcome IS NULL OR outcome IN ('reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed')),
  CONSTRAINT "codex_reset_redemption_completed_check"
    CHECK ((status = 'completed') = (outcome IS NOT NULL AND completed_at IS NOT NULL)),
  CONSTRAINT "codex_reset_redemption_retry_count_check"
    CHECK (retry_count >= 0),
  CONSTRAINT "codex_reset_redemption_human_subject_check"
    CHECK (subject_id LIKE 'user:_%')
);

-- Keep this additive/idempotent for forward recovery from a previously completed
-- equivalent schema state.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'codex_reset_redemption_human_subject_check'
      AND conrelid = 'codex_reset_redemption_attempts'::regclass
  ) THEN
    ALTER TABLE "codex_reset_redemption_attempts"
      ADD CONSTRAINT "codex_reset_redemption_human_subject_check"
      CHECK (subject_id LIKE 'user:_%') NOT VALID;
  END IF;
END $$;
ALTER TABLE "codex_reset_redemption_attempts"
  VALIDATE CONSTRAINT "codex_reset_redemption_human_subject_check";

CREATE UNIQUE INDEX IF NOT EXISTS "codex_reset_redemption_upstream_key_idx"
  ON "codex_reset_redemption_attempts" ("upstream_idempotency_key");
-- A provider credit can have only one active or successfully consumed logical
-- attempt. Provider outcomes nothingToReset/noCredit are explicitly non-success
-- outcomes and must not permanently prevent a later, newly confirmed attempt.
CREATE UNIQUE INDEX IF NOT EXISTS "codex_reset_redemption_credential_credit_idx"
  ON "codex_reset_redemption_attempts" ("workspace_id", "credential_id", "credit_id")
  WHERE status <> 'completed' OR outcome IN ('reset', 'alreadyRedeemed');
CREATE INDEX IF NOT EXISTS "codex_reset_redemption_workspace_credential_idx"
  ON "codex_reset_redemption_attempts" ("workspace_id", "credential_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "codex_reset_redemption_claim_expiry_idx"
  ON "codex_reset_redemption_attempts" ("claim_expires_at")
  WHERE status <> 'completed';

ALTER TABLE "codex_reset_redemption_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "codex_reset_redemption_attempts" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'codex_reset_redemption_attempts'
      AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "codex_reset_redemption_attempts";
  END IF;
END $$;

CREATE POLICY workspace_isolation ON "codex_reset_redemption_attempts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
DECLARE
  target_schema text := current_schema();
  app_role text := 'opengeni_app';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I',
      target_schema,
      app_role
    );
  END IF;
END $$;
-- 0028_codex_multi_account.sql
-- Multi-account P1: N Codex subscriptions per workspace + a per-workspace active
-- pointer + per-session pin/actual. Additive; relaxes (does not drop) uniqueness.
--
-- Runs under the runner's pg_advisory_lock(727458), so no app traffic observes
-- the relaxed window or the NO FORCE backfill window below.

-- 1. Per-account label/email metadata (plaintext, non-secret).
ALTER TABLE "codex_subscription_credentials" ADD COLUMN IF NOT EXISTS "label" text;
ALTER TABLE "codex_subscription_credentials" ADD COLUMN IF NOT EXISTS "account_email" text;

-- 2. Relax one-per-workspace -> one-per-(workspace, chatgpt account).
DROP INDEX IF EXISTS "codex_subscription_credentials_workspace_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "codex_subscription_credentials_ws_account_idx"
  ON "codex_subscription_credentials" ("workspace_id", "chatgpt_account_id")
  WHERE "chatgpt_account_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "codex_subscription_credentials_workspace_lookup_idx"
  ON "codex_subscription_credentials" ("workspace_id");

-- 3. Per-session pin + actual. FK ON DELETE SET NULL (degrade, never dangle/cascade).
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "codex_pinned_credential_id" uuid;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "codex_last_credential_id" uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_codex_pinned_credential_fk') THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_codex_pinned_credential_fk"
      FOREIGN KEY ("codex_pinned_credential_id")
      REFERENCES "codex_subscription_credentials"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_codex_last_credential_fk') THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_codex_last_credential_fk"
      FOREIGN KEY ("codex_last_credential_id")
      REFERENCES "codex_subscription_credentials"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- 4. The per-workspace active-pointer table (created WITHOUT force-rls yet).
CREATE TABLE IF NOT EXISTS "codex_rotation_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "active_credential_id" uuid
     REFERENCES "codex_subscription_credentials"("id") ON DELETE SET NULL,
  "rotation_enabled" boolean NOT NULL DEFAULT false,
  "rotation_strategy" text NOT NULL DEFAULT 'most_remaining',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "codex_rotation_settings_workspace_idx"
  ON "codex_rotation_settings" ("workspace_id");

-- 5. Backfill: every existing single credential becomes its workspace's ACTIVE
--    account. Reads a FORCE-RLS table as owner -> drop FORCE around it (precedent 0009).
ALTER TABLE "codex_subscription_credentials" NO FORCE ROW LEVEL SECURITY;
INSERT INTO "codex_rotation_settings" ("account_id", "workspace_id", "active_credential_id", "rotation_enabled")
SELECT c."account_id", c."workspace_id", c."id", false
FROM "codex_subscription_credentials" c
ON CONFLICT ("workspace_id") DO NOTHING;
UPDATE "codex_subscription_credentials" SET "label" = "plan_type"
  WHERE "label" IS NULL AND "plan_type" IS NOT NULL;  -- cosmetic seed; route backfills email on next connect
ALTER TABLE "codex_subscription_credentials" FORCE ROW LEVEL SECURITY;

-- 6. RLS on the new table — verbatim from 0024_codex_subscription_credentials.sql:31-44.
ALTER TABLE "codex_rotation_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "codex_rotation_settings" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'codex_rotation_settings' AND policyname = 'workspace_isolation') THEN
    DROP POLICY workspace_isolation ON "codex_rotation_settings";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "codex_rotation_settings"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- 7. Re-grant (verbatim from 0024:46-51).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;

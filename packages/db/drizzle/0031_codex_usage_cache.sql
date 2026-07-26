-- 0031_codex_usage_cache.sql
-- Multi-account P2: per-account usage cache columns on codex_subscription_credentials.
-- All five are PLAINTEXT metadata (used_percent + reset timing) snapshotted from
-- GET /wham/usage; they NEVER hold a token or any secret. RLS is row-level, so the
-- existing workspace_isolation policy already covers them — NO policy change.
-- Additive only (mirrors 0028's style). Runs under the runner's advisory lock.

ALTER TABLE "codex_subscription_credentials" ADD COLUMN IF NOT EXISTS "primary_used_percent" integer;
ALTER TABLE "codex_subscription_credentials" ADD COLUMN IF NOT EXISTS "primary_reset_at" timestamptz;
ALTER TABLE "codex_subscription_credentials" ADD COLUMN IF NOT EXISTS "secondary_used_percent" integer;
ALTER TABLE "codex_subscription_credentials" ADD COLUMN IF NOT EXISTS "secondary_reset_at" timestamptz;
ALTER TABLE "codex_subscription_credentials" ADD COLUMN IF NOT EXISTS "usage_checked_at" timestamptz;

-- Re-grant (verbatim from 0024:46-51 / 0028:79-85) so opengeni_app keeps DML on
-- the altered table after the column additions.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;

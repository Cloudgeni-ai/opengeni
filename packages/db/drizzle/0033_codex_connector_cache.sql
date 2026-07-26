-- 0033_codex_connector_cache.sql
-- Multi-account P4 (Part B): per-account connector-set cache on codex_subscription_credentials.
-- Both columns are PLAINTEXT metadata (the ORIGINAL-dotted connector namespaces the account
-- exposes via codex_apps, e.g. {github,gmail,linear}, plus a freshness clock); they NEVER hold a
-- token or any secret. The rotation ranker PREFERS (never requires) a target whose connector set
-- covers the leaving account's set, so a switch doesn't strand a session mid-connector. RLS is
-- row-level, so the existing workspace_isolation policy already covers them — NO policy change.
-- Both nullable (null ⇒ never probed = unknown to the ranker). Additive only (mirrors 0031/0032's
-- style). Runs under the runner's advisory lock.

ALTER TABLE "codex_subscription_credentials" ADD COLUMN IF NOT EXISTS "connector_namespaces" text[];
ALTER TABLE "codex_subscription_credentials" ADD COLUMN IF NOT EXISTS "connectors_checked_at" timestamptz;

-- Re-grant (verbatim from 0031/0032) so opengeni_app keeps DML on the altered table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;

-- Per-workspace ChatGPT/Codex subscription credentials.
--
-- One row per workspace. The secrets (access/refresh/id token) live INSIDE
-- credential_encrypted using the v1 AES-256-GCM envelope (environment-crypto.ts),
-- key = OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY — the same envelope used for
-- workspace environment variables. chatgpt_account_id / plan_type / scopes /
-- status are plaintext (request header + UI, non-secret). RLS enforces strict
-- per-workspace isolation, identical to workspace_environment_variables.

CREATE TABLE IF NOT EXISTS "codex_subscription_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "credential_encrypted" text NOT NULL,
  "chatgpt_account_id" text,
  "scopes" text,
  "plan_type" text,
  "is_fedramp" boolean NOT NULL DEFAULT false,
  "expires_at" timestamptz,
  "last_refresh_at" timestamptz,
  "status" text NOT NULL DEFAULT 'active',
  "last_error" text,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "codex_subscription_credentials_workspace_idx"
  ON "codex_subscription_credentials" ("workspace_id");

ALTER TABLE "codex_subscription_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "codex_subscription_credentials" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'codex_subscription_credentials' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "codex_subscription_credentials";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "codex_subscription_credentials"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;

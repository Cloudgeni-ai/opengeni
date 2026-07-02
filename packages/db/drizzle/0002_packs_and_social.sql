CREATE TABLE IF NOT EXISTS "pack_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "pack_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "enabled_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "pack_installations_workspace_pack_idx" ON "pack_installations" ("workspace_id", "pack_id");
CREATE INDEX IF NOT EXISTS "pack_installations_workspace_status_idx" ON "pack_installations" ("workspace_id", "status");
ALTER TABLE "pack_installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pack_installations" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'pack_installations' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "pack_installations";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "pack_installations"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE TABLE IF NOT EXISTS "social_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "account_handle" text NOT NULL,
  "account_name" text,
  "external_account_id" text,
  "status" text NOT NULL DEFAULT 'connected',
  "scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "credential_ref" text,
  "token_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_connections_workspace_provider_handle_idx" ON "social_connections" ("workspace_id", "provider", "account_handle");
CREATE INDEX IF NOT EXISTS "social_connections_workspace_provider_status_idx" ON "social_connections" ("workspace_id", "provider", "status");
ALTER TABLE "social_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_connections" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'social_connections' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "social_connections";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "social_connections"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE TABLE IF NOT EXISTS "social_posts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "social_connections"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "external_post_id" text,
  "url" text,
  "author_handle" text,
  "text" text NOT NULL,
  "published_at" timestamptz NOT NULL,
  "metrics" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "raw" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_posts_workspace_connection_external_post_idx" ON "social_posts" ("workspace_id", "connection_id", "external_post_id");
CREATE INDEX IF NOT EXISTS "social_posts_workspace_connection_published_idx" ON "social_posts" ("workspace_id", "connection_id", "published_at");
CREATE INDEX IF NOT EXISTS "social_posts_workspace_provider_published_idx" ON "social_posts" ("workspace_id", "provider", "published_at");
ALTER TABLE "social_posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_posts" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'social_posts' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "social_posts";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "social_posts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;

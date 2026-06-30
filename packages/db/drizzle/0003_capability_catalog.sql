CREATE TABLE IF NOT EXISTS "capability_catalog_items" (
  "id" text NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "source" text NOT NULL DEFAULT 'manual',
  "name" text NOT NULL,
  "description" text,
  "category" text NOT NULL DEFAULT 'custom',
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "homepage_url" text,
  "endpoint_url" text,
  "install_url" text,
  "auth_model" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "capability_catalog_items_workspace_capability_idx" ON "capability_catalog_items" ("workspace_id", "id");
CREATE INDEX IF NOT EXISTS "capability_catalog_items_workspace_kind_idx" ON "capability_catalog_items" ("workspace_id", "kind");
CREATE INDEX IF NOT EXISTS "capability_catalog_items_workspace_category_idx" ON "capability_catalog_items" ("workspace_id", "category");
CREATE INDEX IF NOT EXISTS "capability_catalog_items_workspace_source_idx" ON "capability_catalog_items" ("workspace_id", "source");
ALTER TABLE "capability_catalog_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_catalog_items" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'capability_catalog_items' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "capability_catalog_items";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "capability_catalog_items"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE TABLE IF NOT EXISTS "capability_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "capability_id" text NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "enabled_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "capability_installations_workspace_capability_idx" ON "capability_installations" ("workspace_id", "capability_id");
CREATE INDEX IF NOT EXISTS "capability_installations_workspace_kind_idx" ON "capability_installations" ("workspace_id", "kind");
CREATE INDEX IF NOT EXISTS "capability_installations_workspace_status_idx" ON "capability_installations" ("workspace_id", "status");
ALTER TABLE "capability_installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_installations" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'capability_installations' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "capability_installations";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "capability_installations"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;

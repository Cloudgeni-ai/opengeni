CREATE TABLE IF NOT EXISTS "import_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL,
  "snapshot_date" timestamptz NOT NULL,
  "snapshot_ref" text,
  "attribution_note" text NOT NULL,
  "imported_count" integer NOT NULL DEFAULT 0,
  "skipped_count" integer NOT NULL DEFAULT 0,
  "quarantined_count" integer NOT NULL DEFAULT 0,
  "logo_failure_count" integer NOT NULL DEFAULT 0,
  "stale_count" integer NOT NULL DEFAULT 0,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "import_batches_source_snapshot_idx" ON "import_batches" ("source", "snapshot_date");
CREATE INDEX IF NOT EXISTS "import_batches_created_at_idx" ON "import_batches" ("created_at");

ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batches" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'import_batches' AND policyname = 'global_catalog_import_batches'
  ) THEN
    DROP POLICY global_catalog_import_batches ON "import_batches";
  END IF;
END $$;
CREATE POLICY global_catalog_import_batches ON "import_batches"
  USING (true)
  WITH CHECK (true);

ALTER TABLE "capability_catalog_items" ALTER COLUMN "account_id" DROP NOT NULL;
ALTER TABLE "capability_catalog_items" ALTER COLUMN "workspace_id" DROP NOT NULL;
ALTER TABLE "capability_catalog_items" ADD COLUMN IF NOT EXISTS "provider_domain" text;
ALTER TABLE "capability_catalog_items" ADD COLUMN IF NOT EXISTS "surface_type" text;
ALTER TABLE "capability_catalog_items" ADD COLUMN IF NOT EXISTS "transport" text;
ALTER TABLE "capability_catalog_items" ADD COLUMN IF NOT EXISTS "mcp_url" text;
ALTER TABLE "capability_catalog_items" ADD COLUMN IF NOT EXISTS "auth_kind" text;
ALTER TABLE "capability_catalog_items" ADD COLUMN IF NOT EXISTS "credential_facts" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "capability_catalog_items" ADD COLUMN IF NOT EXISTS "tier" text;
ALTER TABLE "capability_catalog_items" ADD COLUMN IF NOT EXISTS "provenance" text;
ALTER TABLE "capability_catalog_items" ADD COLUMN IF NOT EXISTS "logo_asset_path" text;
ALTER TABLE "capability_catalog_items" ADD COLUMN IF NOT EXISTS "import_batch_id" uuid REFERENCES "import_batches"("id") ON DELETE SET NULL;
ALTER TABLE "capability_catalog_items" ADD COLUMN IF NOT EXISTS "stale" boolean NOT NULL DEFAULT false;
ALTER TABLE "capability_catalog_items" ADD COLUMN IF NOT EXISTS "stale_at" timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'capability_catalog_items_registry_global_ck'
  ) THEN
    ALTER TABLE "capability_catalog_items" ADD CONSTRAINT "capability_catalog_items_registry_global_ck"
      CHECK (
        "source" <> 'registry'
        OR (
          "account_id" IS NULL
          AND "workspace_id" IS NULL
          AND "kind" = 'mcp'
          AND "provider_domain" IS NOT NULL
          AND "mcp_url" IS NOT NULL
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "capability_catalog_items_registry_surface_idx"
  ON "capability_catalog_items" ("source", "provider_domain", "mcp_url");
CREATE UNIQUE INDEX IF NOT EXISTS "capability_catalog_items_global_capability_idx"
  ON "capability_catalog_items" ("id") WHERE "workspace_id" IS NULL;
CREATE INDEX IF NOT EXISTS "capability_catalog_items_provider_domain_idx" ON "capability_catalog_items" ("provider_domain");
CREATE INDEX IF NOT EXISTS "capability_catalog_items_import_batch_idx" ON "capability_catalog_items" ("import_batch_id");
CREATE INDEX IF NOT EXISTS "capability_catalog_items_source_stale_idx" ON "capability_catalog_items" ("source", "stale");

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
  USING (
    ("account_id" IS NULL AND "workspace_id" IS NULL)
    OR opengeni_private.workspace_rls_visible(account_id, workspace_id)
  )
  WITH CHECK (
    ("account_id" IS NULL AND "workspace_id" IS NULL)
    OR opengeni_private.workspace_rls_visible(account_id, workspace_id)
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opengeni_app',
      current_schema()
    );
  END IF;
END $$;

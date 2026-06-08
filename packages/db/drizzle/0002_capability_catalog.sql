CREATE TABLE IF NOT EXISTS "capability_catalog_items" (
  "id" text PRIMARY KEY NOT NULL,
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
CREATE INDEX IF NOT EXISTS "capability_catalog_items_kind_idx" ON "capability_catalog_items" ("kind");
CREATE INDEX IF NOT EXISTS "capability_catalog_items_category_idx" ON "capability_catalog_items" ("category");
CREATE INDEX IF NOT EXISTS "capability_catalog_items_source_idx" ON "capability_catalog_items" ("source");

CREATE TABLE IF NOT EXISTS "capability_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "capability_id" text NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "enabled_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "capability_installations_capability_id_idx" ON "capability_installations" ("capability_id");
CREATE INDEX IF NOT EXISTS "capability_installations_kind_idx" ON "capability_installations" ("kind");
CREATE INDEX IF NOT EXISTS "capability_installations_status_idx" ON "capability_installations" ("status");

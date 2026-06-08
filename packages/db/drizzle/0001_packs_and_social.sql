CREATE TABLE IF NOT EXISTS "pack_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pack_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "enabled_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "pack_installations_pack_id_idx" ON "pack_installations" ("pack_id");
CREATE INDEX IF NOT EXISTS "pack_installations_status_idx" ON "pack_installations" ("status");

CREATE TABLE IF NOT EXISTS "social_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS "social_connections_provider_handle_idx" ON "social_connections" ("provider", "account_handle");
CREATE INDEX IF NOT EXISTS "social_connections_provider_status_idx" ON "social_connections" ("provider", "status");

CREATE TABLE IF NOT EXISTS "social_posts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS "social_posts_connection_external_post_idx" ON "social_posts" ("connection_id", "external_post_id");
CREATE INDEX IF NOT EXISTS "social_posts_connection_published_idx" ON "social_posts" ("connection_id", "published_at");
CREATE INDEX IF NOT EXISTS "social_posts_provider_published_idx" ON "social_posts" ("provider", "published_at");

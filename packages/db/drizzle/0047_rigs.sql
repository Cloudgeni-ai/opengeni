-- Rigs: workspace-scoped, versioned sandbox machine definitions.
--   rigs           — the named definition (one row per rig).
--   rig_versions   — append-only, content-immutable versions; exactly one active
--                    per rig (partial unique index). Only the `active` flag flips.
--   rig_changes    — proposed/verified change records (M4 substrate only here).
-- Plus M3 wiring columns (sessions/scheduled_tasks/workspaces) added now so the
-- runtime-binding milestone needs no further migration. RLS/GRANT idiom mirrors
-- 0041_knowledge_layer.sql.

CREATE TABLE IF NOT EXISTS "rigs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "rigs_workspace_name_idx" ON "rigs" ("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "rigs_workspace_created_idx" ON "rigs" ("workspace_id", "created_at");

CREATE TABLE IF NOT EXISTS "rig_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "rig_id" uuid NOT NULL REFERENCES "rigs"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "image" text,
  "setup_script" text,
  "checks" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "credential_hooks" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "default_variable_set_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "changelog" text,
  "created_by" text,
  "active" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Monotonic version number per rig.
CREATE UNIQUE INDEX IF NOT EXISTS "rig_versions_rig_version_idx" ON "rig_versions" ("rig_id", "version");
-- At most one active version per rig (single-active invariant enforced in DB).
CREATE UNIQUE INDEX IF NOT EXISTS "rig_versions_rig_active_idx" ON "rig_versions" ("rig_id") WHERE "active";
CREATE INDEX IF NOT EXISTS "rig_versions_workspace_rig_idx" ON "rig_versions" ("workspace_id", "rig_id", "version");

CREATE TABLE IF NOT EXISTS "rig_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "rig_id" uuid NOT NULL REFERENCES "rigs"("id") ON DELETE CASCADE,
  "base_version_id" uuid REFERENCES "rig_versions"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'proposed',
  "proposed_by" text,
  "verification" jsonb,
  "result_version_id" uuid REFERENCES "rig_versions"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rig_changes_kind_check" CHECK ("kind" IN ('setup_append', 'definition_edit')),
  CONSTRAINT "rig_changes_status_check" CHECK ("status" IN ('proposed', 'verifying', 'merged', 'rejected', 'failed'))
);

CREATE INDEX IF NOT EXISTS "rig_changes_workspace_rig_idx" ON "rig_changes" ("workspace_id", "rig_id", "created_at");
CREATE INDEX IF NOT EXISTS "rig_changes_workspace_status_idx" ON "rig_changes" ("workspace_id", "status");

-- M3 wiring columns (inert until the runtime-binding milestone consumes them).
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "rig_id" uuid;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "rig_version_id" uuid;
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "rig_id" uuid;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "default_rig_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_rig_id_fk') THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_rig_id_fk"
      FOREIGN KEY ("rig_id") REFERENCES "rigs"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_rig_version_id_fk') THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_rig_version_id_fk"
      FOREIGN KEY ("rig_version_id") REFERENCES "rig_versions"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_tasks_rig_id_fk') THEN
    ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_rig_id_fk"
      FOREIGN KEY ("rig_id") REFERENCES "rigs"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_default_rig_id_fk') THEN
    ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_default_rig_id_fk"
      FOREIGN KEY ("default_rig_id") REFERENCES "rigs"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "sessions_rig_idx" ON "sessions" ("workspace_id", "rig_id");
CREATE INDEX IF NOT EXISTS "scheduled_tasks_rig_idx" ON "scheduled_tasks" ("workspace_id", "rig_id");

-- Row-level security: workspace isolation on every rig table.
ALTER TABLE "rigs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rigs" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'rigs' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "rigs";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "rigs"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE "rig_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rig_versions" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'rig_versions' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "rig_versions";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "rig_versions"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE "rig_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rig_changes" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'rig_changes' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "rig_changes";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "rig_changes"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opengeni_app',
      current_schema()
    );
  END IF;
END $$;

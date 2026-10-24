-- deployment-mode: rolling
-- Agent profiles: named, workspace-shared agent presets plus the identity a
-- chat's agent wears. Two new tables and one nullable sessions column. Older
-- binaries never read or write the tables, and they ignore the new column
-- (its absence and NULL both mean "the default agent identity").
--
-- A profile is pure configuration preset and display metadata. Applying one
-- goes through the ordinary session create/update authorization, so a row
-- here never grants execution authority by itself.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE "agent_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "role" text,
  "avatar" jsonb NOT NULL,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Increments on every content change; equals the newest version row.
  "version" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'active',
  -- Attribution strings, as on channels: 'user:<subject>' style subject ids.
  "created_by" text,
  "updated_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "archived_at" timestamptz,
  CONSTRAINT "agent_profiles_name_chk"
    CHECK (length(btrim("name")) BETWEEN 1 AND 60 AND "name" = btrim("name")),
  CONSTRAINT "agent_profiles_role_chk"
    CHECK ("role" IS NULL OR (length(btrim("role")) BETWEEN 1 AND 160 AND "role" = btrim("role"))),
  CONSTRAINT "agent_profiles_avatar_chk" CHECK (jsonb_typeof("avatar") = 'object'),
  CONSTRAINT "agent_profiles_config_chk" CHECK (jsonb_typeof("config") = 'object'),
  CONSTRAINT "agent_profiles_version_chk" CHECK ("version" >= 1),
  CONSTRAINT "agent_profiles_status_chk"
    CHECK (("status" = 'active' AND "archived_at" IS NULL)
      OR ("status" = 'archived' AND "archived_at" IS NOT NULL)),
  CONSTRAINT "agent_profiles_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE
);

-- Active names are unique per workspace (case-insensitive); archiving frees a
-- name for reuse.
CREATE UNIQUE INDEX "agent_profiles_workspace_active_name_idx"
  ON "agent_profiles" ("workspace_id", lower("name"))
  WHERE "status" = 'active';
CREATE UNIQUE INDEX "agent_profiles_workspace_id_uq"
  ON "agent_profiles" ("workspace_id", "id");

ALTER TABLE "agent_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "agent_profiles"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

-- Immutable revision history. A chat records (profile id, version) and can
-- always be traced back to the exact configuration it started from.
CREATE TABLE "agent_profile_versions" (
  "profile_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "role" text,
  "avatar" jsonb NOT NULL,
  "config" jsonb NOT NULL,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("profile_id", "version"),
  CONSTRAINT "agent_profile_versions_version_chk" CHECK ("version" >= 1),
  CONSTRAINT "agent_profile_versions_profile_fk"
    FOREIGN KEY ("workspace_id", "profile_id")
    REFERENCES "agent_profiles"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "agent_profile_versions_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE
);

ALTER TABLE "agent_profile_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_profile_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "agent_profile_versions"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- Profiles are archived, never deleted, so the runtime has no DELETE.
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.agent_profiles TO opengeni_app',
      target_schema
    );
    -- Versions are append-only.
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.agent_profile_versions TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;

-- The identity a chat's agent wears: a display snapshot
-- { profileId, profileVersion, name, role, avatar }. NULL is the default agent.
-- Metadata-only nullable column addition; no scan, no index.
ALTER TABLE "sessions"
  ADD COLUMN "agent_profile" jsonb;

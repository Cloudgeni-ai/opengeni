-- deployment-mode: rolling

-- Workspace-shared channels organize root sessions ("workstreams") by work
-- type in the rail. A channel is pure organizational metadata: filing a
-- session into one never affects execution, authority, memory, or history,
-- and deleting a channel only detaches its sessions (channel_id -> NULL).
CREATE TABLE "channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  -- Attribution string: 'user:<subject>' | 'session:<id>' | 'system'.
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "channels_name_chk"
    CHECK (length(btrim("name")) BETWEEN 1 AND 80 AND "name" = btrim("name")),
  CONSTRAINT "channels_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "channels_workspace_name_idx"
  ON "channels" ("workspace_id", lower("name"));
CREATE UNIQUE INDEX "channels_workspace_id_uq"
  ON "channels" ("workspace_id", "id");

ALTER TABLE "channels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channels" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "channels"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.channels TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;

-- A root session may be filed into one channel; NULL means unfiled (the
-- inbox). The single-column ON DELETE SET NULL follows the variable_set_id
-- precedent; workspace scoping is enforced by RLS plus the application
-- create/update boundary, which resolves the channel workspace-scoped.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "sessions"
  ADD COLUMN "channel_id" uuid REFERENCES "channels"("id") ON DELETE SET NULL;
CREATE INDEX "sessions_workspace_channel_idx"
  ON "sessions" ("workspace_id", "channel_id")
  WHERE "channel_id" IS NOT NULL;

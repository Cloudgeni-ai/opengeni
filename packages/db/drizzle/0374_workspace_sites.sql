-- deployment-mode: rolling
-- Native Sites are immutable static artifact releases with server-side runtime
-- authority. Storage is installed independently of OPENGENI_SITES_ENABLED.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "workspace_sites" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "artifact_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "current_release_id" uuid,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_sites_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_sites_artifact_fk" FOREIGN KEY ("workspace_id", "artifact_id")
    REFERENCES "workspace_artifacts"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "workspace_sites_identity_chk" CHECK ("id" = "artifact_id"),
  CONSTRAINT "workspace_sites_status_chk" CHECK ("status" IN ('active','archived')),
  CONSTRAINT "workspace_sites_actor_chk" CHECK (
    octet_length(convert_to("created_by_subject_id", 'UTF8')) BETWEEN 1 AND 1024
  )
);
CREATE UNIQUE INDEX "workspace_sites_workspace_artifact_uq" ON "workspace_sites" ("workspace_id", "artifact_id");
CREATE UNIQUE INDEX "workspace_sites_scope_uq" ON "workspace_sites" ("id", "workspace_id", "account_id");
CREATE INDEX "workspace_sites_list_idx" ON "workspace_sites" ("workspace_id", "updated_at", "id");
-- Required for a release FK that proves the selected immutable artifact
-- version belongs to this Site identity, not merely the same workspace.
CREATE UNIQUE INDEX "workspace_artifact_versions_site_scope_uq"
  ON "workspace_artifact_versions" ("workspace_id", "artifact_id", "id");

CREATE TABLE "workspace_site_releases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "site_id" uuid NOT NULL,
  "artifact_version_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "revision" bigint NOT NULL,
  "manifest_hash" text NOT NULL,
  "manifest" jsonb NOT NULL,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_site_releases_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_site_releases_site_fk" FOREIGN KEY ("site_id", "workspace_id", "account_id")
    REFERENCES "workspace_sites"("id", "workspace_id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_site_releases_artifact_version_fk" FOREIGN KEY ("workspace_id", "site_id", "artifact_version_id")
    REFERENCES "workspace_artifact_versions"("workspace_id", "artifact_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "workspace_site_releases_values_chk" CHECK (
    "revision" BETWEEN 1 AND 9007199254740991
    AND "request_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "manifest_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND jsonb_typeof("manifest") = 'object'
    AND octet_length(convert_to("created_by_subject_id", 'UTF8')) BETWEEN 1 AND 1024
  )
);
CREATE UNIQUE INDEX "workspace_site_releases_revision_uq" ON "workspace_site_releases" ("site_id", "revision");
CREATE UNIQUE INDEX "workspace_site_releases_operation_uq" ON "workspace_site_releases" ("site_id", "operation_id");
CREATE UNIQUE INDEX "workspace_site_releases_scope_uq" ON "workspace_site_releases" ("id", "site_id", "workspace_id", "account_id");
CREATE INDEX "workspace_site_releases_timeline_idx" ON "workspace_site_releases" ("workspace_id", "site_id", "created_at");
ALTER TABLE "workspace_sites" ADD CONSTRAINT "workspace_sites_current_release_fk"
  FOREIGN KEY ("current_release_id", "id", "workspace_id", "account_id")
  REFERENCES "workspace_site_releases"("id", "site_id", "workspace_id", "account_id")
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "workspace_site_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "site_id" uuid NOT NULL,
  "release_id" uuid,
  "operation_id" uuid NOT NULL,
  "type" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "facts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_site_events_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_site_events_site_fk" FOREIGN KEY ("site_id", "workspace_id", "account_id")
    REFERENCES "workspace_sites"("id", "workspace_id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_site_events_release_fk" FOREIGN KEY ("release_id", "site_id", "workspace_id", "account_id")
    REFERENCES "workspace_site_releases"("id", "site_id", "workspace_id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "workspace_site_events_values_chk" CHECK (
    "type" IN ('published','rolled_back','archived','runtime_session_started')
    AND octet_length(convert_to("actor_subject_id", 'UTF8')) BETWEEN 1 AND 1024
    AND jsonb_typeof("facts") = 'object'
  )
);
CREATE UNIQUE INDEX "workspace_site_events_operation_uq" ON "workspace_site_events" ("site_id", "operation_id");
CREATE INDEX "workspace_site_events_timeline_idx" ON "workspace_site_events" ("workspace_id", "site_id", "created_at");

CREATE TABLE "workspace_site_runtime_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "site_id" uuid NOT NULL,
  "release_id" uuid NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_site_runtime_sessions_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_site_runtime_sessions_site_fk" FOREIGN KEY ("site_id", "workspace_id", "account_id")
    REFERENCES "workspace_sites"("id", "workspace_id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_site_runtime_sessions_release_fk" FOREIGN KEY ("release_id", "site_id", "workspace_id", "account_id")
    REFERENCES "workspace_site_releases"("id", "site_id", "workspace_id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "workspace_site_runtime_sessions_session_workspace_fk" FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "workspace_site_runtime_sessions_session_account_fk" FOREIGN KEY ("session_id", "account_id")
    REFERENCES "sessions"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_site_runtime_sessions_values_chk" CHECK (
    "request_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND octet_length(convert_to("created_by_subject_id", 'UTF8')) BETWEEN 1 AND 1024
  )
);
CREATE UNIQUE INDEX "workspace_site_runtime_sessions_session_uq" ON "workspace_site_runtime_sessions" ("session_id");
CREATE UNIQUE INDEX "workspace_site_runtime_sessions_operation_uq" ON "workspace_site_runtime_sessions" ("site_id", "operation_id");
CREATE INDEX "workspace_site_runtime_sessions_timeline_idx" ON "workspace_site_runtime_sessions" ("workspace_id", "site_id", "created_at");

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_sites', 'workspace_site_releases', 'workspace_site_events',
    'workspace_site_runtime_sessions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $rls$;

CREATE POLICY "workspace_isolation" ON "workspace_sites"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_select" ON "workspace_site_releases" FOR SELECT
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_insert" ON "workspace_site_releases" FOR INSERT
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_select" ON "workspace_site_events" FOR SELECT
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_insert" ON "workspace_site_events" FOR INSERT
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_select" ON "workspace_site_runtime_sessions" FOR SELECT
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_insert" ON "workspace_site_runtime_sessions" FOR INSERT
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_sites" TO opengeni_app;
    GRANT SELECT, INSERT ON "workspace_site_releases" TO opengeni_app;
    GRANT SELECT, INSERT ON "workspace_site_events" TO opengeni_app;
    GRANT SELECT, INSERT ON "workspace_site_runtime_sessions" TO opengeni_app;
  END IF;
END $grants$;

-- deployment-mode: rolling
-- Durable navigation links between a session and every editable artifact it uses.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "editable_artifact_session_links" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "artifact_id" text NOT NULL,
  "first_used_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "editable_artifact_session_links_pk"
    PRIMARY KEY ("account_id", "workspace_id", "session_id", "artifact_id"),
  CONSTRAINT "editable_artifact_session_links_workspace_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "editable_artifact_session_links_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "editable_artifact_session_links_artifact_fk"
    FOREIGN KEY ("account_id", "workspace_id", "artifact_id")
    REFERENCES "editable_artifacts"("account_id", "workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "editable_artifact_session_links_artifact_id_chk" CHECK (
    "artifact_id" ~ '^[0-9a-f]{32}$' AND "artifact_id" !~ '^0+$'
  ),
  CONSTRAINT "editable_artifact_session_links_time_chk" CHECK (
    "last_used_at" >= "first_used_at"
  )
);

CREATE INDEX "editable_artifact_session_links_session_timeline_idx"
  ON "editable_artifact_session_links" ("workspace_id", "session_id", "last_used_at" DESC, "artifact_id");

ALTER TABLE "editable_artifact_session_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "editable_artifact_session_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "editable_artifact_session_links"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.editable_artifact_session_links FROM opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.editable_artifact_session_links TO opengeni_app',
      target_schema
    );
  END IF;
END;
$grants$;

RESET statement_timeout;
RESET lock_timeout;

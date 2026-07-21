-- deployment-mode: rolling
-- OPE-65: transactional workspace revisions make updated-order discovery and
-- its next incremental scan one gap-free handoff independent of application
-- clocks. Existing sessions remain revision zero until their next activity.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE "workspace_session_activity_revisions" (
  "workspace_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "revision" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "workspace_session_activity_revisions_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_session_activity_revisions_revision_check"
    CHECK ("revision" >= 0)
);

ALTER TABLE "workspace_session_activity_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_session_activity_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "workspace_session_activity_revisions"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- PostgreSQL installs this constant default without rewriting existing rows.
-- Revision zero is an intentional legacy bucket ordered by (updated_at, id).
ALTER TABLE "sessions"
  ADD COLUMN "activity_revision" bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION opengeni_private.assign_session_activity_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  next_revision bigint;
BEGIN
  EXECUTE format(
    'INSERT INTO %I.workspace_session_activity_revisions AS counter '
    || '(workspace_id, account_id, revision) VALUES ($1, $2, 1) '
    || 'ON CONFLICT (workspace_id) DO UPDATE SET '
    || 'account_id = excluded.account_id, revision = counter.revision + 1 '
    || 'RETURNING revision',
    TG_TABLE_SCHEMA
  )
  INTO next_revision
  USING NEW.workspace_id, NEW.account_id;

  NEW.activity_revision := next_revision;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER sessions_assign_activity_revision
BEFORE INSERT OR UPDATE OF updated_at, activity_revision
ON "sessions"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.assign_session_activity_revision();

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.workspace_session_activity_revisions TO opengeni_app',
      target_schema
    );
  END IF;
END $grants$;

RESET statement_timeout;
RESET lock_timeout;
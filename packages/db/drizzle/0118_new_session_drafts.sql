-- deployment-mode: rolling
-- Actor-private, server-authoritative composer state before a session exists.
-- This is intentionally separate from composer_drafts, whose non-null session
-- foreign key is a load-bearing invariant for established-session queue edits.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE "new_session_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "subject_id" text NOT NULL,
  "revision" bigint DEFAULT 1 NOT NULL,
  "text" text DEFAULT '' NOT NULL,
  "resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "model" text NOT NULL,
  "reasoning_effort" text NOT NULL,
  "session_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "new_session_drafts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "new_session_drafts_subject_check"
    CHECK (length(btrim("subject_id")) > 0),
  CONSTRAINT "new_session_drafts_revision_check" CHECK ("revision" >= 1)
);

CREATE UNIQUE INDEX "new_session_drafts_subject_workspace_uq"
  ON "new_session_drafts" ("workspace_id", "subject_id");

ALTER TABLE "new_session_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "new_session_drafts" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "new_session_drafts"
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND subject_id = opengeni_private.current_subject_id()
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND subject_id = opengeni_private.current_subject_id()
  );

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.new_session_drafts TO opengeni_app',
      target_schema
    );
  END IF;
END $grants$;

RESET statement_timeout;
RESET lock_timeout;

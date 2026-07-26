-- Short-lived server-owned activity-order snapshots for stable session cursors.
-- The snapshot is subject-scoped as well as workspace-scoped: one member's
-- continuation chain must never disclose or affect another member's view.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE IF NOT EXISTS "session_list_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "subject_id" text NOT NULL,
  "parent_session_filter" text NOT NULL DEFAULT 'all',
  "search" text,
  "ordinary_session_ids" uuid[] NOT NULL DEFAULT '{}'::uuid[],
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_list_snapshots_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id")
    ON DELETE CASCADE,
  CONSTRAINT "session_list_snapshots_subject_nonempty"
    CHECK (length(btrim("subject_id")) > 0),
  CONSTRAINT "session_list_snapshots_parent_filter_valid"
    CHECK (
      "parent_session_filter" = 'all'
      OR "parent_session_filter" = 'null'
      OR "parent_session_filter" ~ '^[0-9a-fA-F-]{36}$'
    ),
  CONSTRAINT "session_list_snapshots_search_length"
    CHECK ("search" IS NULL OR length("search") <= 200)
);

CREATE INDEX IF NOT EXISTS "session_list_snapshots_workspace_expiry_idx"
  ON "session_list_snapshots" ("workspace_id", "subject_id", "expires_at");

ALTER TABLE "session_list_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_list_snapshots" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'session_list_snapshots'
      AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "session_list_snapshots";
  END IF;
END $$;

CREATE POLICY workspace_isolation ON "session_list_snapshots"
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND subject_id = opengeni_private.current_subject_id()
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND subject_id = opengeni_private.current_subject_id()
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

RESET statement_timeout;
RESET lock_timeout;
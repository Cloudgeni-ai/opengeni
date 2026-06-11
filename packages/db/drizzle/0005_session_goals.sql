CREATE TABLE IF NOT EXISTS "session_goals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'active',
  "text" text NOT NULL,
  "success_criteria" text,
  "evidence" text,
  "rationale" text,
  "paused_reason" text,
  "created_by" text NOT NULL DEFAULT 'api',
  "version" integer NOT NULL DEFAULT 1,
  "auto_continuations" integer NOT NULL DEFAULT 0,
  "no_progress_streak" integer NOT NULL DEFAULT 0,
  "max_auto_continuations" integer,
  "last_continuation_turn_id" uuid,
  "version_at_last_continuation" integer,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "session_goals_workspace_session_idx" ON "session_goals" ("workspace_id", "session_id");
CREATE INDEX IF NOT EXISTS "session_goals_workspace_status_idx" ON "session_goals" ("workspace_id", "status");
ALTER TABLE "session_goals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_goals" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'session_goals' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "session_goals";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "session_goals"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;

-- Personal, server-authoritative session pins. A pin belongs to the authenticated
-- member (`subject_id`), never to the session itself: shared workspace members
-- independently organize the same durable session rows. Deleting a session or
-- workspace cleans pins through FKs; no session activity/history field changes.

-- Bound the brief catalog/table locks needed for the additive table and foreign keys
-- so production migration contention fails closed and retries rather than blocking
-- API writes indefinitely. The composite sessions parent index is owned by the
-- preceding 0053 migration on current main.
SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE IF NOT EXISTS "session_pins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "pinned" boolean NOT NULL DEFAULT true,
  "pinned_at" timestamptz DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1,
  CONSTRAINT "session_pins_subject_nonempty" CHECK (length(btrim("subject_id")) > 0),
  CONSTRAINT "session_pins_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "session_pins_state_consistent" CHECK (
    ("pinned" AND "pinned_at" IS NOT NULL)
    OR (NOT "pinned" AND "pinned_at" IS NULL)
  ),
  CONSTRAINT "session_pins_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id")
    ON DELETE CASCADE,
  CONSTRAINT "session_pins_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id")
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "session_pins_subject_workspace_session_idx"
  ON "session_pins" ("subject_id", "workspace_id", "session_id");
CREATE INDEX IF NOT EXISTS "session_pins_workspace_subject_pinned_idx"
  ON "session_pins" ("workspace_id", "subject_id", "pinned", "pinned_at" DESC, "session_id" DESC);

ALTER TABLE "session_pins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_pins" FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION opengeni_private.current_subject_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('opengeni.subject_id', true), '');
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'session_pins' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "session_pins";
  END IF;
END $$;

CREATE POLICY workspace_isolation ON "session_pins"
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
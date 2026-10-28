-- deployment-mode: rolling
-- Credential profiles: an opt-in mapping from environment variable names to
-- secret references that Opengeni adds to the environment of every command
-- an agent runs. One row per workspace (session_id NULL) and at most one per
-- session, whose entries its child sessions inherit. Rows hold names and
-- references only, never values: references are resolved per command through
-- the attempt's secret resolver. A new table that no earlier release reads.
SET LOCAL lock_timeout = '5s';

CREATE TABLE credential_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  -- [{name, reference}] in the order they were given.
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Built-in git helper; NULL on a session inherits, on the workspace is off.
  git_helper boolean,
  updated_by_subject_id text NOT NULL,
  updated_by_session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_profiles_workspace_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT credential_profiles_values_chk CHECK (
    jsonb_typeof(entries) = 'array'
    AND jsonb_array_length(entries) <= 32
    AND octet_length(entries::text) <= 65536
    AND octet_length(updated_by_subject_id) BETWEEN 1 AND 1024
  )
);
CREATE UNIQUE INDEX credential_profiles_workspace_uq
  ON credential_profiles (workspace_id) WHERE session_id IS NULL;
CREATE UNIQUE INDEX credential_profiles_session_uq
  ON credential_profiles (workspace_id, session_id) WHERE session_id IS NOT NULL;
CREATE INDEX credential_profiles_session_idx
  ON credential_profiles (session_id) WHERE session_id IS NOT NULL;

ALTER TABLE credential_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_profiles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE credential_profiles FROM PUBLIC;
CREATE POLICY workspace_isolation ON credential_profiles
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- A session profile, like every other chat-linked row, is visible only to
-- someone who can see that chat. The workspace profile (no session) is
-- visible across the workspace.
CREATE POLICY session_visibility_isolation ON credential_profiles AS RESTRICTIVE
  FOR ALL USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));

DO $credential_profiles_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON credential_profiles TO opengeni_app;
  END IF;
END
$credential_profiles_grants$;

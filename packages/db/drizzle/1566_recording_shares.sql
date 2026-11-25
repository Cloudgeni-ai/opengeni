-- deployment-mode: rolling
-- A meeting recorded in its owner's Personal workspace can be shared with one
-- of their team workspaces in the same organization (docs/recordings.md,
-- "Visibility"). The meeting stays where it is stored, with its speakers,
-- notes chats, billing and retention; recording_shares names the one other
-- workspace whose members may open it there, read only.
--
-- A row is readable in the workspace that stores the meeting and in the
-- workspace it is shared with, and only the meeting's owner adds, changes or
-- removes it, in the storing workspace. Deleting the meeting or either
-- workspace removes it.
--
-- Rolling: a new table that the previous release never reads. Until the new
-- release serves a request, such a meeting is simply not listed in the team
-- workspace.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE TABLE recording_shares (
  account_id uuid NOT NULL,
  recording_workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  shared_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recording_shares_pkey PRIMARY KEY (recording_id),
  CONSTRAINT recording_shares_other_workspace_check
    CHECK (workspace_id <> recording_workspace_id),
  CONSTRAINT recording_shares_shared_by_subject_id_check
    CHECK (char_length(shared_by_subject_id) BETWEEN 1 AND 512),
  CONSTRAINT recording_shares_recording_fk FOREIGN KEY (recording_workspace_id, recording_id)
    REFERENCES recordings(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_shares_recording_workspace_fk FOREIGN KEY (recording_workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT recording_shares_workspace_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
COMMENT ON TABLE recording_shares IS 'The team workspace a meeting stored in its owner''s Personal workspace is shared with.';

CREATE INDEX recording_shares_workspace_idx
  ON recording_shares (workspace_id, recording_workspace_id, shared_by_subject_id);
CREATE INDEX recording_shares_recording_workspace_idx
  ON recording_shares (recording_workspace_id, recording_id);

ALTER TABLE recording_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE recording_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY recording_shares_read ON recording_shares FOR SELECT
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    OR opengeni_private.workspace_rls_visible(account_id, recording_workspace_id)
  );
CREATE POLICY recording_shares_owner_write ON recording_shares FOR ALL
  USING (
    opengeni_private.workspace_rls_visible(account_id, recording_workspace_id)
    AND shared_by_subject_id = opengeni_private.current_subject_id()
    AND EXISTS (
      SELECT 1 FROM recordings parent
      WHERE parent.workspace_id = recording_shares.recording_workspace_id
        AND parent.id = recording_shares.recording_id
        AND parent.owner_subject_id = recording_shares.shared_by_subject_id
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, recording_workspace_id)
    AND shared_by_subject_id = opengeni_private.current_subject_id()
    AND EXISTS (
      SELECT 1 FROM recordings parent
      WHERE parent.workspace_id = recording_shares.recording_workspace_id
        AND parent.id = recording_shares.recording_id
        AND parent.owner_subject_id = recording_shares.shared_by_subject_id
    )
  );

REVOKE ALL ON TABLE recording_shares FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE 'REVOKE ALL ON TABLE recording_shares FROM opengeni_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE recording_shares TO opengeni_app';
  END IF;
END
$$;

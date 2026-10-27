-- deployment-mode: rolling
-- Read-only share links for a chat. The person who started a chat can create
-- one link for it; anyone holding the link can read a snapshot of the visible
-- conversation (the person's messages and the replies shown to them) as it
-- was when the link was created or last refreshed. Nothing else is stored:
-- no tool calls, tool output, files or hidden context. Refreshing keeps the
-- link and replaces the snapshot; revoking stops the link for good, and a
-- later share gets a new one.
--
-- Rows are visible exactly where their workspace is. The public read uses
-- the share-link lane: a transaction names one share id in
-- `opengeni.session_share_id` and sees only that row while it is not
-- revoked (the site hostname lane's pattern; RLS is never disabled).
--
-- A new table that the previous release never reads or writes.
CREATE TABLE session_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id text NOT NULL,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_by_subject_id text NOT NULL,
  title text NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_through_sequence integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT session_share_links_share_id_key UNIQUE (share_id),
  CONSTRAINT session_share_links_values_chk CHECK (
    share_id ~ '^[A-Za-z0-9_-]{22,64}$'
    AND octet_length(created_by_subject_id) BETWEEN 1 AND 1024
    AND octet_length(title) <= 1024
    AND jsonb_typeof(snapshot) = 'object'
    AND pg_column_size(snapshot) <= 4194304
    AND snapshot_through_sequence >= 0
  )
);
-- One live link per chat and person; revoked rows stay as history.
CREATE UNIQUE INDEX session_share_links_live_idx
  ON session_share_links (session_id, created_by_subject_id)
  WHERE revoked_at IS NULL;
CREATE INDEX session_share_links_workspace_idx
  ON session_share_links (workspace_id, created_by_subject_id, created_at DESC);

ALTER TABLE session_share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_share_links FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE session_share_links FROM PUBLIC;
CREATE POLICY workspace_isolation ON session_share_links
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- The share-link lane: exactly the live row whose share id this transaction named.
CREATE POLICY session_share_links_share_id_lookup ON session_share_links
  FOR SELECT
  USING (
    share_id = nullif(pg_catalog.current_setting('opengeni.session_share_id', true), '')
    AND revoked_at IS NULL
  );

DO $session_share_links_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON session_share_links TO opengeni_app;
  END IF;
END
$session_share_links_grants$;

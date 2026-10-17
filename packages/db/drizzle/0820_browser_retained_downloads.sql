-- deployment-mode: rolling
-- Completed browser downloads outlive the browser process that fetched them.
-- Before a browser is suspended (its working directory, and with it every
-- download, is then removed) each completed download is published as a
-- workspace file. One row per download records that file, so the download can
-- still be listed and saved into the task's workspace while the browser is
-- suspended, lost, or resumed on another machine. New table only: older
-- binaries never read or write it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE browser_session_retained_downloads (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  browser_session_id uuid NOT NULL,
  download_id uuid NOT NULL,
  -- The controller's completed download record, exactly as it was listed.
  download jsonb NOT NULL CHECK (jsonb_typeof(download) = 'object'
    AND octet_length(download::text) BETWEEN 2 AND 16384),
  file_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, browser_session_id, download_id),
  CONSTRAINT browser_session_retained_downloads_browser_fk
    FOREIGN KEY (workspace_id, browser_session_id)
    REFERENCES browser_sessions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT browser_session_retained_downloads_file_fk
    FOREIGN KEY (account_id, workspace_id, file_id)
    REFERENCES files(account_id, workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX browser_session_retained_downloads_file_idx
  ON browser_session_retained_downloads(account_id, workspace_id, file_id);
ALTER TABLE browser_session_retained_downloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_session_retained_downloads FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON browser_session_retained_downloads
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE browser_session_retained_downloads TO opengeni_app;
  END IF;
END
$grant$;

-- deployment-mode: rolling
-- Extend first-party social credentials with the same workspace/personal ownership boundary as MCP connections.

ALTER TABLE social_connections
  ADD COLUMN subject_id text;

DROP INDEX social_connections_workspace_provider_handle_idx;
CREATE UNIQUE INDEX social_connections_workspace_provider_handle_idx
  ON social_connections (workspace_id, provider, account_handle)
  WHERE subject_id IS NULL;
CREATE UNIQUE INDEX social_connections_subject_provider_handle_idx
  ON social_connections (workspace_id, subject_id, provider)
  WHERE subject_id IS NOT NULL;
CREATE INDEX social_connections_subject_provider_status_idx
  ON social_connections (workspace_id, subject_id, provider, status);

DROP POLICY workspace_isolation ON social_connections;
CREATE POLICY workspace_isolation ON social_connections
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      subject_id IS NULL
      OR subject_id = nullif(current_setting('opengeni.subject_id', true), '')
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      subject_id IS NULL
      OR subject_id = nullif(current_setting('opengeni.subject_id', true), '')
    )
  );

DROP POLICY workspace_isolation ON social_posts;
CREATE POLICY workspace_isolation ON social_posts
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND EXISTS (
      SELECT 1
      FROM social_connections connection
      WHERE connection.id = social_posts.connection_id
        AND connection.workspace_id = social_posts.workspace_id
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND EXISTS (
      SELECT 1
      FROM social_connections connection
      WHERE connection.id = social_posts.connection_id
        AND connection.workspace_id = social_posts.workspace_id
    )
  );
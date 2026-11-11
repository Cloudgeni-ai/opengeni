-- deployment-mode: rolling
-- The GitHub App installation lane. A verified webhook from the deployment's
-- GitHub App names one installation; Opengeni then brings the repository
-- allowlist of every workspace bound to it in line with GitHub. To find those
-- workspaces, a transaction names one installation id in
-- `opengeni.github_installation_id` and sees only that installation's binding
-- rows (the share-link lane's pattern; RLS is never disabled). Writes still go
-- through each workspace's own RLS scope.
--
-- Removal markers: GitHub's repository list can lag its own webhook, so a
-- repository GitHub reported removed from an installation is remembered per
-- workspace binding for a short window. A list read within that window never
-- adds it back, whichever API replica reads it.
--
-- Additive: a new SELECT-only policy that the previous release never sets,
-- and a new table the previous release never reads or writes.
CREATE POLICY github_installations_installation_lookup ON github_installations
  FOR SELECT
  USING (
    installation_id::text = nullif(pg_catalog.current_setting('opengeni.github_installation_id', true), '')
  );

CREATE TABLE github_installation_repository_removals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id integer NOT NULL,
  repository_id bigint NOT NULL,
  removed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_installation_repository_removals_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT github_installation_repository_removals_installation_fk
    FOREIGN KEY (workspace_id, installation_id)
    REFERENCES github_installations(workspace_id, installation_id) ON DELETE CASCADE,
  CONSTRAINT github_installation_repository_removals_ids_check
    CHECK (installation_id > 0 AND repository_id > 0)
);

CREATE UNIQUE INDEX github_installation_repository_removals_repo_uq
  ON github_installation_repository_removals (workspace_id, installation_id, repository_id);
CREATE INDEX github_installation_repository_removals_account_idx
  ON github_installation_repository_removals (account_id);

ALTER TABLE github_installation_repository_removals ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installation_repository_removals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE github_installation_repository_removals FROM PUBLIC;
CREATE POLICY workspace_isolation ON github_installation_repository_removals
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

COMMENT ON TABLE github_installation_repository_removals IS
  'Repositories GitHub recently reported removed from a bound installation; lists read soon after never add them back.';

DO $github_repository_removal_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON github_installation_repository_removals TO opengeni_app;
  END IF;
END
$github_repository_removal_grants$;

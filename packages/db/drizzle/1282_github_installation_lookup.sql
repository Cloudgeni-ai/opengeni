-- deployment-mode: rolling
-- The GitHub App installation lane. A verified webhook from the deployment's
-- GitHub App names one installation; Opengeni then brings the repository
-- allowlist of every workspace bound to it in line with GitHub. To find those
-- workspaces, a transaction names one installation id in
-- `opengeni.github_installation_id` and sees only that installation's binding
-- rows (the share-link lane's pattern; RLS is never disabled). Writes still go
-- through each workspace's own RLS scope.
--
-- Additive: a new SELECT-only policy that the previous release never sets.
CREATE POLICY github_installations_installation_lookup ON github_installations
  FOR SELECT
  USING (
    installation_id::text = nullif(pg_catalog.current_setting('opengeni.github_installation_id', true), '')
  );

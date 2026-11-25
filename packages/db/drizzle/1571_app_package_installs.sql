-- deployment-mode: rolling
-- Installed app packages (docs/app-packages.md#updates-and-going-back): for an
-- app installed or upgraded from a package, the package's version label, the
-- app version the package wrote (a later version means the app was changed
-- here: "Modified"), the workspace Skills that came with it and the revision
-- each was written at, and the automations it added. Snapshots keep the
-- app's state before each applied upgrade, the latest few, so it can go
-- back: the app version it was at (its files stay in the app's version
-- history) and its definitions as a package without those files.
--
-- Rows hold ids, labels and definitions only, under the workspace's
-- row-level security; deleting the app or the workspace deletes them.
--
-- Rolling: new tables the previous release never reads or writes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE app_package_installs (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  package_version text,
  -- The app version the package published or matched; null when unknown.
  version_id uuid,
  -- [{ "skillId", "name", "revisionId", "pendingRevisionId"? }]
  skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ "taskId", "name" }]
  automations jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_package_installs_pkey PRIMARY KEY (artifact_id),
  CONSTRAINT app_package_installs_version_check
    CHECK (package_version IS NULL OR char_length(package_version) BETWEEN 1 AND 32),
  CONSTRAINT app_package_installs_skills_check
    CHECK (jsonb_typeof(skills) = 'array' AND jsonb_array_length(skills) <= 50),
  CONSTRAINT app_package_installs_automations_check
    CHECK (jsonb_typeof(automations) = 'array' AND jsonb_array_length(automations) <= 50),
  CONSTRAINT app_package_installs_artifact_fk FOREIGN KEY (artifact_id)
    REFERENCES workspace_artifacts(id) ON DELETE CASCADE,
  CONSTRAINT app_package_installs_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX app_package_installs_workspace_idx ON app_package_installs (workspace_id);
COMMENT ON TABLE app_package_installs IS 'Apps installed from packages: version, Skills and automations that came with them.';

CREATE TABLE app_package_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  package_version text,
  -- The app version to go back to.
  version_id uuid NOT NULL,
  -- The upgrade that saved it, so a retried upgrade saves it once.
  operation_key text NOT NULL,
  -- The definitions (data, SQL, tools, syncs, Skills, automations) as a
  -- package without the app's files.
  package jsonb NOT NULL,
  -- Set once the app went back to it, with that request's key (a retry finds it).
  consumed_at timestamptz,
  consumed_restore_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_package_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT app_package_snapshots_operation_key UNIQUE (artifact_id, operation_key),
  CONSTRAINT app_package_snapshots_version_check
    CHECK (package_version IS NULL OR char_length(package_version) BETWEEN 1 AND 32),
  CONSTRAINT app_package_snapshots_key_check CHECK (char_length(operation_key) BETWEEN 1 AND 300),
  CONSTRAINT app_package_snapshots_consumed_key_check
    CHECK (consumed_restore_key IS NULL OR char_length(consumed_restore_key) BETWEEN 1 AND 300),
  CONSTRAINT app_package_snapshots_package_check CHECK (jsonb_typeof(package) = 'object'),
  CONSTRAINT app_package_snapshots_artifact_fk FOREIGN KEY (artifact_id)
    REFERENCES workspace_artifacts(id) ON DELETE CASCADE,
  CONSTRAINT app_package_snapshots_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX app_package_snapshots_artifact_idx ON app_package_snapshots (artifact_id, created_at DESC);
CREATE INDEX app_package_snapshots_workspace_idx ON app_package_snapshots (workspace_id);
COMMENT ON TABLE app_package_snapshots IS 'An installed app''s state before an upgrade, as a package, to go back to.';

ALTER TABLE app_package_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_package_installs FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON app_package_installs
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE app_package_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_package_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON app_package_snapshots
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

REVOKE ALL ON TABLE app_package_installs FROM PUBLIC;
REVOKE ALL ON TABLE app_package_snapshots FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE app_package_installs TO opengeni_app';
    EXECUTE 'GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE app_package_snapshots TO opengeni_app';
  END IF;
END
$$;

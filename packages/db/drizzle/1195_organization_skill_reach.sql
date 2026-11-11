-- deployment-mode: rolling
-- An organization's Skills work in the workspaces it picks
-- (docs/design/ownership-and-reach.md, rule 3), with the same reach as the
-- organization's model keys, connectors, vaults and machines: every shared
-- workspace (allowed_workspace_ids IS NULL) or the listed ones, and a separate
-- switch for members' Personal workspaces.
--
-- A Skill head changes only through its lifecycle function, which records
-- every activation, correction and scope move. Where an organization Skill
-- works is not part of that history, so it lives beside the head instead: one
-- row per organization Skill whose reach was changed. No row means every
-- workspace, Personal ones included, which is how every organization Skill
-- worked so far, so existing Skills keep exactly the reach they have.
--
-- The reach decides which workspaces' agents get the Skill in their Skill
-- index, skill_read and skill_search. People in the organization can still
-- open it in the Skills page anywhere, marked as not used there, so its
-- managers can change it from any workspace.
--
-- New code owns the table; older binaries never read it and keep serving
-- every organization Skill everywhere until they are replaced.
CREATE TABLE organization_skill_reach (
  account_id uuid NOT NULL,
  preference_id uuid NOT NULL,
  allowed_workspace_ids uuid[],
  allow_personal_workspaces boolean NOT NULL DEFAULT true,
  updated_by_subject_id text NOT NULL
    CHECK (length(updated_by_subject_id) BETWEEN 1 AND 1024),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, preference_id),
  CONSTRAINT organization_skill_reach_workspaces_check
    CHECK (allowed_workspace_ids IS NULL OR cardinality(allowed_workspace_ids) <= 500),
  FOREIGN KEY (account_id, preference_id)
    REFERENCES preference_registry_preferences(account_id, id) ON DELETE CASCADE
);
ALTER TABLE organization_skill_reach ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_skill_reach FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_skill_reach_tenant ON organization_skill_reach
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_skill_reach TO opengeni_app;
  END IF;
END $$;

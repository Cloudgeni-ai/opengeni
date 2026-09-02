-- deployment-mode: maintenance
-- A session-selected Skill is installed and inspectable like any other Skill,
-- but the worker excludes it from ambient workspace resolution. An explicit
-- session create copies the immutable artifact onto that one session.

ALTER TABLE capability_facets
  DROP CONSTRAINT capability_facets_activation_chk;

ALTER TABLE capability_facets
  ADD CONSTRAINT capability_facets_activation_chk CHECK (
    activation_mode IN (
      'platform_available',
      'runtime_baseline',
      'workspace_managed',
      'session_selected'
    )
  ) NOT VALID;

ALTER TABLE capability_facets
  VALIDATE CONSTRAINT capability_facets_activation_chk;

-- Keep the explicit installed-Skill selection in the keyed-create identity.
-- Existing sessions (and creates that select no installed Skills) retain the
-- legacy empty identity, while a retry that changes the selection conflicts
-- before it can replay a differently configured session.
ALTER TABLE sessions
  ADD COLUMN create_selected_installed_skill_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

-- deployment-mode: rolling
-- Organization connectors (docs/design/ownership-and-reach.md, OR-11): an
-- organization owner or admin adds an MCP connector once and chooses which
-- workspaces it reaches, with the same reach columns as the organization's
-- model keys: every shared workspace (allowed_workspace_ids IS NULL) or the
-- listed ones, and a separate switch for members' Personal workspaces.
--
-- One row per organization and connector. `config` holds what a workspace
-- installation of the same connector would hold (connection reference for
-- "each person signs in", encrypted request headers for an organization key,
-- enabled tools); `custom_definition` names a custom server's endpoint, and is
-- null for a catalog connector. A workspace's own installation of the same
-- capability, on or off, wins over the organization's; that is resolved by the
-- readers, not here.
--
-- Row security:
-- * Any workspace of this organization reads the rows that reach it: the same
--   reach rule as organization_model_provider_connections
--   (model_connection_workspace_access). A Personal workspace follows the
--   Personal switch alone; a shared workspace follows the list.
-- * Without a workspace, only an active organization owner or admin reads.
-- * Writes need that administrator context, never a workspace context.
-- The visibility functions are the existing organization model-provider
-- ones, already granted to the runtime, so no new routine is involved.
--
-- Rolling: a new table that the previous release never reads or writes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE organization_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  capability_id text NOT NULL,
  custom_definition jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  allowed_workspace_ids uuid[],
  allow_personal_workspaces boolean NOT NULL DEFAULT false,
  generation integer NOT NULL DEFAULT 1,
  created_by_subject_id text NOT NULL,
  updated_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_connectors_status_chk CHECK (status IN ('active', 'disabled')),
  CONSTRAINT organization_connectors_values_chk CHECK (
    char_length(capability_id) BETWEEN 1 AND 300
    AND char_length(created_by_subject_id) BETWEEN 1 AND 300
    AND char_length(updated_by_subject_id) BETWEEN 1 AND 300
    AND jsonb_typeof(config) = 'object'
    AND jsonb_typeof(metadata) = 'object'
    AND (custom_definition IS NULL OR jsonb_typeof(custom_definition) = 'object')
    AND generation > 0
    AND (allowed_workspace_ids IS NULL OR cardinality(allowed_workspace_ids) <= 1000)
  ),
  CONSTRAINT organization_connectors_capability_key UNIQUE (account_id, capability_id)
);

ALTER TABLE organization_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_connectors FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_connectors_scope ON organization_connectors
  USING (opengeni_private.organization_model_provider_scope_visible(account_id))
  WITH CHECK (opengeni_private.organization_model_provider_scope_visible(account_id));

CREATE POLICY organization_connectors_reach ON organization_connectors
  AS RESTRICTIVE FOR SELECT USING (
    CASE
      WHEN account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN false
      WHEN opengeni_private.current_workspace_id() IS NULL
        THEN opengeni_private.codex_organization_admin_visible(account_id)
      WHEN get_workspace_kind(account_id, opengeni_private.current_workspace_id()) = 'personal'
        THEN allow_personal_workspaces
      ELSE allowed_workspace_ids IS NULL
        OR opengeni_private.current_workspace_id() = ANY (allowed_workspace_ids)
    END
  );

CREATE POLICY organization_connectors_admin_insert ON organization_connectors
  AS RESTRICTIVE FOR INSERT WITH CHECK (
    opengeni_private.current_workspace_id() IS NULL
    AND opengeni_private.codex_organization_admin_visible(account_id)
  );
CREATE POLICY organization_connectors_admin_update ON organization_connectors
  AS RESTRICTIVE FOR UPDATE USING (
    opengeni_private.current_workspace_id() IS NULL
    AND opengeni_private.codex_organization_admin_visible(account_id)
  ) WITH CHECK (
    opengeni_private.current_workspace_id() IS NULL
    AND opengeni_private.codex_organization_admin_visible(account_id)
  );
CREATE POLICY organization_connectors_admin_delete ON organization_connectors
  AS RESTRICTIVE FOR DELETE USING (
    opengeni_private.current_workspace_id() IS NULL
    AND opengeni_private.codex_organization_admin_visible(account_id)
  );

DO $organization_connectors_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_connectors TO opengeni_app;
  END IF;
END
$organization_connectors_grants$;

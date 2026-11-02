-- deployment-mode: rolling
-- An organization's credential provider can reach its members' Personal
-- workspaces when an administrator turns that on for it
-- (docs/design/ownership-and-reach.md, rule 4: one per-item switch for
-- Personal workspaces). The switch is off by default, so existing providers
-- keep exactly their current reach.
--
-- The workspace filter still selects shared workspaces only; the switch alone
-- decides Personal workspaces. A Personal workspace's own provider row still
-- wins over the organization's, and a disabled one still means none.
--
-- Organization webhooks stay out of Personal workspaces: they would send a
-- person's private chat activity to an organization endpoint.
--
-- The resolver keeps its signature, owner, search path and grants. The
-- previous release ignores the new column: it never asks the resolver about
-- a Personal workspace, and its PUT leaves the stored switch as it is.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_credential_providers
  ADD COLUMN allow_personal_workspaces boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organization_credential_providers.allow_personal_workspaces IS 'Whether runs in members'' Personal workspaces use this provider. The workspace filter applies to shared workspaces only.';

-- The resolver's owner reads through this policy (FORCE ROW LEVEL SECURITY).
ALTER POLICY organization_credential_providers_resolver_owner ON organization_credential_providers
  USING (
    account_id = opengeni_private.current_account_id()
    AND enabled
    AND CURRENT_USER = (
      SELECT pg_get_userbyid(pg_class.relowner)
      FROM pg_class
      WHERE pg_class.oid = 'organization_credential_providers'::regclass
    )
    AND EXISTS (
      SELECT 1 FROM workspaces workspace
      WHERE workspace.id = opengeni_private.current_workspace_id()
        AND workspace.account_id = organization_credential_providers.account_id
        AND CASE get_workspace_kind(workspace.account_id, workspace.id)
          WHEN 'shared' THEN organization_credential_providers.workspace_filter IS NULL
            OR organization_credential_providers.workspace_filter ->> 'externalSource'
              = workspace.external_source
          WHEN 'personal' THEN organization_credential_providers.allow_personal_workspaces
          ELSE false
        END
    )
  );

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.resolve_organization_credential_provider_v1(p_account uuid, p_workspace uuid) RETURNS SETOF %1$I.organization_credential_providers
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO pg_catalog, %1$I, pg_temp
    AS $$
DECLARE
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  in_personal_workspace boolean;
BEGIN
  IF p_account IS NULL OR p_workspace IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'integration credential scope invalid' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = p_workspace AND account_id = p_account)
    OR EXISTS (SELECT 1 FROM workspace_credential_providers
      WHERE account_id = p_account AND workspace_id = p_workspace)
  THEN RETURN; END IF;
  -- FORCE-RLS membership reads use the existing owner-only lifecycle seam.
  -- A workspace that any membership points to as its Personal workspace is
  -- treated as Personal even if kind derivation says otherwise.
  in_personal_workspace := get_workspace_kind(p_account, p_workspace) IS DISTINCT FROM 'shared';
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
  IF EXISTS (SELECT 1 FROM organization_memberships
    WHERE account_id = p_account AND personal_workspace_id = p_workspace)
  THEN in_personal_workspace := true; END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
  RETURN QUERY SELECT provider.* FROM organization_credential_providers provider
    JOIN workspaces workspace ON workspace.id = p_workspace AND workspace.account_id = provider.account_id
    WHERE provider.account_id = p_account AND provider.enabled
      AND CASE WHEN in_personal_workspace THEN provider.allow_personal_workspaces
        ELSE provider.workspace_filter IS NULL
          OR provider.workspace_filter ->> 'externalSource' = workspace.external_source
      END;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
  RAISE;
END $$;
  $create$, data_schema);
END
$install$;

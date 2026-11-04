-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: an organization holds at most one active connection per model provider, a handful of rows per deployment
-- Organization model-provider API keys (Vercel AI Gateway, OpenRouter, Opper,
-- OpenAI, Azure OpenAI, Anthropic, ElevenLabs) now reach Personal workspaces
-- exactly like the organization's subscriptions do: an account "Available in"
-- every workspace serves everyone's Personal workspace too, and "Only selected
-- workspaces" has the same separate Personal workspaces switch.
--
-- Before, organization_model_provider_scope_visible hid every row of these
-- tables from a Personal workspace, whatever the connection's
-- allow_personal_workspaces said. The column was therefore never meaningful
-- for these rows: the connect step saved false for a selected audience, but
-- the account page kept the column default (true) through any edit. So the
-- stored value is normalized to the reach each connection is shown with:
-- every workspace (allowed_workspace_ids IS NULL) now includes Personal
-- workspaces; a selected list keeps excluding them until an administrator
-- turns the switch on. Normalized rows get a new access-policy version, so an
-- editor opened before this migration cannot save over it unseen.
--
-- The scope function still requires the caller's organization (account) to be
-- the row's, and the caller's workspace to belong to that organization, so
-- nothing reaches another organization's workspaces. The restrictive
-- model_connection_workspace_access SELECT policy, unchanged, applies the
-- connection's own Personal switch and workspace list; the workspace model
-- policy remains a ceiling on top.
--
-- Same signature, so policies and grants are kept. The previous release reads
-- these rows the same way and gains the same reach.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
  CREATE OR REPLACE FUNCTION opengeni_private.organization_model_provider_scope_visible(p_account_id uuid) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path TO 'pg_catalog'
      AS $$
      DECLARE
        workspace_value uuid := opengeni_private.current_workspace_id();
        subject_value text := opengeni_private.current_subject_id();
        visible boolean := false;
        previous_lifecycle text := pg_catalog.current_setting(
          'opengeni.organization_tenancy_lifecycle', true
        );
      BEGIN
        IF p_account_id IS NULL
          OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        THEN RETURN false; END IF;

        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle',
          'organization_membership_lifecycle', true
        );
        IF workspace_value IS NOT NULL THEN
          -- Any workspace of this organization, shared or Personal.
          SELECT EXISTS (
            SELECT 1 FROM %1$I.workspaces workspace
            WHERE workspace.account_id = p_account_id AND workspace.id = workspace_value
          ) INTO visible;
        ELSIF subject_value IS NOT NULL AND (
          subject_value LIKE 'user:%%'
          OR (
            subject_value = 'dev'
            AND EXISTS (
              SELECT 1 FROM %1$I.managed_accounts account
              WHERE account.id = p_account_id
                AND account.external_source = 'opengeni:local'
                AND account.external_id = 'default'
            )
          )
        ) THEN
          SELECT EXISTS (
            SELECT 1 FROM %1$I.organization_memberships membership
            WHERE membership.account_id = p_account_id
              AND membership.subject_id = subject_value
              AND membership.status = 'active'
              AND membership.role IN ('owner', 'admin')
          ) INTO visible;
        END IF;
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
        );
        RETURN coalesce(visible, false);
      EXCEPTION WHEN OTHERS THEN
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
        );
        RAISE;
      END
      $$;
  $create$, data_schema);
END
$install$;

-- The migration principal sees no rows under FORCE ROW LEVEL SECURITY, and the
-- access-policy guard admits only an organization administrator's revision;
-- both are restored before commit.
ALTER TABLE "organization_model_provider_connections" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_model_provider_connections" DISABLE TRIGGER model_connection_access_update_guard;
UPDATE organization_model_provider_connections
SET allow_personal_workspaces = (allowed_workspace_ids IS NULL),
    access_policy_version = access_policy_version + 1,
    access_policy_updated_at = now()
WHERE allow_personal_workspaces IS DISTINCT FROM (allowed_workspace_ids IS NULL);
ALTER TABLE "organization_model_provider_connections" ENABLE TRIGGER model_connection_access_update_guard;
ALTER TABLE "organization_model_provider_connections" FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_model_provider_connections IS 'Encrypted organization-owned model-provider API keys, inherited by the organization''s shared and Personal workspaces as each connection''s access policy allows.';

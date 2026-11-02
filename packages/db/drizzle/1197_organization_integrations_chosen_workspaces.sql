-- deployment-mode: rolling
-- An organization's credential provider and webhooks work in the workspaces
-- it picks, with the same reach as its model keys, connectors, vaults and
-- machines (docs/design/ownership-and-reach.md, rule 3): every shared
-- workspace (allowed_workspace_ids IS NULL) or only the listed ones.
--
-- The workspace filter ("workspaces created by this app") still applies on
-- top of the list, and the Personal switch alone still decides members'
-- Personal workspaces for the credential provider (1146). Organization
-- webhooks still never reach a Personal workspace. A workspace's own
-- provider row still wins over the organization's.
--
-- Existing rows get NULL, which is how every organization provider and
-- webhook worked so far. Older binaries never read the column and never
-- write it, so a list set by a newer one stays in place.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_credential_providers ADD COLUMN IF NOT EXISTS allowed_workspace_ids uuid[];
ALTER TABLE organization_webhooks ADD COLUMN IF NOT EXISTS allowed_workspace_ids uuid[];

COMMENT ON COLUMN organization_credential_providers.allowed_workspace_ids IS 'Shared workspaces this provider serves; NULL means every shared workspace. The workspace filter applies on top; Personal workspaces follow allow_personal_workspaces.';
COMMENT ON COLUMN organization_webhooks.allowed_workspace_ids IS 'Shared workspaces whose events this webhook receives; NULL means every shared workspace. The workspace filter applies on top; Personal workspaces never.';

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
          WHEN 'shared' THEN (organization_credential_providers.workspace_filter IS NULL
              OR organization_credential_providers.workspace_filter ->> 'externalSource'
                = workspace.external_source)
            AND (organization_credential_providers.allowed_workspace_ids IS NULL
              OR workspace.id = ANY(organization_credential_providers.allowed_workspace_ids))
          WHEN 'personal' THEN organization_credential_providers.allow_personal_workspaces
          ELSE false
        END
    )
  );

-- The resolver: a shared workspace must also be on the provider's list.
DO $organization_integrations_reach$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.resolve_organization_credential_provider_v1(uuid,uuid)'::regprocedure);
  anchor := $a$
        ELSE provider.workspace_filter IS NULL
          OR provider.workspace_filter ->> 'externalSource' = workspace.external_source
      END;$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'resolve_organization_credential_provider_v1 reach anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$
        ELSE (provider.workspace_filter IS NULL
          OR provider.workspace_filter ->> 'externalSource' = workspace.external_source)
          AND (provider.allowed_workspace_ids IS NULL OR p_workspace = ANY(provider.allowed_workspace_ids))
      END;$r$);
  EXECUTE definition;
END
$organization_integrations_reach$;

-- Webhook fan-out: an event from a shared workspace reaches an organization
-- webhook only when that workspace is on its list, for recording and
-- session events alike.
DO $organization_integrations_reach$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.enqueue_organization_webhook_deliveries_v1()'::regprocedure);
  anchor := $a$
        WHERE webhook.workspace_filter IS NULL
          OR webhook.workspace_filter ->> 'externalSource' = workspace.external_source
        ON CONFLICT$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'enqueue_organization_webhook_deliveries_v1 recording anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$
        WHERE (webhook.workspace_filter IS NULL
          OR webhook.workspace_filter ->> 'externalSource' = workspace.external_source)
          AND (webhook.allowed_workspace_ids IS NULL OR NEW.workspace_id = ANY(webhook.allowed_workspace_ids))
        ON CONFLICT$r$);
  anchor := $a$
        AND (webhook.workspace_filter IS NULL
          OR webhook.workspace_filter ->> 'externalSource' = workspace.external_source)
      ON CONFLICT$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'enqueue_organization_webhook_deliveries_v1 session anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$
        AND (webhook.workspace_filter IS NULL
          OR webhook.workspace_filter ->> 'externalSource' = workspace.external_source)
        AND (webhook.allowed_workspace_ids IS NULL OR NEW.workspace_id = ANY(webhook.allowed_workspace_ids))
      ON CONFLICT$r$);
  EXECUTE definition;
END
$organization_integrations_reach$;

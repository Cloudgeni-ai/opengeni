-- deployment-mode: rolling
-- Every organization vault, wherever it works, for the people who manage
-- organization vaults (docs/design/ownership-and-reach.md, rules 3 and 4: the
-- owner manages a thing, and reach is separate from ownership). A workspace's
-- vault list shows only the vaults that reach that workspace, so an
-- organization vault limited to other workspaces was missing from it even for
-- organization owners. Organization settings > Shared lists them all.
--
-- list_organization_vaults_v1 answers a person or an API caller in the
-- current tenant context with a summary of each organization vault: its name,
-- where it works and its item count, never its items. The route requires
-- account:admin, as creating and changing organization vaults already does.
-- Agent runs and Site viewers are refused: they only ever see what reaches
-- their workspace.
--
-- Runtime EXECUTE is withheld for one release (runtime-posture
-- DEFERRED_RUNTIME_PRIVATE_ROUTINES): the previous release rejects a runtime
-- grant on a definer it does not know. Until a later migration grants it, the
-- API answers with the organization vaults that work in the current
-- workspace and says the list is incomplete.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION opengeni_private.list_organization_vaults_v1(p_workspace uuid, p_principal jsonb)
RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $organization_vaults$
DECLARE
  context jsonb;
BEGIN
  IF coalesce(p_principal ->> 'kind', 'subject') NOT IN ('subject', 'human') THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied',
      'only a person or an API caller lists every organization vault');
  END IF;
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal, p_workspace);
  RETURN QUERY
    SELECT opengeni_private.vault_summary_json(vault, context)
      || pg_catalog.jsonb_build_object('tier', 3)
    FROM vaults vault
    WHERE vault.account_id = (context ->> 'accountId')::uuid
      AND vault.owner_kind = 'organization'
    ORDER BY vault.name_key, vault.id;
  PERFORM opengeni_private.vault_capability_close();
END
$organization_vaults$;

REVOKE ALL ON FUNCTION opengeni_private.list_organization_vaults_v1(uuid, jsonb) FROM PUBLIC;

DO $organization_vaults_search_path$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.list_organization_vaults_v1(uuid, jsonb) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    current_schema()
  );
END $organization_vaults_search_path$;

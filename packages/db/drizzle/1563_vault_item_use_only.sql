-- deployment-mode: rolling
-- Use-only secrets (docs/secrets.md, "Who can see a value").
--
-- * vault_item_use_only: items whose values can be used by reference but are
--   never shown again to anyone, their creator and admins included. A row is
--   only ever added: the runtime role may read and insert, never update or
--   delete, so marking an item use-only cannot be undone through Opengeni.
--   Permanently deleting the item (or its vault or organization) removes the
--   row with it.
--
-- * read_vault_field_ciphertext refuses reveal and agent reads of a use-only
--   item, so the database holds the rule too: servers still on the previous
--   release (which never read the marks) can't reveal a just-marked item
--   during a rollout. Its body is copied from 0977_baseline_01, its latest
--   definition, with only that check added. Same signature, so owner and
--   grants stay; the search path is pinned again below as the baseline had it.
--
-- Rolling: the previous release never sets marks (its item schema rejects
-- useOnly), and the function behaves exactly as before for unmarked items.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE TABLE vault_item_use_only (
  account_id uuid NOT NULL,
  item_id uuid NOT NULL,
  set_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vault_item_use_only_pkey PRIMARY KEY (account_id, item_id),
  CONSTRAINT vault_item_use_only_set_by_subject_id_check
    CHECK (set_by_subject_id IS NULL OR char_length(set_by_subject_id) BETWEEN 1 AND 512),
  CONSTRAINT vault_item_use_only_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES managed_accounts(id) ON DELETE CASCADE,
  CONSTRAINT vault_item_use_only_item_id_fkey FOREIGN KEY (item_id)
    REFERENCES vault_items(id) ON DELETE CASCADE
);
COMMENT ON TABLE vault_item_use_only IS 'Vault items whose values are never revealed again; agents still use them by reference.';

CREATE INDEX vault_item_use_only_item_idx ON vault_item_use_only (item_id);

ALTER TABLE vault_item_use_only ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_item_use_only FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON vault_item_use_only
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

REVOKE ALL ON TABLE vault_item_use_only FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE 'REVOKE ALL ON TABLE vault_item_use_only FROM opengeni_app';
    EXECUTE 'GRANT SELECT, INSERT ON TABLE vault_item_use_only TO opengeni_app';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION read_vault_field_ciphertext(p_field uuid, p_version integer, p_purpose text, p_principal jsonb DEFAULT NULL::jsonb, p_metadata jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  context jsonb;
  field_row vault_item_fields;
  item_row vault_items;
  vault_row vaults;
  wanted integer;
  cipher text;
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal);
  IF p_purpose NOT IN ('reveal', 'agent_read', 'internal') OR p_purpose IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'unknown read purpose');
  END IF;
  SELECT field.* INTO field_row FROM vault_item_fields field
  WHERE field.id = p_field AND field.account_id = (context ->> 'accountId')::uuid;
  IF NOT FOUND THEN
    PERFORM opengeni_private.vault_raise('vault_field_not_found', 'field not found',
      pg_catalog.jsonb_build_object('fieldId', p_field));
  END IF;
  item_row := opengeni_private.vault_reachable_item(context, field_row.item_id);
  SELECT vault.* INTO vault_row FROM vaults vault WHERE vault.id = item_row.vault_id;
  -- Use-only items: values are used by reference, never shown or read out.
  IF p_purpose IN ('reveal', 'agent_read') AND EXISTS (
    SELECT 1 FROM vault_item_use_only mark
    WHERE mark.account_id = item_row.account_id AND mark.item_id = item_row.id
  ) THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied',
      item_row.name || ' is use-only: its values can be used by reference, never shown or copied',
      pg_catalog.jsonb_build_object('itemId', item_row.id, 'reason', 'use_only'));
  END IF;
  IF field_row.current_version IS NOT NULL THEN
    wanted := coalesce(p_version, field_row.current_version);
    SELECT version.value_encrypted INTO cipher FROM vault_field_versions version
    WHERE version.field_id = field_row.id AND version.version = wanted;
    IF cipher IS NULL THEN
      PERFORM opengeni_private.vault_raise('vault_field_not_found', 'version not found',
        pg_catalog.jsonb_build_object('fieldId', p_field, 'version', wanted));
    END IF;
  ELSIF p_version IS NOT NULL THEN
    PERFORM opengeni_private.vault_raise('vault_field_not_found', 'connected fields have no stored versions',
      pg_catalog.jsonb_build_object('fieldId', p_field));
  END IF;
  IF p_purpose <> 'internal' THEN
    PERFORM opengeni_private.vault_audit(item_row.account_id, (context ->> 'workspaceId')::uuid,
      context ->> 'subjectId',
      CASE p_purpose WHEN 'reveal' THEN 'vault.field.revealed' ELSE 'vault.secret.read' END,
      'vault_item', item_row.id::text,
      coalesce(p_metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
        'vaultId', vault_row.id, 'itemId', item_row.id, 'itemName', item_row.name,
        'fieldId', field_row.id, 'fieldName', field_row.name, 'version', wanted,
        'sessionId', context ->> 'sessionId'));
  END IF;
  result := pg_catalog.jsonb_build_object(
    'valueEncrypted', cipher,
    'version', wanted,
    'currentVersion', field_row.current_version,
    'kind', field_row.kind,
    'fieldId', field_row.id,
    'fieldName', field_row.name,
    'fileName', field_row.file_name,
    'itemId', item_row.id,
    'itemName', item_row.name,
    'itemType', item_row.type,
    'vaultId', vault_row.id,
    'vaultName', vault_row.name,
    'vaultOwnerKind', vault_row.owner_kind,
    'source', vault_row.source,
    'providerConnectionId', vault_row.provider_connection_id,
    'providerVaultRef', vault_row.provider_vault_ref,
    'providerCacheEpoch', vault_row.provider_cache_epoch::text,
    'providerItemRef', item_row.provider_item_ref,
    'providerFieldRef', field_row.provider_field_ref
  );
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

DO $use_only_search_paths$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION read_vault_field_ciphertext(uuid, integer, text, jsonb, jsonb) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    current_schema()
  );
END $use_only_search_paths$;

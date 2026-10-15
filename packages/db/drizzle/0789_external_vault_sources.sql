-- deployment-mode: rolling
-- External vault providers (docs/design/external-vaults-2026-10-15.md, sections
-- 6, 8, 9 and 10).
--   * New source identities: `external` (remote bridge), `protonpass`,
--     `keeper` and `bitwarden`. Each is linked through a connection, like
--     1Password; `host` keeps its injected, connection-less provider.
--   * Linking checks provider identity, active connection status and
--     ownership here as well as in HTTP. A personal connection backs only its
--     owner's Only-me vaults; a shared connection backs only vaults of its own
--     ownership, so an organization connection never becomes a workspace one.
--     A legacy 1Password connection without recorded ownership stays a
--     workspace connection, as the API has always shown it.
--   * A linked vault keeps the effective operations its provider last
--     reported, the provider's own freshness observation (never Opengeni's
--     check time), and a durable cache epoch. Every complete mirror
--     replacement advances the epoch, so per-attempt value caches in any API
--     or worker process notice a refresh made elsewhere.
--   * A mirror replacement holds at most the native 2,000 items per vault; a
--     larger inventory is refused whole, never stored as its first 2,000.
--   * Mirror replacements of one vault run one at a time: each holds the
--     vault row lock from before it reads the mirror until it commits, so an
--     older listing cannot re-add an item that a newer one just removed and
--     leave it under the newer content version.
-- Existing rows keep their meaning: the new columns are NULL or 0 and the
-- Only-me availability default of 0780 is unchanged.
SET LOCAL lock_timeout = '5s';

ALTER TABLE vaults DROP CONSTRAINT vaults_source_check;
ALTER TABLE vaults DROP CONSTRAINT vaults_provider_shape;
ALTER TABLE vaults
  ADD COLUMN provider_operations jsonb,
  ADD COLUMN provider_freshness jsonb,
  ADD COLUMN provider_cache_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE vaults ADD CONSTRAINT vaults_source_check CHECK (
  source IN ('opengeni', 'onepassword', 'host', 'external', 'protonpass', 'keeper', 'bitwarden')
);
ALTER TABLE vaults ADD CONSTRAINT vaults_provider_shape CHECK (
  (source = 'opengeni' AND provider_vault_ref IS NULL AND provider_connection_id IS NULL
    AND mode = 'read_write')
  OR (source IN ('onepassword', 'external', 'protonpass', 'keeper', 'bitwarden')
    AND provider_vault_ref IS NOT NULL AND provider_connection_id IS NOT NULL)
  OR (source = 'host' AND provider_vault_ref IS NOT NULL AND provider_connection_id IS NULL)
);
ALTER TABLE vaults ADD CONSTRAINT vaults_provider_metadata_shape CHECK (
  provider_cache_epoch >= 0
  AND (provider_operations IS NULL
    OR (source <> 'opengeni' AND jsonb_typeof(provider_operations) = 'object'))
  AND (provider_freshness IS NULL
    OR (source <> 'opengeni' AND jsonb_typeof(provider_freshness) = 'object'))
);

-- Rewrites one routine in place. Each patch must match exactly once, so a
-- routine that changed since this was written fails the migration loudly.
-- The name is migration-specific because earlier migrations leave their own
-- patcher in the migrator session's pg_temp schema.
CREATE FUNCTION pg_temp.patch_vault_routine_0786(p_routine regprocedure, p_patches text[])
RETURNS void
LANGUAGE plpgsql AS $patch$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(p_routine);
  patch text[];
BEGIN
  FOREACH patch SLICE 1 IN ARRAY p_patches LOOP
    IF (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, patch[1], '')))
      <> pg_catalog.length(patch[1]) THEN
      RAISE EXCEPTION '0789 external vault sources: % changed near: %', p_routine, patch[1];
    END IF;
    definition := pg_catalog.replace(definition, patch[1], patch[2]);
  END LOOP;
  EXECUTE definition;
END
$patch$;

-- Summaries carry the provider's operations, freshness observation and cache epoch.
SELECT pg_temp.patch_vault_routine_0786('opengeni_private.vault_summary_json(vaults,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$    'providerVaultRef', p_vault.provider_vault_ref,
$old$,
    $new$    'providerVaultRef', p_vault.provider_vault_ref,
    'providerOperations', p_vault.provider_operations,
    'providerFreshness', p_vault.provider_freshness,
    'providerCacheEpoch', p_vault.provider_cache_epoch::text,
$new$]
]);

-- Link: every connected source needs an active connection of that provider
-- whose ownership matches the vault it backs.
SELECT pg_temp.patch_vault_routine_0786('link_provider_vault(jsonb,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$  connection_row record;
$old$,
    $new$  connection_row record;
  connection_ownership text;
  provider_label text;
$new$],
  ARRAY[$old$  IF link_source NOT IN ('onepassword', 'host') OR link_source IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'only 1Password and host vaults are linked');
  END IF;
$old$,
    $new$  IF link_source NOT IN ('onepassword', 'host', 'external', 'protonpass', 'keeper', 'bitwarden')
    OR link_source IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'only connected vault providers are linked');
  END IF;
$new$],
  ARRAY[$old$  IF link_source = 'onepassword' THEN
    SELECT connection.id, connection.subject_id, connection.status INTO connection_row
    FROM connections connection
    WHERE connection.id = connection_ref
      AND connection.account_id = (context ->> 'accountId')::uuid
      AND connection.workspace_id = (context ->> 'workspaceId')::uuid
      AND pg_catalog.lower(connection.provider_domain) = '1password.com';
    IF connection_row.id IS NULL THEN
      PERFORM opengeni_private.vault_raise('vault_not_found', '1Password connection not found');
    END IF;
    IF connection_row.subject_id IS NOT NULL AND (
      owner_kind <> 'user' OR connection_row.subject_id IS DISTINCT FROM context ->> 'subjectId'
    ) THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied',
        'a personal 1Password connection backs only its owner''s Only-me vaults');
    END IF;
  ELSE
$old$,
    $new$  IF link_source <> 'host' THEN
    provider_label := CASE link_source
      WHEN 'onepassword' THEN '1Password'
      WHEN 'protonpass' THEN 'Proton Pass'
      WHEN 'keeper' THEN 'Keeper'
      WHEN 'bitwarden' THEN 'Bitwarden'
      ELSE 'vault provider' END;
    SELECT connection.id, connection.subject_id, connection.status, connection.metadata
    INTO connection_row
    FROM connections connection
    WHERE connection.id = connection_ref
      AND connection.account_id = (context ->> 'accountId')::uuid
      AND connection.workspace_id = (context ->> 'workspaceId')::uuid
      AND connection.kind = 'api_key'
      AND CASE WHEN link_source = 'onepassword' THEN
          pg_catalog.lower(connection.provider_domain) = '1password.com'
          AND connection.metadata ->> 'credentialRole' = 'onepassword_service_account'
        ELSE
          connection.provider_domain = 'vault:' || link_source
          AND connection.metadata ->> 'credentialRole' = 'external_vault_provider'
          AND connection.metadata #>> '{vaultProvider,provider}' = link_source
          AND connection.metadata #>> '{vaultProvider,version}' = '1'
        END;
    IF connection_row.id IS NULL OR connection_row.status = 'revoked' THEN
      PERFORM opengeni_private.vault_raise('vault_not_found', provider_label || ' connection not found');
    END IF;
    IF connection_row.status <> 'active'
      OR coalesce(connection_row.metadata #>> '{vaultProvider,verificationStatus}', 'ready') <> 'ready' THEN
      PERFORM opengeni_private.vault_raise('provider_auth_expired',
        'the ' || provider_label || ' connection must be verified again before its vaults are linked',
        pg_catalog.jsonb_build_object('connectionId', connection_row.id));
    END IF;
    connection_ownership := CASE
      WHEN link_source <> 'onepassword' THEN connection_row.metadata #>> '{vaultProvider,ownership}'
      WHEN connection_row.subject_id IS NOT NULL THEN 'user'
      WHEN connection_row.metadata ->> 'ownership' = 'organization' THEN 'organization'
      WHEN connection_row.metadata ->> 'ownership' = 'user' THEN NULL
      ELSE 'workspace' END;
    IF connection_ownership IS NULL
      OR connection_ownership NOT IN ('user', 'workspace', 'organization')
      OR (connection_ownership = 'user') <> (connection_row.subject_id IS NOT NULL) THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied',
        'the ' || provider_label || ' connection has no consistent owner',
        pg_catalog.jsonb_build_object('connectionId', connection_row.id));
    END IF;
    IF connection_ownership = 'user' AND (
      owner_kind <> 'user' OR connection_row.subject_id IS DISTINCT FROM context ->> 'subjectId'
    ) THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied',
        'a personal ' || provider_label || ' connection backs only its owner''s Only-me vaults');
    END IF;
    IF connection_ownership <> owner_kind THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied',
        'a ' || connection_ownership || ' ' || provider_label || ' connection backs only '
          || connection_ownership || ' vaults',
        pg_catalog.jsonb_build_object('connectionId', connection_row.id,
          'connectionOwnership', connection_ownership, 'ownerKind', owner_kind));
    END IF;
  ELSE
$new$]
]);

-- Mirror replacement: a complete inventory of at most 2,000 items, applied
-- under the vault row lock, and every replacement advances the cache epoch.
-- The lock is FOR NO KEY UPDATE, the strength the routine's own final UPDATE
-- of the vault takes anyway, so it adds no new conflicts: it is only taken
-- before the mirror is read rather than after it is rewritten. Every later
-- statement sees what a replacement that held the lock before committed.
SELECT pg_temp.patch_vault_routine_0786('upsert_provider_vault_items(uuid,text,jsonb,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$  kept_refs := ARRAY(SELECT element ->> 'providerItemRef'
$old$,
    $new$  SELECT locked.* INTO vault_row FROM vaults locked
  WHERE locked.id = vault_row.id
  FOR NO KEY UPDATE OF locked;
  IF vault_row.id IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_not_found', 'vault not found');
  ELSIF vault_row.source = 'opengeni' THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'only connected vaults have a provider mirror');
  END IF;
  IF pg_catalog.jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' THEN
    PERFORM opengeni_private.vault_raise('provider_inventory_incomplete',
      'the provider inventory is malformed; the previous inventory was kept');
  ELSIF pg_catalog.jsonb_array_length(p_items) > 2000 THEN
    PERFORM opengeni_private.vault_raise('provider_inventory_incomplete',
      'a connected vault mirrors at most 2000 items; the previous inventory was kept',
      pg_catalog.jsonb_build_object('vaultId', vault_row.id, 'limit', 2000));
  END IF;
  kept_refs := ARRAY(SELECT element ->> 'providerItemRef'
$new$],
  ARRAY[$old$  UPDATE vaults SET provider_content_version = p_content_version, last_synced_at = pg_catalog.now(),
$old$,
    $new$  UPDATE vaults SET provider_content_version = p_content_version, last_synced_at = pg_catalog.now(),
    provider_cache_epoch = provider_cache_epoch + 1,
$new$]
]);

-- Sync status also records the provider's effective operations and its own
-- freshness observation (both optional; a JSON null clears them).
SELECT pg_temp.patch_vault_routine_0786('set_vault_sync_status(uuid,jsonb,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$  UPDATE vaults SET
    sync_status = p ->> 'status',
$old$,
    $new$  IF p ? 'operations' AND (
    pg_catalog.jsonb_typeof(p -> 'operations') NOT IN ('object', 'null')
    OR pg_catalog.octet_length((p -> 'operations')::text) > 4096) THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied',
      'provider operations must be a small JSON object');
  END IF;
  IF p ? 'freshness' AND (
    pg_catalog.jsonb_typeof(p -> 'freshness') NOT IN ('object', 'null')
    OR pg_catalog.octet_length((p -> 'freshness')::text) > 1024) THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied',
      'provider freshness must be a small JSON object');
  END IF;
  UPDATE vaults SET
    sync_status = p ->> 'status',
$new$],
  ARRAY[$old$    last_synced_at = CASE WHEN p ->> 'status' = 'ok' THEN pg_catalog.now() ELSE last_synced_at END,
$old$,
    $new$    last_synced_at = CASE WHEN p ->> 'status' = 'ok' THEN pg_catalog.now() ELSE last_synced_at END,
    provider_operations = CASE WHEN p ? 'operations'
      THEN nullif(p -> 'operations', 'null'::jsonb) ELSE provider_operations END,
    provider_freshness = CASE WHEN p ? 'freshness'
      THEN nullif(p -> 'freshness', 'null'::jsonb) ELSE provider_freshness END,
$new$]
]);

-- What a sync, a read and a resolution need to key provider value caches.
SELECT pg_temp.patch_vault_routine_0786('provider_vault_sync_target(uuid,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$    'providerContentVersion', vault_row.provider_content_version,
$old$,
    $new$    'providerContentVersion', vault_row.provider_content_version,
    'providerCacheEpoch', vault_row.provider_cache_epoch::text,
$new$]
]);
SELECT pg_temp.patch_vault_routine_0786('read_vault_field_ciphertext(uuid,integer,text,jsonb,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$    'providerVaultRef', vault_row.provider_vault_ref,
$old$,
    $new$    'providerVaultRef', vault_row.provider_vault_ref,
    'providerCacheEpoch', vault_row.provider_cache_epoch::text,
$new$]
]);
SELECT pg_temp.patch_vault_routine_0786('resolve_secret_reference_candidates(jsonb,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$    'providerVaultRef', vault.provider_vault_ref,
$old$,
    $new$    'providerVaultRef', vault.provider_vault_ref,
    'providerCacheEpoch', vault.provider_cache_epoch::text,
$new$]
]);

DROP FUNCTION pg_temp.patch_vault_routine_0786(regprocedure, text[]);

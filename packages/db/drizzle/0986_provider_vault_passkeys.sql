-- deployment-mode: rolling
-- Passkeys held by a connected password manager (a Bitwarden login with a
-- passkey, a Keeper or Proton Pass passkey) become visible and usable:
--   * `vault_items.provider_passkeys` keeps what the provider reports about
--     an item's passkeys without any key material: a list of
--     {credentialId, rpId, userName}. NULL means the item has none (or its
--     provider does not report passkeys). Key material is never mirrored; it
--     is read live from the provider when a browser needs it.
--   * An inventory item may carry `passkeys`. Present, it replaces the stored
--     list (an empty list clears it) and a change advances the generation.
--     Absent (earlier releases, providers without passkeys), the stored list
--     is kept, so the previous release never erases what this one mirrored.
--   * Item JSON gains `providerPasskeys`.
--   * Listing with type `passkey` also finds connected items that hold one.
--   * Leasing passkeys for a browser also leases connected items that hold
--     one, and their sign count can be recorded like a hosted passkey's.
--     `vault_items_passkey_shape` therefore only requires a hosted passkey
--     item to have a sign count; a connected login keeps the count it was
--     given even after its provider stops reporting the passkey.
-- The previous release ignores the new column and JSON key, and the routines
-- keep their signatures.
SET LOCAL lock_timeout = '5s';

ALTER TABLE vault_items ADD COLUMN provider_passkeys jsonb;
ALTER TABLE vault_items ADD CONSTRAINT vault_items_provider_passkeys_check
  CHECK (provider_passkeys IS NULL OR (pg_catalog.jsonb_typeof(provider_passkeys) = 'array'
    AND pg_catalog.jsonb_array_length(provider_passkeys) BETWEEN 1 AND 32)) NOT VALID;
ALTER TABLE vault_items DROP CONSTRAINT vault_items_passkey_shape;
ALTER TABLE vault_items ADD CONSTRAINT vault_items_passkey_shape
  CHECK (type <> 'passkey' OR passkey_sign_count IS NOT NULL) NOT VALID;

-- Rewrites one routine in place. Each patch must match exactly once, so a
-- routine that changed since this was written fails the migration loudly.
CREATE FUNCTION pg_temp.patch_vault_routine_0986(p_routine regprocedure, p_patches text[])
RETURNS void
LANGUAGE plpgsql AS $patch$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(p_routine);
  patch text[];
BEGIN
  FOREACH patch SLICE 1 IN ARRAY p_patches LOOP
    IF (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, patch[1], '')))
      <> pg_catalog.length(patch[1]) THEN
      RAISE EXCEPTION '0986 provider vault passkeys: % changed near: %', p_routine, patch[1];
    END IF;
    definition := pg_catalog.replace(definition, patch[1], patch[2]);
  END LOOP;
  EXECUTE definition;
END
$patch$;

SELECT pg_temp.patch_vault_routine_0986('upsert_provider_vault_items(uuid,text,jsonb,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$  item_category text;
$old$, $new$  item_category text;
  item_passkeys jsonb;
$new$],
  ARRAY[$old$      THEN item_input ->> 'category' END;
$old$, $new$      THEN item_input ->> 'category' END;
    -- Metadata only, at most 32 per item; an empty list is stored as NULL.
    item_passkeys := CASE WHEN pg_catalog.jsonb_typeof(item_input -> 'passkeys') = 'array' THEN (
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'credentialId', passkey.value ->> 'credentialId',
          'rpId', pg_catalog.lower(passkey.value ->> 'rpId'),
          'userName', CASE WHEN pg_catalog.jsonb_typeof(passkey.value -> 'userName') = 'string'
            THEN pg_catalog.left(passkey.value ->> 'userName', 512) END)
        ORDER BY passkey.ordinal)
      FROM pg_catalog.jsonb_array_elements(item_input -> 'passkeys')
        WITH ORDINALITY AS passkey(value, ordinal)
      WHERE passkey.ordinal <= 32
        AND pg_catalog.jsonb_typeof(passkey.value -> 'credentialId') = 'string'
        AND passkey.value ->> 'credentialId' ~ '^[A-Za-z0-9_-]+$'
        AND pg_catalog.length(passkey.value ->> 'credentialId') <= 1366
        AND pg_catalog.jsonb_typeof(passkey.value -> 'rpId') = 'string'
        AND pg_catalog.length(passkey.value ->> 'rpId') BETWEEN 1 AND 253) END;
$new$],
  ARRAY[$old$        archived_at, category)
$old$, $new$        archived_at, category, provider_passkeys)
$new$],
  ARRAY[$old$        nullif(item_input ->> 'archivedAt', '')::timestamptz, item_category)
$old$, $new$        nullif(item_input ->> 'archivedAt', '')::timestamptz, item_category, item_passkeys)
$new$],
  ARRAY[$old$        username_hint_encrypted = item_input ->> 'usernameHintEncrypted',
        generation = CASE WHEN provider_version IS DISTINCT FROM item_input ->> 'providerVersion'
$old$, $new$        username_hint_encrypted = item_input ->> 'usernameHintEncrypted',
        provider_passkeys = CASE WHEN item_input ? 'passkeys' THEN item_passkeys
          ELSE provider_passkeys END,
        generation = CASE WHEN provider_version IS DISTINCT FROM item_input ->> 'providerVersion'
          OR (item_input ? 'passkeys' AND provider_passkeys IS DISTINCT FROM item_passkeys)
$new$]
]);

SELECT pg_temp.patch_vault_routine_0986('opengeni_private.vault_item_json(vault_items,boolean)'::regprocedure, ARRAY[
  ARRAY[$old$    'passkeySignCount', p_item.passkey_sign_count,
$old$, $new$    'passkeySignCount', p_item.passkey_sign_count,
    'providerPasskeys', p_item.provider_passkeys,
$new$]
]);

SELECT pg_temp.patch_vault_routine_0986('list_vault_items(uuid,text,text,boolean,text,integer,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$      AND (p_type IS NULL OR item.type = p_type)
$old$, $new$      AND (p_type IS NULL OR item.type = p_type
        OR (p_type = 'passkey' AND item.provider_passkeys IS NOT NULL))
$new$]
]);

SELECT pg_temp.patch_vault_routine_0986('lease_vault_passkeys(jsonb,text,integer)'::regprocedure, ARRAY[
  ARRAY[$old$    WHERE item.type = 'passkey' AND item.archived_at IS NULL
$old$, $new$    WHERE (item.type = 'passkey' OR item.provider_passkeys IS NOT NULL)
      AND item.archived_at IS NULL
$new$]
]);

SELECT pg_temp.patch_vault_routine_0986('update_passkey_sign_count(uuid,bigint,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$  IF item_row.type <> 'passkey' THEN
$old$, $new$  IF item_row.type <> 'passkey' AND item_row.provider_passkeys IS NULL THEN
$new$]
]);

DROP FUNCTION pg_temp.patch_vault_routine_0986(regprocedure, text[]);

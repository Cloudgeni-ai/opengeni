-- deployment-mode: rolling
-- Connected-vault username display hints use the existing envelope key. Field
-- values remain provider-resolved. Older writers omit the hint and clear it;
-- older readers ignore the additive JSON property. No plaintext is backfilled.
SET LOCAL lock_timeout = '5s';

ALTER TABLE vault_items ADD COLUMN username_hint_encrypted text;

-- Keep the existing authorization, capability and epoch fences intact. Assert
-- each exact replacement so schema drift cannot silently omit part of the fix.
CREATE FUNCTION pg_temp.patch_vault_username_hint(p_routine regprocedure, p_patches text[][])
RETURNS void LANGUAGE plpgsql AS $patch$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(p_routine);
  patch text[];
BEGIN
  FOREACH patch SLICE 1 IN ARRAY p_patches LOOP
    IF (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, patch[1], '')))
      <> pg_catalog.length(patch[1]) THEN
      RAISE EXCEPTION 'vault username hint: % changed near: %', p_routine, patch[1];
    END IF;
    definition := pg_catalog.replace(definition, patch[1], patch[2]);
  END LOOP;
  EXECUTE definition;
END
$patch$;

SELECT pg_temp.patch_vault_username_hint('upsert_provider_vault_items(uuid,text,jsonb,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$INSERT INTO vault_items (account_id, vault_id, type, name, websites, provider_item_ref, provider_version)$old$,
    $new$INSERT INTO vault_items (account_id, vault_id, type, name, websites, provider_item_ref, provider_version, username_hint_encrypted)$new$],
  ARRAY[$old$item_input ->> 'providerItemRef', item_input ->> 'providerVersion')$old$,
    $new$item_input ->> 'providerItemRef', item_input ->> 'providerVersion', item_input ->> 'usernameHintEncrypted')$new$],
  ARRAY[$old$provider_version = item_input ->> 'providerVersion', archived_at = NULL,$old$,
    $new$provider_version = item_input ->> 'providerVersion', archived_at = NULL,
        username_hint_encrypted = item_input ->> 'usernameHintEncrypted',$new$]
]);

SELECT pg_temp.patch_vault_username_hint('opengeni_private.vault_item_json(vault_items,boolean)'::regprocedure, ARRAY[
  ARRAY[$old$'websites', pg_catalog.to_jsonb(p_item.websites),$old$,
    $new$'websites', pg_catalog.to_jsonb(p_item.websites),
    'usernameHintEncrypted', p_item.username_hint_encrypted,$new$]
]);

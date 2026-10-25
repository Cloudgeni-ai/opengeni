-- deployment-mode: rolling
-- A connected vault's mirror keeps the items its connected account archived
-- upstream, marked archived, instead of dropping them:
--   * An inventory item may carry `archivedAt`. Such an item is mirrored with
--     `archived_at` set (the first time it was seen archived is kept), so it
--     is hidden from listings unless archived items are asked for, and a
--     reference to it resolves as archived rather than missing.
--   * Archived items take no part in name de-duplication (the item-name index
--     only covers active items): they keep their name and never push an
--     active item to a "Name (2)" suffix. They are placed first, so an item
--     archived since the last sync frees its name before active items are
--     named. An item restored upstream is named again like any active item.
--   * Archiving or restoring upstream advances the item's generation.
-- Inventories without `archivedAt` (earlier releases) mean what they always
-- meant: every listed item is active, so the previous release is unaffected.
--
-- Every item type a supported provider has is now an item type here too:
--   * `card`, `identity` and `ssh_key` join login, api_key, note, file and
--     passkey. Their default primary fields are a card's "number" and an SSH
--     key's "private key"; an identity, like a passkey, has no default and
--     takes its first secret field.
--   * `category` keeps a provider's more specific kind of item (a 1Password
--     database item is an `api_key` with category "database"), so an item
--     keeps it when moved or copied. Null is the plain type.
--   * Connected-vault inventories may carry the new types and a category;
--     an unknown type still falls back to login, as before.
-- The type and category checks are added NOT VALID and validated by the next
-- migration. The previous release never writes the new types or a category,
-- and the routines it calls keep their signatures.
SET LOCAL lock_timeout = '5s';

ALTER TABLE vault_items ADD COLUMN category text;
ALTER TABLE vault_items ADD CONSTRAINT vault_items_category_check
  CHECK (category IS NULL OR category ~ '^[a-z][a-z0-9_]{0,63}$') NOT VALID;
ALTER TABLE vault_items DROP CONSTRAINT vault_items_type_check;
ALTER TABLE vault_items ADD CONSTRAINT vault_items_type_check
  CHECK (type IN ('login', 'api_key', 'note', 'file', 'passkey', 'card', 'identity', 'ssh_key')) NOT VALID;

-- Rewrites one routine in place. Each patch must match exactly once, so a
-- routine that changed since this was written fails the migration loudly.
CREATE FUNCTION pg_temp.patch_vault_routine_0957(p_routine regprocedure, p_patches text[])
RETURNS void
LANGUAGE plpgsql AS $patch$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(p_routine);
  patch text[];
BEGIN
  FOREACH patch SLICE 1 IN ARRAY p_patches LOOP
    IF (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, patch[1], '')))
      <> pg_catalog.length(patch[1]) THEN
      RAISE EXCEPTION '0966 provider vault archived items: % changed near: %', p_routine, patch[1];
    END IF;
    definition := pg_catalog.replace(definition, patch[1], patch[2]);
  END LOOP;
  EXECUTE definition;
END
$patch$;

SELECT pg_temp.patch_vault_routine_0957('upsert_provider_vault_items(uuid,text,jsonb,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$  item_type text;
$old$,
    $new$  item_type text;
  item_category text;
$new$],
  ARRAY[$old$    ORDER BY EXISTS (SELECT 1 FROM vault_items mirrored WHERE mirrored.vault_id = vault_row.id
$old$,
    $new$    ORDER BY nullif(input.element ->> 'archivedAt', '') IS NOT NULL DESC,
      EXISTS (SELECT 1 FROM vault_items mirrored WHERE mirrored.vault_id = vault_row.id
$new$],
  ARRAY[$old$      AND NOT EXISTS (SELECT 1 FROM vault_items other WHERE other.vault_id = vault_row.id
        AND other.archived_at IS NULL AND other.name_key = item_row.name_key
        AND other.id <> item_row.id) THEN
$old$,
    $new$      AND (nullif(item_input ->> 'archivedAt', '') IS NOT NULL
        OR NOT EXISTS (SELECT 1 FROM vault_items other WHERE other.vault_id = vault_row.id
        AND other.archived_at IS NULL AND other.name_key = item_row.name_key
        AND other.id <> item_row.id)) THEN
$new$],
  ARRAY[$old$      WHILE EXISTS (SELECT 1 FROM vault_items other WHERE other.vault_id = vault_row.id
$old$,
    $new$      WHILE nullif(item_input ->> 'archivedAt', '') IS NULL
        AND EXISTS (SELECT 1 FROM vault_items other WHERE other.vault_id = vault_row.id
$new$],
  ARRAY[$old$      INSERT INTO vault_items (account_id, vault_id, type, name, websites, provider_item_ref, provider_version, username_hint_encrypted)
$old$,
    $new$      INSERT INTO vault_items (account_id, vault_id, type, name, websites, provider_item_ref, provider_version, username_hint_encrypted,
        archived_at, category)
$new$],
  ARRAY[$old$        item_input ->> 'providerItemRef', item_input ->> 'providerVersion', item_input ->> 'usernameHintEncrypted')
      RETURNING * INTO item_row;
$old$,
    $new$        item_input ->> 'providerItemRef', item_input ->> 'providerVersion', item_input ->> 'usernameHintEncrypted',
        nullif(item_input ->> 'archivedAt', '')::timestamptz, item_category)
      RETURNING * INTO item_row;
$new$],
  ARRAY[$old$      UPDATE vault_items SET type = item_type, name = candidate,
$old$,
    $new$      UPDATE vault_items SET type = item_type, category = item_category, name = candidate,
$new$],
  ARRAY[$old$        provider_version = item_input ->> 'providerVersion', archived_at = NULL,
        username_hint_encrypted = item_input ->> 'usernameHintEncrypted',
        generation = CASE WHEN provider_version IS DISTINCT FROM item_input ->> 'providerVersion'
          THEN generation + 1 ELSE generation END,
$old$,
    $new$        provider_version = item_input ->> 'providerVersion',
        archived_at = CASE WHEN nullif(item_input ->> 'archivedAt', '') IS NULL THEN NULL
          ELSE coalesce(archived_at, (item_input ->> 'archivedAt')::timestamptz) END,
        username_hint_encrypted = item_input ->> 'usernameHintEncrypted',
        generation = CASE WHEN provider_version IS DISTINCT FROM item_input ->> 'providerVersion'
          OR (archived_at IS NULL) <> (nullif(item_input ->> 'archivedAt', '') IS NULL)
          THEN generation + 1 ELSE generation END,
$new$],
  ARRAY[$old$    item_type := CASE WHEN item_input ->> 'type' IN ('login', 'api_key', 'note', 'file')
      THEN item_input ->> 'type' ELSE 'login' END;
$old$,
    $new$    item_type := CASE WHEN item_input ->> 'type' IN ('login', 'api_key', 'note', 'file', 'card', 'identity',
        'ssh_key') THEN item_input ->> 'type' ELSE 'login' END;
    item_category := CASE WHEN item_input ->> 'category' ~ '^[a-z][a-z0-9_]{0,63}$'
      THEN item_input ->> 'category' END;
$new$],
  ARRAY[$old$        (field.name_key = CASE item_type WHEN 'login' THEN 'password' WHEN 'api_key' THEN 'value'
          WHEN 'note' THEN 'note' ELSE 'file' END) DESC,
$old$,
    $new$        (field.name_key = CASE item_type WHEN 'login' THEN 'password' WHEN 'api_key' THEN 'value'
          WHEN 'note' THEN 'note' WHEN 'card' THEN 'number' WHEN 'ssh_key' THEN 'private key'
          WHEN 'identity' THEN NULL ELSE 'file' END) DESC NULLS LAST,
$new$]
]);

SELECT pg_temp.patch_vault_routine_0957('opengeni_private.vault_item_json(vault_items,boolean)'::regprocedure, ARRAY[
  ARRAY[$old$    'type', p_item.type,
$old$,
    $new$    'type', p_item.type,
    'category', p_item.category,
$new$]
]);

SELECT pg_temp.patch_vault_routine_0957('opengeni_private.vault_write_item(jsonb,vaults,vault_items,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$    IF new_type NOT IN ('login', 'api_key', 'note', 'file', 'passkey') THEN
$old$,
    $new$    IF new_type NOT IN ('login', 'api_key', 'note', 'file', 'passkey', 'card', 'identity', 'ssh_key') THEN
$new$],
  ARRAY[$old$      OR new_type NOT IN ('login', 'api_key', 'note', 'file', 'passkey') THEN
$old$,
    $new$      OR new_type NOT IN ('login', 'api_key', 'note', 'file', 'passkey', 'card', 'identity', 'ssh_key') THEN
$new$],
  ARRAY[$old$    IF new_type NOT IN ('login', 'api_key', 'note', 'file', 'passkey', 'card', 'identity', 'ssh_key') THEN
      PERFORM opengeni_private.vault_raise('invalid_secret_name', 'unknown item type',
        pg_catalog.jsonb_build_object('type', new_type));
    END IF;
$old$,
    $new$    IF new_type NOT IN ('login', 'api_key', 'note', 'file', 'passkey', 'card', 'identity', 'ssh_key') THEN
      PERFORM opengeni_private.vault_raise('invalid_secret_name', 'unknown item type',
        pg_catalog.jsonb_build_object('type', new_type));
    END IF;
    IF nullif(p ->> 'category', '') !~ '^[a-z][a-z0-9_]{0,63}$' THEN
      PERFORM opengeni_private.vault_raise('invalid_secret_name', 'a category is a lower-case snake_case token',
        pg_catalog.jsonb_build_object('category', p ->> 'category'));
    END IF;
$new$],
  ARRAY[$old$      account_id, vault_id, type, name, websites, expires_at, passkey_sign_count, created_by_subject_id
    ) VALUES (
$old$,
    $new$      account_id, vault_id, type, name, websites, expires_at, passkey_sign_count, created_by_subject_id,
      category
    ) VALUES (
$new$],
  ARRAY[$old$      subject
    ) RETURNING * INTO item_row;
$old$,
    $new$      subject, nullif(p ->> 'category', '')
    ) RETURNING * INTO item_row;
$new$],
  ARRAY[$old$      PERFORM opengeni_private.vault_raise('invalid_secret_name', 'item type cannot change to or from passkey');
    END IF;
$old$,
    $new$      PERFORM opengeni_private.vault_raise('invalid_secret_name', 'item type cannot change to or from passkey');
    END IF;
    IF nullif(p ->> 'category', '') !~ '^[a-z][a-z0-9_]{0,63}$' THEN
      PERFORM opengeni_private.vault_raise('invalid_secret_name', 'a category is a lower-case snake_case token',
        pg_catalog.jsonb_build_object('category', p ->> 'category'));
    END IF;
$new$],
  ARRAY[$old$      type = new_type,
      websites = coalesce(websites_value, websites),
$old$,
    $new$      type = new_type,
      category = CASE WHEN p ? 'category' THEN nullif(p ->> 'category', '') ELSE category END,
      websites = coalesce(websites_value, websites),
$new$],
  ARRAY[$old$      WHEN 'note' THEN 'note' WHEN 'file' THEN 'file' END;
$old$,
    $new$      WHEN 'note' THEN 'note' WHEN 'file' THEN 'file' WHEN 'card' THEN 'number'
      WHEN 'ssh_key' THEN 'private key' END;
$new$]
]);

SELECT pg_temp.patch_vault_routine_0957('move_vault_item(uuid,uuid,text,text,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$    INSERT INTO vault_items (account_id, vault_id, type, name, websites, expires_at, passkey_sign_count, created_by_subject_id)
    VALUES (target_vault.account_id, target_vault.id, item_row.type, new_name, item_row.websites,
      item_row.expires_at, item_row.passkey_sign_count, context ->> 'subjectId')
$old$,
    $new$    INSERT INTO vault_items (account_id, vault_id, type, name, websites, expires_at, passkey_sign_count, created_by_subject_id,
      category)
    VALUES (target_vault.account_id, target_vault.id, item_row.type, new_name, item_row.websites,
      item_row.expires_at, item_row.passkey_sign_count, context ->> 'subjectId', item_row.category)
$new$]
]);

DROP FUNCTION pg_temp.patch_vault_routine_0957(regprocedure, text[]);

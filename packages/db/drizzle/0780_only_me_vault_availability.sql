-- deployment-mode: rolling
-- An Only-me vault can be limited to some of its owner's workspaces, the same
-- way an organization vault is. `allowed_workspace_ids` NULL keeps the vault
-- available everywhere its owner works (every existing vault stays that way);
-- a list limits it to those workspaces. The vault's home workspace (the
-- owner's Personal workspace when they have one) always reaches it, so an
-- owner can always find and widen a vault they narrowed.
--   * A new Only-me vault, created or linked, starts in the workspace it was
--     added from unless the request names its availability.
--   * The default "Private" vault stays available everywhere: it is where
--     Only-me saves go when no vault is named.
SET LOCAL lock_timeout = '5s';

ALTER TABLE vaults DROP CONSTRAINT vaults_owner_shape;
ALTER TABLE vaults DROP CONSTRAINT vaults_org_availability;
ALTER TABLE vaults ADD CONSTRAINT vaults_owner_shape CHECK (
  (owner_kind = 'user' AND authority_id IS NOT NULL
    AND owner_organization_membership_id IS NOT NULL
    AND root_session_id IS NULL)
  OR (owner_kind IN ('workspace', 'organization') AND authority_id IS NULL
    AND owner_organization_membership_id IS NULL AND root_session_id IS NULL)
  OR (owner_kind = 'task' AND authority_id IS NULL
    AND owner_organization_membership_id IS NULL
    AND root_session_id IS NOT NULL AND source = 'opengeni')
);
ALTER TABLE vaults ADD CONSTRAINT vaults_org_availability CHECK (
  owner_kind IN ('organization', 'user') OR allowed_workspace_ids IS NULL
);
ALTER TABLE vaults ADD CONSTRAINT vaults_default_available_everywhere CHECK (
  owner_kind <> 'user' OR NOT is_default OR allowed_workspace_ids IS NULL
);

-- A workspace list without duplicates; NULL (everywhere) and empty (only the
-- home workspace) stay as they are.
CREATE FUNCTION opengeni_private.vault_workspace_set(p_ids uuid[]) RETURNS uuid[]
LANGUAGE sql IMMUTABLE
SET search_path FROM CURRENT
AS $$
  SELECT CASE WHEN p_ids IS NULL THEN NULL
    ELSE ARRAY(SELECT DISTINCT id FROM pg_catalog.unnest(p_ids) id ORDER BY id) END
$$;
REVOKE ALL ON FUNCTION opengeni_private.vault_workspace_set(uuid[]) FROM PUBLIC;

-- Rewrites one routine in place. Each patch must match exactly once, so a
-- routine that changed since this was written fails the migration loudly.
CREATE FUNCTION pg_temp.patch_vault_routine(p_routine regprocedure, p_patches text[])
RETURNS void
LANGUAGE plpgsql AS $patch$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(p_routine);
  patch text[];
BEGIN
  FOREACH patch SLICE 1 IN ARRAY p_patches LOOP
    IF (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, patch[1], '')))
      <> pg_catalog.length(patch[1]) THEN
      RAISE EXCEPTION '0780 only-me vault availability: % changed near: %', p_routine, patch[1];
    END IF;
    definition := pg_catalog.replace(definition, patch[1], patch[2]);
  END LOOP;
  EXECUTE definition;
END
$patch$;

-- Reach: an Only-me vault reaches its owner in its home workspace and in the
-- workspaces it is available in.
SELECT pg_temp.patch_vault_routine('opengeni_private.vault_reach(jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$        AND vault.owner_organization_membership_id = (p_context ->> 'membershipId')::uuid)$old$,
    $new$        AND vault.owner_organization_membership_id = (p_context ->> 'membershipId')::uuid
        AND (vault.allowed_workspace_ids IS NULL
          OR vault.workspace_id = (p_context ->> 'workspaceId')::uuid
          OR (p_context ->> 'workspaceId')::uuid = ANY (vault.allowed_workspace_ids)))$new$]
]);

-- Insert: Only-me vaults other than the default keep the availability they are given.
SELECT pg_temp.patch_vault_routine(
  'opengeni_private.vault_insert(jsonb,text,text,text,uuid[],boolean,boolean,uuid)'::regprocedure, ARRAY[
  ARRAY[$old$    CASE WHEN p_owner_kind = 'organization' THEN p_allowed_workspace_ids END,$old$,
    $new$    CASE WHEN p_owner_kind = 'organization' THEN p_allowed_workspace_ids
      WHEN p_owner_kind = 'user' AND NOT coalesce(p_is_default, false)
        THEN opengeni_private.vault_workspace_set(p_allowed_workspace_ids)
    END,$new$]
]);

-- The default vault is available everywhere, including one promoted by name.
SELECT pg_temp.patch_vault_routine('opengeni_private.vault_ensure_default(jsonb,text)'::regprocedure, ARRAY[
  ARRAY[$old$      UPDATE vaults SET is_default = true, updated_at = pg_catalog.now()$old$,
    $new$      UPDATE vaults SET is_default = true, allowed_workspace_ids = NULL, updated_at = pg_catalog.now()$new$]
]);

-- Create and link: a new Only-me vault starts in the workspace it was added
-- from unless the request says where it is available (null: everywhere).
SELECT pg_temp.patch_vault_routine('create_vault(jsonb,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$    allowed := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p #> '{availability,allowedWorkspaceIds}')::uuid);
  END IF;
$old$,
    $new$    allowed := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p #> '{availability,allowedWorkspaceIds}')::uuid);
  END IF;
  IF owner_kind = 'user' AND NOT p ? 'availability' THEN
    allowed := ARRAY[(context ->> 'workspaceId')::uuid];
  END IF;
$new$]
]);
SELECT pg_temp.patch_vault_routine('link_provider_vault(jsonb,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$    allowed := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p #> '{availability,allowedWorkspaceIds}')::uuid);
  END IF;
$old$,
    $new$    allowed := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p #> '{availability,allowedWorkspaceIds}')::uuid);
  END IF;
  IF owner_kind = 'user' AND NOT p ? 'availability' THEN
    allowed := ARRAY[(context ->> 'workspaceId')::uuid];
  END IF;
$new$]
]);

-- Update: the owner changes where an Only-me vault is available, except for
-- their default vault.
SELECT pg_temp.patch_vault_routine('update_vault(uuid,bigint,jsonb,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$  IF vault_row.owner_kind = 'organization' AND p ? 'availability' THEN
$old$,
    $new$  IF vault_row.owner_kind = 'user' AND vault_row.is_default AND p ? 'availability'
    AND pg_catalog.jsonb_typeof(p #> '{availability,allowedWorkspaceIds}') = 'array' THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied',
      'the default Only-me vault is available in every workspace',
      pg_catalog.jsonb_build_object('vaultId', vault_row.id));
  END IF;
  IF vault_row.owner_kind IN ('organization', 'user') AND p ? 'availability' THEN
$new$],
  ARRAY[$old$    allowed_workspace_ids = CASE WHEN owner_kind = 'organization' AND p ? 'availability'
      THEN allowed ELSE allowed_workspace_ids END,$old$,
    $new$    allowed_workspace_ids = CASE
      WHEN owner_kind = 'organization' AND p ? 'availability' THEN allowed
      WHEN owner_kind = 'user' AND p ? 'availability'
        THEN opengeni_private.vault_workspace_set(allowed)
      ELSE allowed_workspace_ids END,$new$]
]);

-- Summaries report availability for Only-me vaults too.
SELECT pg_temp.patch_vault_routine('opengeni_private.vault_summary_json(vaults,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$    'availability', CASE WHEN p_vault.owner_kind = 'organization' THEN$old$,
    $new$    'availability', CASE WHEN p_vault.owner_kind IN ('organization', 'user') THEN$new$]
]);

-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: an organization holds a handful of vaults, so this update touches a few rows per deployment
-- An organization vault limited to selected workspaces can also serve
-- members' Personal workspaces, as its "Include personal workspaces" switch
-- says. Before, vault_reach required a Personal workspace to be in the
-- selected list as well, and the editor lists only shared workspaces, so the
-- switch did nothing for a selected list. Organization model keys work this
-- way since 1094: the list names shared workspaces, and Personal workspaces
-- follow the switch alone.
--
-- Existing vaults keep exactly the reach they have, or less: a vault with a
-- selected list and the switch on reached no Personal workspace (unless one
-- was named in its list through the API), so its switch is turned off here,
-- and an owner turns it on to serve Personal workspaces. Each changed vault
-- gets a new generation, so an editor opened before this migration cannot
-- save over it unseen. Only-me, workspace and task vaults are unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION opengeni_private.vault_reach(p_context jsonb) RETURNS TABLE(vault_id uuid, tier integer)
    LANGUAGE sql STABLE
    SET search_path FROM CURRENT
    AS $$
  SELECT vault.id,
    CASE vault.owner_kind WHEN 'task' THEN 0 WHEN 'user' THEN 1 WHEN 'workspace' THEN 2 ELSE 3 END
  FROM vaults vault
  WHERE vault.account_id = (p_context ->> 'accountId')::uuid
    AND (
      (vault.owner_kind = 'task'
        AND vault.workspace_id = (p_context ->> 'workspaceId')::uuid
        AND (
          (p_context ->> 'taskMode' = 'root'
            AND vault.root_session_id = (p_context ->> 'taskRoot')::uuid)
          OR (p_context ->> 'taskMode' = 'visible' AND EXISTS (
            SELECT 1 FROM sessions root_session
            WHERE root_session.workspace_id = vault.workspace_id
              AND root_session.id = vault.root_session_id
              AND (root_session.visibility = 'workspace_shared'
                OR root_session.owner_subject_id = p_context ->> 'subjectId')
          ))
        ))
      OR (vault.owner_kind = 'user'
        AND (p_context ->> 'includeUser')::boolean
        AND vault.owner_organization_membership_id = (p_context ->> 'membershipId')::uuid
        AND (vault.allowed_workspace_ids IS NULL
          OR vault.workspace_id = (p_context ->> 'workspaceId')::uuid
          OR (p_context ->> 'workspaceId')::uuid = ANY (vault.allowed_workspace_ids)))
      OR (vault.owner_kind = 'workspace'
        AND (p_context ->> 'includeShared')::boolean
        AND vault.workspace_id = (p_context ->> 'workspaceId')::uuid)
      -- A Personal workspace follows the switch alone; a shared workspace
      -- follows the list (null is every workspace).
      OR (vault.owner_kind = 'organization'
        AND (p_context ->> 'includeShared')::boolean
        AND CASE WHEN (p_context ->> 'personalWorkspace')::boolean
          THEN vault.allow_personal_workspaces
          ELSE vault.allowed_workspace_ids IS NULL
            OR (p_context ->> 'workspaceId')::uuid = ANY (vault.allowed_workspace_ids)
        END)
    )
    AND (
      vault.owner_kind = 'task'
      OR pg_catalog.jsonb_typeof(p_context -> 'policyVaultIds') IS DISTINCT FROM 'array'
      OR (p_context -> 'policyVaultIds') @> pg_catalog.jsonb_build_array(vault.id::text)
    )
$$;

-- The search path the baseline gave it: catalog first.
DO $vault_reach_search_path$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.vault_reach(jsonb) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    current_schema()
  );
END $vault_reach_search_path$;

-- The migration principal sees no rows under FORCE ROW LEVEL SECURITY; it is
-- restored before commit.
ALTER TABLE "vaults" NO FORCE ROW LEVEL SECURITY;
UPDATE vaults
SET allow_personal_workspaces = false,
    generation = generation + 1,
    updated_at = now()
WHERE owner_kind = 'organization'
  AND allowed_workspace_ids IS NOT NULL
  AND allow_personal_workspaces;
ALTER TABLE "vaults" FORCE ROW LEVEL SECURITY;

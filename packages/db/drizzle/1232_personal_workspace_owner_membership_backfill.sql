-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=500 lock-timeout=5s statement-timeout=60s
-- opengeni:post-release
-- online-safety-exception: unbatched-data: each batch inserts at most 500 owner rows chosen by its LIMIT and repeats until none remain.
-- Gives every existing managed human's Personal workspace its owner's row
-- (1231 creates it for every later change). Only where the organization
-- membership is active and its personal_workspace_id points at a workspace
-- carrying that person's Personal identity in the same organization. A row
-- the owner already has there is set to role member with exactly the owner's
-- permissions; rows of anyone else are left alone (the parity gate
-- personal_workspace_has_no_membership_row reports them). Each batch locks the
-- memberships it reads, so a concurrent suspension either waits for it (and its
-- trigger then removes the row) or is seen by it.
--
-- organization_memberships is FORCE RLS: migrate.ts runs this file with
-- opengeni.organization_tenancy_lifecycle = organization_membership_lifecycle
-- in each batch transaction, the owner policy arm the lifecycle functions use.
-- Post-release: readers still fall back to the pointer while it runs.
WITH owner_permissions AS (
  SELECT personal_workspace_owner_permissions() AS permissions
), target AS MATERIALIZED (
  SELECT membership.account_id, membership.subject_id, workspace.id AS workspace_id,
    access.id AS access_id
  FROM organization_memberships membership
  JOIN workspaces workspace
    ON workspace.id = membership.personal_workspace_id
    AND workspace.account_id = membership.account_id
    AND workspace.external_source = 'opengeni:organization-membership'
    AND workspace.external_id = membership.account_id::text || ':' || membership.subject_id
  LEFT JOIN workspace_memberships access
    ON access.workspace_id = workspace.id AND access.subject_id = membership.subject_id
  CROSS JOIN owner_permissions
  WHERE membership.status = 'active'
    AND membership.revoked_at IS NULL
    AND membership.subject_id LIKE 'user:%'
    AND (access.id IS NULL
      OR access.role IS DISTINCT FROM 'member'
      OR access.permissions IS DISTINCT FROM owner_permissions.permissions)
  ORDER BY membership.id
  LIMIT 500
  FOR SHARE OF membership
), inserted AS (
  INSERT INTO workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
  SELECT target.account_id, target.workspace_id, target.subject_id, 'member', owner_permissions.permissions
  FROM target CROSS JOIN owner_permissions
  WHERE target.access_id IS NULL
  ON CONFLICT (subject_id, workspace_id) DO NOTHING
  RETURNING id
), normalized AS (
  UPDATE workspace_memberships access
  SET role = 'member', permissions = owner_permissions.permissions, updated_at = clock_timestamp()
  FROM target CROSS JOIN owner_permissions
  WHERE access.id = target.access_id
  RETURNING access.id
)
SELECT id FROM inserted
UNION ALL
SELECT id FROM normalized

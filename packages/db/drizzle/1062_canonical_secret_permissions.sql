-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: memberships, API keys, Slack access requests and drafts hold at most a few hundred rows per deployment
-- Variable Sets were replaced by vaults. The named workspace role presets now
-- grant the canonical secrets:* permissions instead of the retired
-- variable-sets:* and environments:* names, and stored membership, API key and
-- Slack access-request permissions are rewritten to the canonical names
-- (first occurrence kept, duplicates dropped). Each retired name already
-- aliases to exactly the canonical permission it becomes, so the previous
-- release grants the same access before and after this migration.
--
-- Session, scheduled-task, OAuth token and turn grant snapshots keep their
-- recorded names: they feed execution digests and recovery fences, and the
-- aliases stay accepted until Variable Sets are dropped entirely.
--
-- New-session drafts lose their stale Variable Set selections, which no
-- release reads any more.

CREATE FUNCTION pg_temp.canonical_secret_permissions(p_permissions jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT coalesce(pg_catalog.jsonb_agg(names.name ORDER BY names.first_position), '[]'::jsonb)
  FROM (
    SELECT mapped.name, min(item.position) AS first_position
    FROM pg_catalog.jsonb_array_elements_text(p_permissions)
      WITH ORDINALITY AS item(value, position)
    CROSS JOIN LATERAL (
      SELECT CASE item.value
        WHEN 'variable-sets:list' THEN 'secrets:list'
        WHEN 'variable-sets:read' THEN 'secrets:list'
        WHEN 'variable-sets:write' THEN 'secrets:write'
        WHEN 'variable-sets:manage' THEN 'secrets:write'
        WHEN 'environments:manage' THEN 'secrets:write'
        WHEN 'variable-sets:attach' THEN 'secrets:use'
        WHEN 'variable-sets:use' THEN 'secrets:use'
        WHEN 'environments:use' THEN 'secrets:use'
        ELSE item.value
      END AS name
    ) AS mapped
    GROUP BY mapped.name
  ) AS names
$$;

CREATE OR REPLACE FUNCTION opengeni_private.workspace_member_role_permissions(p_role text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT CASE p_role
    WHEN 'viewer' THEN '[
      "workspace:read", "sessions:read", "stream:view", "files:read",
      "documents:search", "secrets:list", "connections:read",
      "rigs:use", "artifacts:read"
    ]'::jsonb
    WHEN 'member' THEN '[
      "workspace:read", "sessions:create", "sessions:read", "sessions:control",
      "stream:view", "stream:control", "stream:acknowledge", "terminal:attach",
      "codemode:call", "files:upload", "files:read", "files:write",
      "documents:manage", "documents:search", "scheduled_tasks:manage",
      "scheduled_tasks:run", "github:use", "connections:read", "connections:write",
      "secrets:list", "secrets:write", "secrets:use",
      "mcp_servers:attach", "goals:manage", "rigs:use", "rigs:manage",
      "enrollments:read", "artifacts:read", "artifacts:publish"
    ]'::jsonb
    WHEN 'admin' THEN '[
      "workspace:read", "workspace:admin", "members:manage", "sessions:create",
      "sessions:read", "sessions:control", "stream:view", "stream:control",
      "stream:acknowledge", "terminal:attach", "codemode:call", "files:upload",
      "files:read", "files:write", "documents:manage", "documents:search",
      "scheduled_tasks:manage", "scheduled_tasks:run", "github:manage",
      "github:use", "api_keys:manage", "connections:read", "connections:write",
      "secrets:list", "secrets:write", "secrets:use", "mcp_servers:attach",
      "goals:manage", "rigs:use", "rigs:manage", "enrollments:read",
      "enrollments:manage", "artifacts:read", "artifacts:publish"
    ]'::jsonb
    ELSE NULL
  END
$$;

-- Memberships still carrying a pre-0865 member preset are normalized to the
-- current member preset instead of a frozen copy of it.
CREATE OR REPLACE FUNCTION opengeni_private.normalize_legacy_member_connection_read_0516() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  pre_0516 jsonb := opengeni_private.workspace_member_legacy_permissions_0516();
  pre_0555 jsonb := opengeni_private.workspace_member_legacy_permissions_0555();
  pre_0865 jsonb := opengeni_private.workspace_member_legacy_permissions_0865();
BEGIN
  IF NEW.role = 'member'
    AND NEW.subject_id NOT LIKE 'external_user:%'
    AND (
      (NEW.permissions @> pre_0516 AND pre_0516 @> NEW.permissions)
      OR (NEW.permissions @> pre_0555 AND pre_0555 @> NEW.permissions)
      OR (NEW.permissions @> pre_0865 AND pre_0865 @> NEW.permissions)
    )
  THEN
    NEW.permissions := opengeni_private.workspace_member_role_permissions('member');
    NEW.updated_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

UPDATE workspace_memberships
SET permissions = pg_temp.canonical_secret_permissions(permissions)
WHERE permissions ?| ARRAY[
  'variable-sets:list', 'variable-sets:read', 'variable-sets:write', 'variable-sets:manage',
  'variable-sets:attach', 'variable-sets:use', 'environments:use', 'environments:manage'
];

ALTER TABLE "api_keys" NO FORCE ROW LEVEL SECURITY;
UPDATE api_keys
SET permissions = pg_temp.canonical_secret_permissions(permissions),
    owner_permissions = CASE
      WHEN owner_permissions IS NULL THEN NULL
      ELSE pg_temp.canonical_secret_permissions(owner_permissions)
    END
WHERE permissions ?| ARRAY[
    'variable-sets:list', 'variable-sets:read', 'variable-sets:write', 'variable-sets:manage',
    'variable-sets:attach', 'variable-sets:use', 'environments:use', 'environments:manage'
  ]
  OR coalesce(owner_permissions, '[]'::jsonb) ?| ARRAY[
    'variable-sets:list', 'variable-sets:read', 'variable-sets:write', 'variable-sets:manage',
    'variable-sets:attach', 'variable-sets:use', 'environments:use', 'environments:manage'
  ];
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;

ALTER TABLE "slack_user_link_access_requests" NO FORCE ROW LEVEL SECURITY;
UPDATE slack_user_link_access_requests
SET approved_permissions = pg_temp.canonical_secret_permissions(approved_permissions)
WHERE approved_permissions ?| ARRAY[
  'variable-sets:list', 'variable-sets:read', 'variable-sets:write', 'variable-sets:manage',
  'variable-sets:attach', 'variable-sets:use', 'environments:use', 'environments:manage'
];
ALTER TABLE "slack_user_link_access_requests" FORCE ROW LEVEL SECURITY;

ALTER TABLE "new_session_drafts" NO FORCE ROW LEVEL SECURITY;
UPDATE new_session_drafts
SET session_options = session_options - 'variableSetIds' - 'variableSetId' - 'environmentId'
WHERE session_options ?| ARRAY['variableSetIds', 'variableSetId', 'environmentId'];
ALTER TABLE "new_session_drafts" FORCE ROW LEVEL SECURITY;

DROP FUNCTION pg_temp.canonical_secret_permissions(jsonb);

-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_memberships_legacy_member_0864_idx
ON workspace_memberships (id)
WHERE role = 'member'
  AND subject_id NOT LIKE 'external_user:%'
  AND permissions @> '[
      "workspace:read", "sessions:create", "sessions:read", "sessions:control",
      "stream:view", "stream:acknowledge", "files:upload", "files:read",
      "documents:manage", "documents:search", "scheduled_tasks:manage",
      "scheduled_tasks:run", "github:use", "connections:read", "variable-sets:list",
      "variable-sets:read", "variable-sets:write", "variable-sets:attach",
      "variable-sets:use", "secrets:list", "secrets:write", "goals:manage",
      "rigs:use", "artifacts:read", "artifacts:publish"
    ]'::jsonb
  AND '[
      "workspace:read", "sessions:create", "sessions:read", "sessions:control",
      "stream:view", "stream:acknowledge", "files:upload", "files:read",
      "documents:manage", "documents:search", "scheduled_tasks:manage",
      "scheduled_tasks:run", "github:use", "connections:read", "variable-sets:list",
      "variable-sets:read", "variable-sets:write", "variable-sets:attach",
      "variable-sets:use", "secrets:list", "secrets:write", "goals:manage",
      "rigs:use", "artifacts:read", "artifacts:publish"
    ]'::jsonb @> permissions;

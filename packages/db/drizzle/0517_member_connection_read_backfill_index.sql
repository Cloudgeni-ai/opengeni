-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_memberships_legacy_member_0516_idx
ON workspace_memberships (id)
WHERE role = 'member'
  AND permissions @> '[
    "workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "files:upload", "files:read", "documents:manage", "documents:search",
    "scheduled_tasks:manage", "scheduled_tasks:run", "github:use",
    "variable-sets:list", "variable-sets:read", "variable-sets:write",
    "variable-sets:attach", "variable-sets:use", "secrets:list",
    "secrets:write", "goals:manage"
  ]'::jsonb
  AND '[
    "workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "files:upload", "files:read", "documents:manage", "documents:search",
    "scheduled_tasks:manage", "scheduled_tasks:run", "github:use",
    "variable-sets:list", "variable-sets:read", "variable-sets:write",
    "variable-sets:attach", "variable-sets:use", "secrets:list",
    "secrets:write", "goals:manage"
  ]'::jsonb @> permissions;
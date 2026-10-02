-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=500 lock-timeout=1s statement-timeout=10s
-- The partial index keeps candidate discovery and the empty completion probe
-- bounded. Each 500-row batch commits independently. A contended candidate
-- fails promptly instead of being skipped and incorrectly recorded as done.
WITH candidates AS MATERIALIZED (
  SELECT membership.id
  FROM workspace_memberships membership
  WHERE membership.role = 'member'
    AND membership.permissions @> '[
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
    ]'::jsonb @> membership.permissions
  ORDER BY membership.id
  LIMIT 500
  FOR UPDATE OF membership
), backfilled AS (
  UPDATE workspace_memberships membership
  SET permissions = membership.permissions || '["connections:read"]'::jsonb,
      updated_at = pg_catalog.clock_timestamp()
  FROM candidates
  WHERE membership.id = candidates.id
  RETURNING membership.id
)
SELECT id FROM backfilled;
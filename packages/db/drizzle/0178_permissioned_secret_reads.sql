-- deployment-mode: rolling
-- Existing managed workspace administrators receive explicit new permissions.
-- API keys and frozen session grants are deliberately untouched: an old
-- workspace:admin wildcard must never acquire plaintext secret reads.
UPDATE "workspace_memberships"
SET "permissions" =
  "permissions"
  || CASE WHEN "permissions" ? 'variable-sets:list' THEN '[]'::jsonb ELSE '["variable-sets:list"]'::jsonb END
  || CASE WHEN "permissions" ? 'variable-sets:read' THEN '[]'::jsonb ELSE '["variable-sets:read"]'::jsonb END
  || CASE WHEN "permissions" ? 'variable-sets:write' THEN '[]'::jsonb ELSE '["variable-sets:write"]'::jsonb END
  || CASE WHEN "permissions" ? 'secrets:list' THEN '[]'::jsonb ELSE '["secrets:list"]'::jsonb END
  || CASE WHEN "permissions" ? 'secrets:read' THEN '[]'::jsonb ELSE '["secrets:read"]'::jsonb END
  || CASE WHEN "permissions" ? 'secrets:write' THEN '[]'::jsonb ELSE '["secrets:write"]'::jsonb END
WHERE "permissions" ? 'workspace:admin';

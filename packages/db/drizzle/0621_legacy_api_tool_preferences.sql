-- deployment-mode: maintenance
-- Preserve explicit legacy API exemptions as ordinary account-bound choices.
-- Drain configuration writers. Pending requests and attempt snapshots are untouched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE
  roles jsonb;
BEGIN
  BEGIN
    roles := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'legacy tool preference migration requires a valid application role list' USING ERRCODE = '55000';
  END;
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION 'legacy tool preference migration requires an application role list' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
    OR (SELECT count(*) FROM jsonb_array_elements_text(roles)) <>
       (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(roles))
    OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION 'legacy tool preference migration requires stopped application roles' USING ERRCODE = '55000';
  END IF;
END $drain$;

ALTER TABLE integration_facet_definitions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_api_facets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_spec_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_facet_bindings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_facet_installations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_plugin_installations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE connector_action_policies NO FORCE ROW LEVEL SECURITY;

CREATE TEMP TABLE legacy_api_tool_preferences ON COMMIT DROP AS
SELECT DISTINCT b.account_id, b.workspace_id,
  coalesce(b.connection_id::text, 'session-mcp:' || b.runtime_key || ':' || encode(sha256(convert_to(api.base_url, 'UTF8')), 'hex')) AS connection_id,
  b.runtime_key AS server_id, tool->>'id' AS tool_name, b.created_by_subject_id
FROM integration_facet_bindings b
JOIN integration_facet_definitions d ON d.id = b.facet_definition_id AND d.kind = 'tools'
JOIN capability_facet_installations fi ON fi.id = b.integration_facet_installation_id AND fi.status = 'active' AND fi.workspace_id = b.workspace_id AND fi.account_id = b.account_id
JOIN capability_plugin_installations pi ON pi.id = fi.plugin_installation_id AND pi.status = 'active' AND pi.workspace_id = b.workspace_id AND pi.account_id = b.account_id
JOIN capability_api_facets api ON api.integration_facet_id = d.integration_facet_id
JOIN integration_spec_revisions revision ON revision.api_facet_id = api.facet_id AND revision.status = 'active'
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(revision.spec->'tools') = 'array' THEN revision.spec->'tools' ELSE '[]'::jsonb END) tool
WHERE b.status = 'active' AND b.runtime_key IS NOT NULL
  AND jsonb_typeof(b.config->'requireApproval') = 'array'
  AND jsonb_typeof(b.config->'allowedTools') = 'array'
  AND tool->>'approvalMode' = 'ask'
  AND b.config->'allowedTools' ? (tool->>'id')
  AND NOT (b.config->'requireApproval' ? (tool->>'id'));

-- Any existing applicable choice, including wildcard/conditional Block, wins.
DELETE FROM legacy_api_tool_preferences legacy
WHERE EXISTS (
  SELECT 1 FROM connector_action_policies policy
  WHERE policy.workspace_id = legacy.workspace_id AND policy.connection_id = legacy.connection_id
    AND policy.server_id IN (legacy.server_id, '*') AND policy.tool_name IN (legacy.tool_name, '*')
);

DO $bounded_preferences$
BEGIN
  IF EXISTS (
    SELECT workspace_id FROM (
      SELECT workspace_id FROM connector_action_policies
      UNION ALL SELECT workspace_id FROM legacy_api_tool_preferences
    ) choices GROUP BY workspace_id HAVING count(*) > 2048
  ) THEN RAISE EXCEPTION 'Legacy tool preferences exceed the workspace limit; migration rolled back'; END IF;
END
$bounded_preferences$;

INSERT INTO connector_action_policies
  (account_id, workspace_id, connection_id, server_id, tool_name, action_name, policy, created_by_subject_id, updated_by_subject_id)
SELECT account_id, workspace_id, connection_id, server_id, tool_name, '*', 'allow', created_by_subject_id, created_by_subject_id
FROM legacy_api_tool_preferences
ON CONFLICT (workspace_id, connection_id, server_id, tool_name, action_name) DO NOTHING;

ALTER TABLE integration_facet_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_api_facets FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_spec_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_facet_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_facet_installations FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_plugin_installations FORCE ROW LEVEL SECURITY;
ALTER TABLE connector_action_policies FORCE ROW LEVEL SECURITY;

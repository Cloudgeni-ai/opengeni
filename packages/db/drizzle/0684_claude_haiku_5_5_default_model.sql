-- deployment-mode: rolling
-- Claude Haiku 5.5 is now one of the models every Claude connection offers by
-- default. Earlier releases offered no default models, so people added Claude
-- models by hand and Haiku 5.5 was not even among the suggestions. Add it to
-- each organization or workspace that already uses Claude models of a kind
-- (Anthropic API key or Claude subscription) and never added or removed Haiku
-- 5.5 there: a removed model stays removed. Model rows are additive catalog
-- configuration; workspace model policy still decides who may pick them, and
-- no session, attempt or saved model selection changes.
--
-- Owner-only posture window: both tables are FORCE RLS and the migration
-- principal sets no tenant GUC. A concurrent add of the same model wins
-- through the active-model unique index.
ALTER TABLE organization_model_provider_custom_models NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_gateway_custom_models NO FORCE ROW LEVEL SECURITY;

INSERT INTO organization_model_provider_custom_models
  (account_id, provider_kind, upstream_model_id, label, create_operation_id,
   create_request_hash, created_by_subject_id)
SELECT scope.account_id, scope.provider_kind, 'claude-haiku-5-5', NULL, gen_random_uuid(),
  encode(sha256(convert_to('{"action":"seed_default","upstreamModelId":"claude-haiku-5-5"}', 'UTF8')), 'hex'),
  'service:migration:0684-claude-haiku-5-5-default'
FROM (
  SELECT account_id, provider_kind,
    count(*) FILTER (WHERE retired_at IS NULL) AS active, count(*) AS total
  FROM organization_model_provider_custom_models
  WHERE provider_kind IN ('anthropic', 'claude_subscription')
  GROUP BY account_id, provider_kind
) scope
WHERE scope.active > 0 AND scope.active < 100 AND scope.total < 1000
  AND NOT EXISTS (
    SELECT 1 FROM organization_model_provider_custom_models haiku
    WHERE haiku.account_id = scope.account_id AND haiku.provider_kind = scope.provider_kind
      AND haiku.upstream_model_id = 'claude-haiku-5-5')
ON CONFLICT (account_id, provider_kind, upstream_model_id) WHERE retired_at IS NULL DO NOTHING;

INSERT INTO workspace_gateway_custom_models
  (account_id, workspace_id, provider_kind, upstream_model_id, label, create_operation_id,
   create_request_hash, created_by_subject_id)
SELECT scope.account_id, scope.workspace_id, scope.provider_kind, 'claude-haiku-5-5', NULL,
  gen_random_uuid(),
  encode(sha256(convert_to('{"action":"seed_default","upstreamModelId":"claude-haiku-5-5"}', 'UTF8')), 'hex'),
  'service:migration:0684-claude-haiku-5-5-default'
FROM (
  SELECT account_id, workspace_id, provider_kind,
    count(*) FILTER (WHERE retired_at IS NULL) AS active, count(*) AS total
  FROM workspace_gateway_custom_models
  WHERE provider_kind IN ('anthropic', 'claude_subscription')
  GROUP BY account_id, workspace_id, provider_kind
) scope
WHERE scope.active > 0 AND scope.active < 100 AND scope.total < 1000
  AND NOT EXISTS (
    SELECT 1 FROM workspace_gateway_custom_models haiku
    WHERE haiku.workspace_id = scope.workspace_id AND haiku.provider_kind = scope.provider_kind
      AND haiku.upstream_model_id = 'claude-haiku-5-5')
ON CONFLICT (workspace_id, provider_kind, upstream_model_id) WHERE retired_at IS NULL DO NOTHING;

ALTER TABLE organization_model_provider_custom_models FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_gateway_custom_models FORCE ROW LEVEL SECURITY;

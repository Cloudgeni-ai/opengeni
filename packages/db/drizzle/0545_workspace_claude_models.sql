-- deployment-mode: rolling
-- Reuse workspace-owned model generations, replay fences and existing RLS.
ALTER TABLE workspace_gateway_custom_models
  DROP CONSTRAINT workspace_gateway_custom_models_provider_kind_chk;
ALTER TABLE workspace_gateway_custom_models
  ADD CONSTRAINT workspace_gateway_custom_models_provider_kind_chk
  CHECK (provider_kind IN ('vercel_gateway', 'openrouter', 'anthropic', 'claude_subscription'));

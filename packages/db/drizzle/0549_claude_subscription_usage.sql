-- deployment-mode: rolling
-- Nullable provider observations reuse the existing connection authority and RLS.
-- Old readers/writers safely ignore them. Credential versions fence rotation.
ALTER TABLE connections ADD COLUMN claude_usage_snapshot jsonb;
ALTER TABLE organization_model_provider_connections ADD COLUMN claude_usage_snapshot jsonb;

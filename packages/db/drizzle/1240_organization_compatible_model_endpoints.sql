-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: organization model provider connections hold one row per organization and provider kind, and their custom models a few per organization, so validating these checks and the foreign key here is instant.
-- online-safety-exception: table-rewrite: the new UNIQUE (id, account_id) is on organization_model_provider_connections, one row per organization and provider kind, so building it scans only a few rows.
-- online-safety-exception: nonconcurrent-index: organization_model_provider_connections and organization_model_provider_custom_models hold a few rows per organization, so building these indexes here takes milliseconds.
-- An organization can connect its own OpenAI-compatible endpoints (a public
-- HTTPS base URL, an API key and the models it serves) as organization model
-- accounts, beside its OpenAI, Azure OpenAI and other provider keys. Unlike
-- those, an organization can connect several of them, so each endpoint is its
-- own row of kind 'openai_compatible', and its models carry the row's id.
--
-- Rolling: only additive columns, wider checks and a narrower uniqueness
-- rule. The previous release never writes or reads 'openai_compatible' rows
-- (every reader filters by its own kinds), and its kinds stay one row each.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_model_provider_connections
  ADD COLUMN compatible_api text,
  ADD COLUMN label text;

COMMENT ON COLUMN organization_model_provider_connections.compatible_api IS
  'OpenAI-compatible endpoints only: the API format they follow (chat or responses).';
COMMENT ON COLUMN organization_model_provider_connections.label IS
  'OpenAI-compatible endpoints only: an optional display name.';
COMMENT ON COLUMN organization_model_provider_connections.endpoint IS
  'Non-secret base URL: the Azure OpenAI resource endpoint or an OpenAI-compatible endpoint; null for every other kind.';

ALTER TABLE organization_model_provider_connections
  DROP CONSTRAINT organization_model_provider_connections_provider_kind_chk,
  ADD CONSTRAINT organization_model_provider_connections_provider_kind_chk CHECK (
    provider_kind = ANY (ARRAY['vercel_gateway', 'openrouter', 'anthropic', 'claude_subscription',
      'opper', 'elevenlabs', 'openai', 'azure_openai', 'openai_compatible'])
  ),
  DROP CONSTRAINT organization_model_provider_connections_endpoint_chk,
  ADD CONSTRAINT organization_model_provider_connections_endpoint_chk CHECK (
    (provider_kind IN ('azure_openai', 'openai_compatible')) = (endpoint IS NOT NULL)
    AND (
      endpoint IS NULL
      OR (provider_kind = 'azure_openai'
        AND endpoint ~ '^https://[a-z0-9-]+\.openai\.azure\.com/openai/v1$')
      OR (provider_kind = 'openai_compatible'
        AND octet_length(endpoint) BETWEEN 9 AND 2048 AND endpoint ~ '^https://[!-~]+$')
    )
  ),
  ADD CONSTRAINT organization_model_provider_connections_compatible_api_chk CHECK (
    (provider_kind = 'openai_compatible') = (compatible_api IS NOT NULL)
    AND (compatible_api IS NULL OR compatible_api IN ('chat', 'responses'))
  ),
  ADD CONSTRAINT organization_model_provider_connections_label_chk CHECK (
    label IS NULL
    OR (provider_kind = 'openai_compatible'
      AND octet_length(label) BETWEEN 1 AND 128 AND label !~ '[\r\n|]')
  ),
  -- Every other kind stays one connection per organization (below).
  DROP CONSTRAINT organization_model_provider_connec_account_id_provider_kind_key,
  -- Lets an endpoint's models reference it within the same organization.
  ADD CONSTRAINT organization_model_provider_connections_id_account_key UNIQUE (id, account_id);

CREATE UNIQUE INDEX organization_model_provider_connections_account_provider_uq
  ON organization_model_provider_connections USING btree (account_id, provider_kind)
  WHERE provider_kind <> 'openai_compatible';

ALTER TABLE organization_model_provider_custom_models
  ADD COLUMN connection_id uuid;

COMMENT ON COLUMN organization_model_provider_custom_models.connection_id IS
  'OpenAI-compatible endpoints only: the endpoint connection that serves this model.';

ALTER TABLE organization_model_provider_custom_models
  DROP CONSTRAINT organization_model_provider_custom_models_provider_kind_chk,
  ADD CONSTRAINT organization_model_provider_custom_models_provider_kind_chk CHECK (
    provider_kind = ANY (ARRAY['vercel_gateway', 'openrouter', 'anthropic', 'claude_subscription',
      'opper', 'openai', 'azure_openai', 'openai_compatible'])
  ),
  ADD CONSTRAINT organization_model_provider_custom_models_connection_chk CHECK (
    (provider_kind = 'openai_compatible') = (connection_id IS NOT NULL)
  ),
  ADD CONSTRAINT organization_model_provider_custom_models_connection_fk
    FOREIGN KEY (connection_id, account_id)
    REFERENCES organization_model_provider_connections (id, account_id) ON DELETE CASCADE;

-- Two endpoints may serve a model of the same name; each keeps its own.
DROP INDEX organization_model_provider_custom_models_active_uq;
CREATE UNIQUE INDEX organization_model_provider_custom_models_active_uq
  ON organization_model_provider_custom_models USING btree (
    account_id, provider_kind,
    coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid),
    upstream_model_id
  ) WHERE retired_at IS NULL;
CREATE INDEX organization_model_provider_custom_models_connection_idx
  ON organization_model_provider_custom_models USING btree (connection_id)
  WHERE connection_id IS NOT NULL;

CREATE OR REPLACE FUNCTION opengeni_private.product_lifecycle_fact_valid(p_fact_type text, p_attribute text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT coalesce(CASE p_fact_type
    WHEN 'auth.sign_up' THEN p_attribute IN ('email', 'google', 'github', 'other')
    WHEN 'auth.email_verified' THEN p_attribute IS NULL
    WHEN 'auth.sign_in' THEN p_attribute IN ('email', 'google', 'github', 'other')
    WHEN 'organization.setup' THEN p_attribute IN ('created', 'additional')
    WHEN 'model.connected' THEN p_attribute IN (
      'codex', 'supergrok', 'vercel_gateway', 'openrouter', 'anthropic', 'claude_subscription',
      'opper', 'elevenlabs', 'openai', 'azure_openai', 'openai_compatible'
    )
    WHEN 'credits.purchased' THEN p_attribute IS NULL
    WHEN 'credits.granted' THEN p_attribute IN ('signup_trial', 'coupon', 'manual', 'other')
    WHEN 'connection.created' THEN p_attribute IN (
      'slack', 'github', 'gitlab', 'azure_devops', 'bitbucket', 'google',
      'microsoft', 'linear', 'atlassian', 'notion', 'supabase', 'datadog',
      'posthog', 'openai', 'x', 'other'
    )
    WHEN 'connection.revoked' THEN p_attribute IN (
      'slack', 'github', 'gitlab', 'azure_devops', 'bitbucket', 'google',
      'microsoft', 'linear', 'atlassian', 'notion', 'supabase', 'datadog',
      'posthog', 'openai', 'x', 'other'
    )
    WHEN 'scheduled_task.created' THEN p_attribute IS NULL
    WHEN 'skill.installed' THEN p_attribute IS NULL
    WHEN 'slack.user_linked' THEN p_attribute IS NULL
    WHEN 'machine.enrolled' THEN p_attribute IS NULL
    WHEN 'member.joined' THEN p_attribute IS NULL
    WHEN 'user.active' THEN p_attribute IS NULL
    ELSE false
  END, false)
$$;

-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: both tables hold a handful of provider connection rows per organization, so validating under the same lock finishes instantly
-- Organization-wide voice: an organization ElevenLabs key every workspace in
-- it can use, and default voice settings by realtime model id that a
-- workspace follows until it saves its own.
--
-- Every change only widens an allow-list or adds a defaulted column, so an
-- older binary that never writes `elevenlabs` or `realtime_voice` keeps
-- reading and writing unchanged. Ownership, encryption and RLS are unchanged;
-- no row is read or rewritten. Custom models stay limited to model providers.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_model_defaults
  ADD COLUMN IF NOT EXISTS realtime_voice jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 0636 named both checks `<table>_provider_kind_chk`. NOT VALID + VALIDATE
-- keeps the full-table check out of the ACCESS EXCLUSIVE window.
ALTER TABLE organization_model_provider_connections
  DROP CONSTRAINT organization_model_provider_connections_provider_kind_chk;
ALTER TABLE organization_model_provider_connections
  ADD CONSTRAINT organization_model_provider_connections_provider_kind_chk CHECK (
    provider_kind IN (
      'vercel_gateway', 'openrouter', 'anthropic', 'claude_subscription', 'opper', 'elevenlabs'
    )
  ) NOT VALID;
ALTER TABLE organization_model_provider_connections
  VALIDATE CONSTRAINT organization_model_provider_connections_provider_kind_chk;

ALTER TABLE organization_model_provider_connection_operations
  DROP CONSTRAINT organization_model_provider_connection_operations_provider_kind_chk;
ALTER TABLE organization_model_provider_connection_operations
  ADD CONSTRAINT organization_model_provider_connection_operations_provider_kind_chk CHECK (
    provider_kind IN (
      'vercel_gateway', 'openrouter', 'anthropic', 'claude_subscription', 'opper', 'elevenlabs'
    )
  ) NOT VALID;
ALTER TABLE organization_model_provider_connection_operations
  VALIDATE CONSTRAINT organization_model_provider_connection_operations_provider_kind_chk;

-- The 0636 definition with `elevenlabs` added to `model.connected`. An
-- organization ElevenLabs connection insert fires the lifecycle capture
-- trigger, which raises on an attribute outside this list.
CREATE OR REPLACE FUNCTION opengeni_private.product_lifecycle_fact_valid(
  p_fact_type text,
  p_attribute text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT coalesce(CASE p_fact_type
    WHEN 'auth.sign_up' THEN p_attribute IN ('email', 'google', 'github', 'other')
    WHEN 'auth.email_verified' THEN p_attribute IS NULL
    WHEN 'auth.sign_in' THEN p_attribute IN ('email', 'google', 'github', 'other')
    WHEN 'organization.setup' THEN p_attribute IN ('created', 'additional')
    WHEN 'model.connected' THEN p_attribute IN (
      'codex', 'supergrok', 'vercel_gateway', 'openrouter', 'anthropic', 'claude_subscription',
      'opper', 'elevenlabs'
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
$function$;

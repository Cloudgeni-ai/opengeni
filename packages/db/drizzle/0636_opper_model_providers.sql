-- deployment-mode: rolling
-- Opper as a first-class model provider: admit `opper` beside Vercel AI
-- Gateway, OpenRouter and Claude in the existing workspace custom-model and
-- organization provider tables, the `model.connected` lifecycle fact, and the
-- exported analytics model-provider families. Every change only widens an
-- allow-list, so an older binary that never writes `opper` stays compatible.
-- Ownership, encryption and RLS are unchanged; no row is read or rewritten.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Both the original inline CHECK names and the schema-declared names are
-- handled, exactly like 0544. NOT VALID + VALIDATE keeps the full-table check
-- out of the ACCESS EXCLUSIVE window.
DO $migration$
DECLARE table_name text; constraint_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_gateway_custom_models',
    'organization_model_provider_connections',
    'organization_model_provider_connection_operations',
    'organization_model_provider_custom_models'
  ] LOOP
    FOR constraint_name IN
      SELECT c.conname FROM pg_constraint c
      WHERE c.conrelid = to_regclass(table_name) AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%provider_kind%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', table_name, constraint_name);
    END LOOP;
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (provider_kind IN (''vercel_gateway'', ''openrouter'', ''anthropic'', ''claude_subscription'', ''opper'')) NOT VALID',
      table_name, table_name || '_provider_kind_chk'
    );
    EXECUTE format(
      'ALTER TABLE %I VALIDATE CONSTRAINT %I', table_name, table_name || '_provider_kind_chk'
    );
  END LOOP;
END $migration$;

-- The 0565 definition with `opper` added to `model.connected`. An organization
-- Opper connection insert fires the lifecycle capture trigger, which raises on
-- an attribute outside this list.
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
      'opper'
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

-- Widen the exported analytics family list first, then let the 0533 mapping
-- emit the three Opper families instead of the generic `registry` family.
ALTER TABLE host_export_outbox
  DROP CONSTRAINT host_export_outbox_analytics_check;

ALTER TABLE host_export_outbox
  ADD CONSTRAINT host_export_outbox_analytics_check CHECK (
    (surface IS NULL OR surface IN (
      'web', 'slack', 'api_key', 'embedded', 'scheduled', 'agent',
      'voice', 'site', 'automation', 'mcp', 'system'
    ))
    AND (model_provider IS NULL OR model_provider IN (
      'openai', 'azure', 'codex-subscription', 'supergrok-subscription',
      'opengeni-gateway', 'workspace-gateway', 'organization-gateway',
      'openrouter', 'workspace-openrouter', 'organization-openrouter',
      'opper', 'workspace-opper', 'organization-opper', 'registry'
    ))
    AND (tool_family IS NULL OR tool_family ~
      '^(custom|integration:[a-z0-9]([a-z0-9.-]{0,150}[a-z0-9])?|[a-z][a-z0-9_]{0,63})$')
  ) NOT VALID;

ALTER TABLE host_export_outbox
  VALIDATE CONSTRAINT host_export_outbox_analytics_check;

-- Mirrors analyticsModelProvider in packages/contracts/src/product-analytics.ts.
CREATE OR REPLACE FUNCTION opengeni_private.analytics_model_provider(p_provider_id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN p_provider_id IN (
      'openai', 'azure', 'codex-subscription', 'supergrok-subscription',
      'opengeni-gateway', 'workspace-gateway', 'organization-gateway',
      'openrouter', 'workspace-openrouter', 'organization-openrouter',
      'opper', 'workspace-opper', 'organization-opper'
    ) THEN p_provider_id
    WHEN p_provider_id ~ '^[A-Za-z0-9_-]{1,128}$' THEN 'registry'
    ELSE NULL
  END
$function$;

REVOKE ALL ON FUNCTION opengeni_private.analytics_model_provider(text) FROM PUBLIC;

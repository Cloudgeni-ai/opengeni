-- deployment-mode: rolling
-- Add provider kinds without changing existing ownership, encryption or RLS.
-- Both the original inline CHECK names and the schema-declared names are handled.
DO $migration$
DECLARE table_name text; constraint_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['organization_model_provider_connections', 'organization_model_provider_connection_operations', 'organization_model_provider_custom_models'] LOOP
    FOR constraint_name IN
      SELECT c.conname FROM pg_constraint c
      WHERE c.conrelid = to_regclass(table_name) AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%provider_kind%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', table_name, constraint_name);
    END LOOP;
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (provider_kind IN (''vercel_gateway'', ''openrouter'', ''anthropic'', ''claude_subscription''))', table_name, table_name || '_provider_kind_chk');
  END LOOP;
END $migration$;

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
      'codex', 'supergrok', 'vercel_gateway', 'openrouter', 'anthropic', 'claude_subscription'
    )
    WHEN 'credits.purchased' THEN p_attribute IS NULL
    WHEN 'connection.created' THEN p_attribute IN (
      'slack', 'github', 'gitlab', 'azure_devops', 'bitbucket', 'google',
      'microsoft', 'linear', 'atlassian', 'notion', 'supabase', 'datadog',
      'posthog', 'openai', 'x', 'other'
    )
    WHEN 'scheduled_task.created' THEN p_attribute IS NULL
    WHEN 'skill.installed' THEN p_attribute IS NULL
    WHEN 'slack.user_linked' THEN p_attribute IS NULL
    WHEN 'machine.enrolled' THEN p_attribute IS NULL
    WHEN 'member.joined' THEN p_attribute IS NULL
    ELSE false
  END, false)
$function$;

-- deployment-mode: rolling
-- Normalize provider inference-source modes while retaining the M2 JSON shape
-- for legacy settings that have no explicit inferenceSource value.
CREATE OR REPLACE FUNCTION subscription_effective_settings(p_account_id uuid, p_workspace_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path FROM CURRENT
AS $function$
  WITH org AS (
    SELECT * FROM subscription_settings WHERE account_id = p_account_id AND workspace_id IS NULL
  ), ws AS (
    SELECT * FROM subscription_settings WHERE account_id = p_account_id AND workspace_id = p_workspace_id
  ), keys AS (
  SELECT entry.key FROM org, LATERAL jsonb_object_keys(org.rotation) AS entry(key)
    UNION SELECT entry.key FROM ws CROSS JOIN org,
      LATERAL jsonb_object_keys(ws.rotation) AS entry(key)
      WHERE NOT ('rotation' = ANY(coalesce(org.locked_settings, '{}')))
  ), rotation_entries AS (
    SELECT keys.key,
      CASE WHEN ws.rotation ? keys.key AND NOT ('rotation' = ANY(coalesce(org.locked_settings, '{}')))
        THEN ws.rotation->keys.key ELSE org.rotation->keys.key END AS setting,
      CASE WHEN ws.rotation ? keys.key AND NOT ('rotation' = ANY(coalesce(org.locked_settings, '{}')))
        THEN CASE keys.key WHEN 'codex' THEN ws.codex_primary_connection_id
          WHEN 'claude' THEN ws.claude_primary_connection_id
          WHEN 'xai' THEN ws.xai_primary_connection_id END
        ELSE CASE keys.key WHEN 'codex' THEN org.codex_primary_connection_id
          WHEN 'claude' THEN org.claude_primary_connection_id
          WHEN 'xai' THEN org.xai_primary_connection_id END END AS primary_connection_id,
      CASE WHEN ws.rotation ? keys.key AND NOT ('rotation' = ANY(coalesce(org.locked_settings, '{}')))
        THEN 'workspace' ELSE 'organization' END AS source
    FROM keys CROSS JOIN org LEFT JOIN ws ON true
  ), rot AS (
    SELECT coalesce(jsonb_object_agg(key,
      CASE WHEN setting->>'mode' = 'primary_first'
        THEN setting || jsonb_build_object('primaryConnectionId', primary_connection_id::text)
        ELSE setting END), '{}'::jsonb) AS value,
      coalesce(jsonb_object_agg(key, source), '{}'::jsonb) AS sources
    FROM rotation_entries
  ), provider_keys AS (
    SELECT entry.key FROM org, LATERAL jsonb_object_keys(org.providers) AS entry(key)
    UNION SELECT entry.key FROM ws CROSS JOIN org,
      LATERAL jsonb_object_keys(ws.providers) AS entry(key)
      WHERE NOT ('providers' = ANY(coalesce(org.locked_settings, '{}')))
  ), provider_entries AS (
    SELECT provider_keys.key,
      coalesce(org.providers->provider_keys.key, '{}'::jsonb) AS organization_setting,
      CASE WHEN ws.providers ? provider_keys.key
        AND NOT ('providers' = ANY(coalesce(org.locked_settings, '{}')))
        THEN ws.providers->provider_keys.key ELSE '{}'::jsonb END AS workspace_setting,
      (ws.providers ? provider_keys.key
        AND NOT ('providers' = ANY(coalesce(org.locked_settings, '{}')))) AS has_workspace_override
    FROM provider_keys CROSS JOIN org LEFT JOIN ws ON true
  ), provider_resolved AS (
    SELECT key,
      CASE
        WHEN workspace_setting ? 'inferenceSource' THEN workspace_setting->>'inferenceSource'
        WHEN workspace_setting ? 'useOrganizationAccounts'
          THEN CASE WHEN workspace_setting->>'useOrganizationAccounts' = 'false'
            THEN 'workspace' ELSE 'automatic' END
        WHEN organization_setting ? 'inferenceSource' THEN organization_setting->>'inferenceSource'
        WHEN organization_setting ? 'useOrganizationAccounts'
          THEN CASE WHEN organization_setting->>'useOrganizationAccounts' = 'false'
            THEN 'workspace' ELSE 'automatic' END
        ELSE 'automatic'
      END AS inference_source,
      (organization_setting ? 'inferenceSource' OR workspace_setting ? 'inferenceSource') AS has_explicit_source,
      has_workspace_override,
      '{"useOrganizationAccounts":true,"enabled":true}'::jsonb
        || organization_setting || workspace_setting AS merged_setting
    FROM provider_entries
  ), prov AS (
    SELECT coalesce(jsonb_object_agg(key,
      (merged_setting - 'useOrganizationAccounts' - 'inferenceSource')
        || jsonb_build_object('useOrganizationAccounts', inference_source <> 'workspace')
        || CASE WHEN has_explicit_source
          THEN jsonb_build_object('inferenceSource', inference_source) ELSE '{}'::jsonb END), '{}'::jsonb) value,
      coalesce(jsonb_object_agg(key,
        CASE WHEN has_workspace_override THEN 'workspace' ELSE 'organization' END), '{}'::jsonb) sources
    FROM provider_resolved
  ), fallback_keys AS (
    SELECT entry.key FROM org, LATERAL jsonb_object_keys(org.fallback_order) AS entry(key)
    UNION SELECT entry.key FROM ws CROSS JOIN org,
      LATERAL jsonb_object_keys(ws.fallback_order) AS entry(key)
      WHERE NOT ('fallbackOrder' = ANY(coalesce(org.locked_settings, '{}')))
  ), fallback AS (
    SELECT coalesce(jsonb_object_agg(fallback_keys.key,
      CASE WHEN ws.fallback_order ? fallback_keys.key
        AND NOT ('fallbackOrder' = ANY(coalesce(org.locked_settings, '{}')))
        THEN ws.fallback_order->fallback_keys.key ELSE org.fallback_order->fallback_keys.key END), '{}'::jsonb) value,
      coalesce(jsonb_object_agg(fallback_keys.key,
      CASE WHEN ws.fallback_order ? fallback_keys.key
        AND NOT ('fallbackOrder' = ANY(coalesce(org.locked_settings, '{}')))
        THEN 'workspace' ELSE 'organization' END), '{}'::jsonb) sources
    FROM fallback_keys CROSS JOIN org LEFT JOIN ws ON true
  )
  SELECT jsonb_build_object(
    'values', jsonb_build_object(
    'rotation', rot.value, 'providers', prov.value,
    'crossProviderFailover', CASE WHEN ws.cross_provider_failover IS NOT NULL
      AND NOT ('crossProviderFailover' = ANY(coalesce(org.locked_settings, '{}')))
      THEN ws.cross_provider_failover ELSE coalesce(org.cross_provider_failover, false) END,
    'fallbackOrder', fallback.value,
    'personalConnectionsAllowed', CASE WHEN ws.personal_connections_allowed IS NOT NULL
      AND NOT ('personalConnectionsAllowed' = ANY(coalesce(org.locked_settings, '{}')))
      THEN ws.personal_connections_allowed ELSE coalesce(org.personal_connections_allowed, true) END,
    'personalFallbackAllowed', CASE WHEN ws.personal_fallback_allowed IS NOT NULL
      AND NOT ('personalFallbackAllowed' = ANY(coalesce(org.locked_settings, '{}')))
      THEN ws.personal_fallback_allowed ELSE coalesce(org.personal_fallback_allowed, false) END
    ),
    'sources', jsonb_build_object(
      'rotation', rot.sources, 'providers', prov.sources,
      'crossProviderFailover', CASE WHEN ws.cross_provider_failover IS NOT NULL AND NOT ('crossProviderFailover' = ANY(coalesce(org.locked_settings, '{}'))) THEN 'workspace' ELSE 'organization' END,
      'fallbackOrder', fallback.sources,
      'personalConnectionsAllowed', CASE WHEN ws.personal_connections_allowed IS NOT NULL AND NOT ('personalConnectionsAllowed' = ANY(coalesce(org.locked_settings, '{}'))) THEN 'workspace' ELSE 'organization' END,
      'personalFallbackAllowed', CASE WHEN ws.personal_fallback_allowed IS NOT NULL AND NOT ('personalFallbackAllowed' = ANY(coalesce(org.locked_settings, '{}'))) THEN 'workspace' ELSE 'organization' END)
  ) FROM org CROSS JOIN rot CROSS JOIN prov CROSS JOIN fallback LEFT JOIN ws ON true
$function$;

-- Keep unqualified settings reads in the trusted data schema. In particular,
-- pg_temp must be explicit and last so a caller-created temporary table cannot
-- shadow subscription_settings when this resolver is called by a guard.
DO $subscription_inference_source_search_path$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.subscription_effective_settings(uuid,uuid) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema,
    data_schema
  );
END
$subscription_inference_source_search_path$;

-- deployment-mode: rolling
-- Dormant B1 readiness seam. No table grants or cutover activation: an app
-- role learns only the registered kind and committed-receipt boolean.
CREATE FUNCTION opengeni_private.subscription_core_failover_readiness(p_provider text)
RETURNS TABLE(connection_kind text, committed boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
  SELECT registry.connection_kind,
    EXISTS (SELECT 1 FROM opengeni_private.subscription_provider_cutover_receipts receipt
      WHERE receipt.provider = registry.provider)
  FROM opengeni_private.subscription_core_providers registry
  WHERE registry.provider = p_provider
$body$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_core_failover_readiness(text) FROM PUBLIC;
DO $grant_runtime$
DECLARE application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.subscription_core_failover_readiness(text) TO %I', application_role);
  END LOOP;
END
$grant_runtime$;

-- D-38: cross-provider unknown outcomes survive recovery/reclaim and source
-- registry removal. The old closed-attempt exemption remains SAME-provider
-- only. Match model requests, never media/credential operations. Anchored
-- replacement fails rather than guessing if another migration changed it.
DO $failover_request_fence$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.guard_subscription_disconnect_admission()'::regprocedure);
  FOR anchor, replacement IN VALUES
    ($old$AND prior.provider = NEW.provider AND prior.operation_kind = 'model'$old$,
     $new$AND prior.operation_kind = 'model'$new$),
    ($old$AND attempt.state = 'closed'
              AND attempt.outcome IN ('failed', 'interrupted_recoverable', 'lease_lost_recoverable')$old$,
     $new$AND prior.provider = NEW.provider AND attempt.state = 'closed'
              AND attempt.outcome IN ('failed', 'interrupted_recoverable', 'lease_lost_recoverable')$new$)
  LOOP
    IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
      RAISE EXCEPTION 'subscription failover request admission source changed';
    END IF;
    definition := replace(definition, anchor, replacement);
  END LOOP;
  EXECUTE definition;
END
$failover_request_fence$;

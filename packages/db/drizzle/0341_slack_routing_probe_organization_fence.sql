-- deployment-mode: rolling
-- Fence both Slack routing tenancy probes on the organization the caller is
-- acting for.
--
-- Neither probe carried an account predicate. Both are SECURITY DEFINER and
-- both return tenancy ids, so a caller holding another organization's
-- connection UUID plus a route key or a handle id learned that organization's
-- account, workspace and interaction ids. Exploitability is low today, because
-- connection ids are never caller-supplied and the Slack signature check
-- already fences the team, but the predicate is one line and every sibling
-- authority routine carries it.
--
-- Rolling by expand-and-contract: the fenced three-argument routines are added
-- alongside the existing two-argument ones rather than replacing them, so an
-- old image keeps resolving thread continuation and button clicks through the
-- signature it knows. A later migration drops the unfenced pair once the fleet
-- is on an image that calls the fenced one; dropping them here would break
-- every running old worker the moment this commits.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $slack_fenced_interaction_probe$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.resolve_slack_interaction_tenancy(
      p_account_id uuid,
      p_connection_id uuid,
      p_route_key text
    )
    RETURNS TABLE (account_id uuid, workspace_id uuid, interaction_id uuid)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    BEGIN
      IF p_account_id IS NULL OR p_connection_id IS NULL OR p_route_key IS NULL THEN
        RETURN;
      END IF;
      INSERT INTO opengeni_private.slack_routing_runtime_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'interaction_tenancy'
      ) ON CONFLICT DO NOTHING;
      BEGIN
        RETURN QUERY
          SELECT I.account_id, I.workspace_id, I.id
          FROM slack_interactions I
          WHERE I.account_id = p_account_id
            AND I.connection_id = p_connection_id
            AND I.route_key = p_route_key
          LIMIT 1;
        DELETE FROM opengeni_private.slack_routing_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'interaction_tenancy';
        RETURN;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.slack_routing_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'interaction_tenancy';
        RAISE;
      END;
    END;
    $body$
  $ddl$, data_schema);
END
$slack_fenced_interaction_probe$;

REVOKE ALL ON FUNCTION opengeni_private.resolve_slack_interaction_tenancy(uuid, uuid, text)
  FROM PUBLIC;

CREATE FUNCTION opengeni_private.resolve_slack_action_handle_tenancy(
  p_account_id uuid,
  p_connection_id uuid,
  p_handle_id uuid
)
RETURNS TABLE (account_id uuid, workspace_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = opengeni_private, pg_catalog
AS $$
  SELECT T.account_id, T.workspace_id
  FROM slack_action_handle_tenancy T
  WHERE T.account_id = p_account_id
    AND T.handle_id = p_handle_id
    AND T.connection_id = p_connection_id
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION
  opengeni_private.resolve_slack_action_handle_tenancy(uuid, uuid, uuid) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.resolve_slack_interaction_tenancy(uuid, uuid, text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.resolve_slack_action_handle_tenancy(uuid, uuid, uuid) TO opengeni_app;
  END IF;
END
$grants$;

RESET statement_timeout;
RESET lock_timeout;

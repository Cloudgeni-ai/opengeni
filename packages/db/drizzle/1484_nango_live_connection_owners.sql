-- deployment-mode: rolling
-- Which people have live Nango connection rows, deployment-wide
-- (docs/nango.md, "Sweep").
--
-- The sweep finds people through the connections Nango lists. When a
-- connection was deleted outside reference counting (an older release, an
-- operator) and it was that person's only one for the integration, Nango
-- lists nothing for them, so their rows would keep pointing at a connection
-- that no longer exists. opengeni_private.nango_live_connection_owners_v1
-- pages through the active Nango-backed rows (owner subject, Nango
-- integration and Nango connection id, each triple once) after a keyset
-- cursor, so the sweep can visit those people too. Nothing else is read.
-- Unlike 1482's yes/no answer for ids the caller names, this lists every
-- owner subject and Nango connection id in the deployment to whoever may
-- execute it; only the runtime role will, once granted.
--
-- As 1482 explains, the previous release rejects a runtime EXECUTE grant on
-- a definer it doesn't know, so this migration grants nothing; until a later
-- migration grants it, the sweep only visits people Nango lists.
--
-- It opens and closes the same one-transaction owner inventory window as
-- 1482 for the length of the query, and only closes a window it opened.
--
-- Rolling: one read-only definer the previous release never calls.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $nango_live_connection_owners$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.nango_live_connection_owners_v1(
      p_after_subject_id text,
      p_after_provider_config_key text,
      p_after_nango_connection_id text,
      p_limit integer
    )
    RETURNS TABLE(subject_id text, provider_config_key text, nango_connection_id text)
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE opened integer;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION 'page size must be between 1 and 1000' USING ERRCODE = '22023';
      END IF;
      INSERT INTO opengeni_private.organization_tenancy_inventory_capabilities (
        backend_pid, transaction_id
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS opened = ROW_COUNT;
      RETURN QUERY
        SELECT DISTINCT
          connection.subject_id,
          connection.metadata ->> 'nangoProviderConfigKey',
          connection.metadata ->> 'nangoConnectionId'
        FROM connections connection
        WHERE connection.metadata ->> 'integrationBackend' = 'nango'
          AND connection.status = 'active'
          AND connection.subject_id IS NOT NULL
          AND connection.metadata ->> 'nangoProviderConfigKey' IS NOT NULL
          AND connection.metadata ->> 'nangoConnectionId' IS NOT NULL
          AND (
            p_after_subject_id IS NULL
            OR (
              connection.subject_id,
              connection.metadata ->> 'nangoProviderConfigKey',
              connection.metadata ->> 'nangoConnectionId'
            ) > (p_after_subject_id, p_after_provider_config_key, p_after_nango_connection_id)
          )
        ORDER BY 1, 2, 3
        LIMIT p_limit;
      IF opened > 0 THEN
        DELETE FROM opengeni_private.organization_tenancy_inventory_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
      END IF;
    END
    $body$
  $definition$, data_schema);
END
$nango_live_connection_owners$;

REVOKE ALL ON FUNCTION opengeni_private.nango_live_connection_owners_v1(text, text, text, integer) FROM PUBLIC;

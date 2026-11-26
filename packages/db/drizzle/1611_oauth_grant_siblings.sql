-- deployment-mode: rolling
-- Deployment-wide checks for connections that share one provider OAuth grant
-- (docs/remote-mcp-credentials.md, "Shared provider grants").
--
-- Some providers revoke a whole grant (one account and one OAuth client) when
-- any one of its refresh tokens is revoked: Google ends Gmail, Drive and
-- Calendar together when they use the same client. Those connections can sit
-- in any workspace or organization, and most of them are invisible to the
-- person disconnecting one. Deciding from the person's own reads cut off
-- connections elsewhere (16 Nov 2026), so both decisions read the whole
-- deployment here instead.
--
-- Both definers take the connection being disconnected or found broken and
-- the provider family the caller derived from its stored token endpoint
-- (token endpoint origins, provider domain suffixes, the providerFamily
-- metadata value and the metadata keys that hold the provider's stable
-- account id and email). They read that connection's account identity from
-- its own row, never from the caller.
--
-- - oauth_grant_shared_with_live_connection_v1 answers one yes/no: does any
--   other live (not revoked) OAuth connection, anywhere, possibly hold the
--   same grant? Same family, the same client or an unknown one, and not
--   provably another account. Unknown identity counts as the same account.
-- - oauth_grant_reauth_siblings_v1 lists (at most 100) other active
--   connections that may hold the grant of a connection whose refresh was
--   just refused (that connection must already be needs_reauth, and a client
--   its row records must be the one named): same family, the same known
--   client and the same stable account id (or email when either lacks one).
--   The caller refreshes each with its own token before marking it, since
--   one token's refusal doesn't prove the grant ended. It returns only ids,
--   the owner subject, the version for the caller's compare-and-set, and the
--   provider domain: no metadata, credentials or names.
--
-- connections forces row-level security on its owner too, and the definers
-- run as that owner with no workspace context. Each opens the existing
-- one-transaction owner inventory window (as 1482 and 1552 do) for the
-- length of its query, and only closes a window it opened itself.
--
-- As 1482 and 1552 explain, the previous release rejects a runtime EXECUTE
-- grant on a definer it doesn't know, so this migration grants nothing.
-- Until a later migration grants them, a disconnect never revokes at the
-- provider (it only destroys the stored tokens), and a refused refresh checks
-- only its own connection.
--
-- Rolling: two read-only definers the previous release never calls.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

DO $oauth_grant_siblings$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.oauth_grant_shared_with_live_connection_v1(
      p_connection uuid,
      p_client_id text,
      p_token_endpoint_origins text[],
      p_provider_domain_suffixes text[],
      p_provider_family text,
      p_subject_keys text[],
      p_email_keys text[]
    )
    RETURNS boolean
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      opened integer := 0;
      source record;
      source_subjects text[];
      source_emails text[];
      shared boolean;
    BEGIN
      IF p_connection IS NULL OR p_token_endpoint_origins IS NULL
        OR pg_catalog.cardinality(p_token_endpoint_origins) = 0
        OR p_provider_domain_suffixes IS NULL OR p_subject_keys IS NULL OR p_email_keys IS NULL
      THEN
        RAISE EXCEPTION 'OAuth grant family is incomplete' USING ERRCODE = '22023';
      END IF;
      IF NOT opengeni_private.organization_tenancy_inventory_capability_active() THEN
        INSERT INTO opengeni_private.organization_tenancy_inventory_capabilities (
          backend_pid, transaction_id
        ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS opened = ROW_COUNT;
      END IF;

      SELECT c.metadata INTO source FROM connections c WHERE c.id = p_connection;
      IF NOT FOUND THEN
        -- Nothing to compare with: keep the grant.
        shared := true;
      ELSE
        SELECT coalesce(pg_catalog.array_agg(DISTINCT v) FILTER (WHERE v IS NOT NULL), '{}')
          INTO source_subjects
          FROM (
            SELECT CASE WHEN pg_catalog.jsonb_typeof(source.metadata -> k) = 'string'
              THEN nullif(pg_catalog.btrim(source.metadata ->> k), '') END AS v
            FROM pg_catalog.unnest(p_subject_keys) k
            UNION ALL
            SELECT CASE WHEN source.metadata ->> 'providerFamily' = p_provider_family
              AND pg_catalog.jsonb_typeof(source.metadata -> 'providerPrincipalId') = 'string'
              THEN nullif(pg_catalog.btrim(source.metadata ->> 'providerPrincipalId'), '') END
          ) subject_values;
        SELECT coalesce(pg_catalog.array_agg(DISTINCT v) FILTER (WHERE v IS NOT NULL), '{}')
          INTO source_emails
          FROM (
            SELECT CASE WHEN pg_catalog.jsonb_typeof(source.metadata -> k) = 'string'
              THEN nullif(pg_catalog.lower(pg_catalog.btrim(source.metadata ->> k)), '') END AS v
            FROM pg_catalog.unnest(p_email_keys) k
          ) email_values;

        SELECT EXISTS (
          SELECT 1
          FROM connections c
          CROSS JOIN LATERAL (
            SELECT coalesce(pg_catalog.array_agg(DISTINCT v) FILTER (WHERE v IS NOT NULL), '{}') AS subjects
            FROM (
              SELECT CASE WHEN pg_catalog.jsonb_typeof(c.metadata -> k) = 'string'
                THEN nullif(pg_catalog.btrim(c.metadata ->> k), '') END AS v
              FROM pg_catalog.unnest(p_subject_keys) k
              UNION ALL
              SELECT CASE WHEN c.metadata ->> 'providerFamily' = p_provider_family
                AND pg_catalog.jsonb_typeof(c.metadata -> 'providerPrincipalId') = 'string'
                THEN nullif(pg_catalog.btrim(c.metadata ->> 'providerPrincipalId'), '') END
            ) candidate_subjects
          ) cs
          CROSS JOIN LATERAL (
            SELECT coalesce(pg_catalog.array_agg(DISTINCT v) FILTER (WHERE v IS NOT NULL), '{}') AS emails
            FROM (
              SELECT CASE WHEN pg_catalog.jsonb_typeof(c.metadata -> k) = 'string'
                THEN nullif(pg_catalog.lower(pg_catalog.btrim(c.metadata ->> k)), '') END AS v
              FROM pg_catalog.unnest(p_email_keys) k
            ) candidate_emails
          ) ce
          WHERE c.id <> p_connection
            AND c.kind = 'oauth2'
            AND c.status <> 'revoked'
            -- The same provider: a saved token endpoint decides; without one,
            -- the provider domain or provider family.
            AND CASE
              WHEN pg_catalog.jsonb_typeof(c.metadata -> 'tokenEndpoint') = 'string'
                THEN pg_catalog.lower(pg_catalog.substring(c.metadata ->> 'tokenEndpoint',
                  '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+')) = ANY (p_token_endpoint_origins)
              ELSE c.metadata ->> 'providerFamily' = p_provider_family
                OR EXISTS (
                  SELECT 1 FROM pg_catalog.unnest(p_provider_domain_suffixes) suffix
                  WHERE pg_catalog.lower(c.provider_domain) = suffix
                    OR pg_catalog.right(pg_catalog.lower(c.provider_domain),
                      pg_catalog.length(suffix) + 1) = '.' || suffix
                )
            END
            -- The same client, or one we can't tell.
            AND (
              p_client_id IS NULL
              OR pg_catalog.jsonb_typeof(c.metadata -> 'clientId') IS DISTINCT FROM 'string'
              OR c.metadata ->> 'clientId' = p_client_id
            )
            -- Not provably another account: the stable account id decides
            -- when both have one, else the email when both have one.
            AND NOT CASE
              WHEN pg_catalog.cardinality(source_subjects) > 0
                AND pg_catalog.cardinality(cs.subjects) > 0
                THEN NOT (source_subjects && cs.subjects)
              WHEN pg_catalog.cardinality(source_emails) > 0
                AND pg_catalog.cardinality(ce.emails) > 0
                THEN NOT (source_emails && ce.emails)
              ELSE false
            END
        ) INTO shared;
      END IF;

      IF opened > 0 THEN
        DELETE FROM opengeni_private.organization_tenancy_inventory_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
      END IF;
      RETURN shared;
    END
    $body$
  $definition$, data_schema);

  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.oauth_grant_reauth_siblings_v1(
      p_connection uuid,
      p_client_id text,
      p_token_endpoint_origins text[],
      p_provider_domain_suffixes text[],
      p_provider_family text,
      p_subject_keys text[],
      p_email_keys text[]
    )
    RETURNS TABLE(
      workspace_id uuid,
      connection_id uuid,
      subject_id text,
      version integer,
      provider_domain text
    )
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      opened integer := 0;
      source record;
      source_subjects text[];
      source_emails text[];
    BEGIN
      IF p_connection IS NULL OR p_client_id IS NULL OR p_client_id = ''
        OR p_token_endpoint_origins IS NULL
        OR pg_catalog.cardinality(p_token_endpoint_origins) = 0
        OR p_provider_domain_suffixes IS NULL OR p_subject_keys IS NULL OR p_email_keys IS NULL
      THEN
        RAISE EXCEPTION 'OAuth grant family is incomplete' USING ERRCODE = '22023';
      END IF;
      IF NOT opengeni_private.organization_tenancy_inventory_capability_active() THEN
        INSERT INTO opengeni_private.organization_tenancy_inventory_capabilities (
          backend_pid, transaction_id
        ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS opened = ROW_COUNT;
      END IF;

      -- Only a connection whose own refresh was just refused names siblings.
      -- A client the row itself records must be the one named.
      SELECT c.metadata INTO source
        FROM connections c
        WHERE c.id = p_connection AND c.kind = 'oauth2' AND c.status = 'needs_reauth'
          AND (pg_catalog.jsonb_typeof(c.metadata -> 'clientId') IS DISTINCT FROM 'string'
            OR c.metadata ->> 'clientId' = p_client_id);
      IF FOUND THEN
        SELECT coalesce(pg_catalog.array_agg(DISTINCT v) FILTER (WHERE v IS NOT NULL), '{}')
          INTO source_subjects
          FROM (
            SELECT CASE WHEN pg_catalog.jsonb_typeof(source.metadata -> k) = 'string'
              THEN nullif(pg_catalog.btrim(source.metadata ->> k), '') END AS v
            FROM pg_catalog.unnest(p_subject_keys) k
            UNION ALL
            SELECT CASE WHEN source.metadata ->> 'providerFamily' = p_provider_family
              AND pg_catalog.jsonb_typeof(source.metadata -> 'providerPrincipalId') = 'string'
              THEN nullif(pg_catalog.btrim(source.metadata ->> 'providerPrincipalId'), '') END
          ) subject_values;
        SELECT coalesce(pg_catalog.array_agg(DISTINCT v) FILTER (WHERE v IS NOT NULL), '{}')
          INTO source_emails
          FROM (
            SELECT CASE WHEN pg_catalog.jsonb_typeof(source.metadata -> k) = 'string'
              THEN nullif(pg_catalog.lower(pg_catalog.btrim(source.metadata ->> k)), '') END AS v
            FROM pg_catalog.unnest(p_email_keys) k
          ) email_values;
        IF pg_catalog.cardinality(source_subjects) > 0 OR pg_catalog.cardinality(source_emails) > 0
        THEN
          RETURN QUERY
            SELECT c.workspace_id, c.id, c.subject_id, c.version, c.provider_domain
            FROM connections c
            CROSS JOIN LATERAL (
              SELECT coalesce(pg_catalog.array_agg(DISTINCT v) FILTER (WHERE v IS NOT NULL), '{}') AS subjects
              FROM (
                SELECT CASE WHEN pg_catalog.jsonb_typeof(c.metadata -> k) = 'string'
                  THEN nullif(pg_catalog.btrim(c.metadata ->> k), '') END AS v
                FROM pg_catalog.unnest(p_subject_keys) k
                UNION ALL
                SELECT CASE WHEN c.metadata ->> 'providerFamily' = p_provider_family
                  AND pg_catalog.jsonb_typeof(c.metadata -> 'providerPrincipalId') = 'string'
                  THEN nullif(pg_catalog.btrim(c.metadata ->> 'providerPrincipalId'), '') END
              ) candidate_subjects
            ) cs
            CROSS JOIN LATERAL (
              SELECT coalesce(pg_catalog.array_agg(DISTINCT v) FILTER (WHERE v IS NOT NULL), '{}') AS emails
              FROM (
                SELECT CASE WHEN pg_catalog.jsonb_typeof(c.metadata -> k) = 'string'
                  THEN nullif(pg_catalog.lower(pg_catalog.btrim(c.metadata ->> k)), '') END AS v
                FROM pg_catalog.unnest(p_email_keys) k
              ) candidate_emails
            ) ce
            WHERE c.id <> p_connection
              AND c.kind = 'oauth2'
              AND c.status = 'active'
              -- The same provider, by its saved token endpoint.
              AND pg_catalog.jsonb_typeof(c.metadata -> 'tokenEndpoint') = 'string'
              AND pg_catalog.lower(pg_catalog.substring(c.metadata ->> 'tokenEndpoint',
                '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+')) = ANY (p_token_endpoint_origins)
              -- The same, known client.
              AND pg_catalog.jsonb_typeof(c.metadata -> 'clientId') = 'string'
              AND c.metadata ->> 'clientId' = p_client_id
              -- Provably the same account.
              AND CASE
                WHEN pg_catalog.cardinality(source_subjects) > 0
                  AND pg_catalog.cardinality(cs.subjects) > 0
                  THEN source_subjects && cs.subjects
                WHEN pg_catalog.cardinality(source_emails) > 0
                  AND pg_catalog.cardinality(ce.emails) > 0
                  THEN source_emails && ce.emails
                ELSE false
              END
            ORDER BY c.id
            LIMIT 100;
        END IF;
      END IF;

      IF opened > 0 THEN
        DELETE FROM opengeni_private.organization_tenancy_inventory_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
      END IF;
    END
    $body$
  $definition$, data_schema);
END
$oauth_grant_siblings$;

REVOKE ALL ON FUNCTION opengeni_private.oauth_grant_shared_with_live_connection_v1(uuid, text, text[], text[], text, text[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.oauth_grant_reauth_siblings_v1(uuid, text, text[], text[], text, text[], text[]) FROM PUBLIC;

-- deployment-mode: rolling
-- Activates migration 1611's shared OAuth grant checks. Deploy only after the
-- previous API and worker know both signatures (production's pinned previous
-- release contains 1611).
--
-- Both definers are replaced in place with the same signatures and bodies,
-- plus one guard: the family arguments must be exactly the Google family
-- pinned here (token endpoint origins, provider domain suffix, providerFamily
-- and the account id and email metadata keys), so an EXECUTE holder can't
-- match connections by keys it chooses. Every release that calls them passes
-- exactly that family. A provider added later is pinned here by a new
-- migration first. Then the runtime roles get EXECUTE on both, and nothing
-- else.
--
-- Rows with no stored account identity stay conservative: the shared check
-- counts them as the same account (with the same or an unknown client), so a
-- disconnect keeps the grant; sibling marking never matches them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

DO $oauth_grant_siblings_pinned$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.oauth_grant_shared_with_live_connection_v1(
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
      -- Only a family pinned here is matched, never caller-chosen keys.
      IF NOT coalesce(
        (p_provider_family = 'google'
          AND p_token_endpoint_origins = ARRAY[
            'https://oauth2.googleapis.com',
            'https://accounts.google.com',
            'https://www.googleapis.com'
          ]::text[]
          AND p_provider_domain_suffixes = ARRAY['googleapis.com']::text[]
          AND p_subject_keys = ARRAY['googleSubject']::text[]
          AND p_email_keys = ARRAY[
            'gmailEmail',
            'googleDriveEmail',
            'googleCalendarEmail',
            'providerEmail'
          ]::text[]),
        false)
      THEN
        RAISE EXCEPTION 'OAuth grant family is not pinned' USING ERRCODE = '22023';
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
    CREATE OR REPLACE FUNCTION opengeni_private.oauth_grant_reauth_siblings_v1(
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
      -- Only a family pinned here is matched, never caller-chosen keys.
      IF NOT coalesce(
        (p_provider_family = 'google'
          AND p_token_endpoint_origins = ARRAY[
            'https://oauth2.googleapis.com',
            'https://accounts.google.com',
            'https://www.googleapis.com'
          ]::text[]
          AND p_provider_domain_suffixes = ARRAY['googleapis.com']::text[]
          AND p_subject_keys = ARRAY['googleSubject']::text[]
          AND p_email_keys = ARRAY[
            'gmailEmail',
            'googleDriveEmail',
            'googleCalendarEmail',
            'providerEmail'
          ]::text[]),
        false)
      THEN
        RAISE EXCEPTION 'OAuth grant family is not pinned' USING ERRCODE = '22023';
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
$oauth_grant_siblings_pinned$;

DO $oauth_grant_siblings_runtime_grant$
DECLARE
  application_role text;
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
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.oauth_grant_shared_with_live_connection_v1(uuid,text,text[],text[],text,text[],text[]), opengeni_private.oauth_grant_reauth_siblings_v1(uuid,text,text[],text[],text,text[],text[]) TO %I',
      application_role
    );
  END LOOP;
END $oauth_grant_siblings_runtime_grant$;

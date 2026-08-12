-- deployment-mode: maintenance
-- Replace the provider-preset / nullable integration identity with one
-- mandatory Integration Definition identity across immutable manifests,
-- compiled revisions, and provider-OAuth Connection metadata. This is a
-- one-way protocol cutover: all opengeni_app sessions must be stopped.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

DO $maintenance_preflight_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'Integration Definition identity activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_preflight_guard$;

LOCK TABLE capability_plugin_versions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE integration_spec_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE connections IN ACCESS EXCLUSIVE MODE;

DO $maintenance_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'Integration Definition identity activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_guard$;

CREATE OR REPLACE FUNCTION opengeni_private.integration_definition_canonical_json(value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $canonical_json$
DECLARE
  rendered text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT COALESCE(
        '{' || string_agg(
          to_jsonb(entry.key)::text || ':' ||
            opengeni_private.integration_definition_canonical_json(entry.value),
          ',' ORDER BY entry.key COLLATE "C"
        ) || '}',
        '{}'
      )
      INTO rendered
      FROM jsonb_each(value) AS entry(key, value);
      RETURN rendered;
    WHEN 'array' THEN
      SELECT COALESCE(
        '[' || string_agg(
          opengeni_private.integration_definition_canonical_json(entry.value),
          ',' ORDER BY entry.ordinality
        ) || ']',
        '[]'
      )
      INTO rendered
      FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(value, ordinality);
      RETURN rendered;
    ELSE
      RETURN value::text;
  END CASE;
END
$canonical_json$;

DO $identity_precondition$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM capability_plugin_versions version
    WHERE version.manifest ->> 'kind' = 'integration'
      AND COALESCE(
        NULLIF(version.manifest ->> 'definitionId', ''),
        NULLIF(version.manifest ->> 'presetId', ''),
        (
          SELECT COALESCE(
            NULLIF(revision.spec ->> 'definitionId', ''),
            NULLIF(revision.spec ->> 'integrationId', '')
          )
          FROM capability_facets facet
          JOIN capability_api_facets api ON api.facet_id = facet.id
          JOIN integration_spec_revisions revision ON revision.api_facet_id = api.facet_id
          WHERE facet.plugin_version_id = version.id
          ORDER BY (revision.status = 'active') DESC, revision.revision DESC
          LIMIT 1
        )
      ) IS NULL
  ) THEN
    RAISE EXCEPTION 'an Integration definition has no recoverable immutable identity'
      USING ERRCODE = '23514';
  END IF;
END
$identity_precondition$;

ALTER TABLE integration_spec_revisions DISABLE TRIGGER integration_spec_revisions_immutable;
ALTER TABLE capability_plugin_versions DISABLE TRIGGER capability_plugin_versions_restrict_update;

UPDATE integration_spec_revisions revision
SET spec = (revision.spec - 'integrationId') || jsonb_build_object(
  'definitionId',
  COALESCE(
    NULLIF(version.manifest ->> 'definitionId', ''),
    NULLIF(version.manifest ->> 'presetId', ''),
    NULLIF(revision.spec ->> 'definitionId', ''),
    NULLIF(revision.spec ->> 'integrationId', '')
  )
)
FROM capability_api_facets api
JOIN capability_facets facet ON facet.id = api.facet_id
JOIN capability_plugin_versions version ON version.id = facet.plugin_version_id
WHERE revision.api_facet_id = api.facet_id
  AND version.manifest ->> 'kind' = 'integration';

WITH migrated AS MATERIALIZED (
  SELECT
    version.id,
    (version.manifest - 'presetId') || jsonb_build_object(
      'definitionId',
      COALESCE(
        NULLIF(version.manifest ->> 'definitionId', ''),
        NULLIF(version.manifest ->> 'presetId', ''),
        (
          SELECT NULLIF(revision.spec ->> 'definitionId', '')
          FROM capability_facets facet
          JOIN capability_api_facets api ON api.facet_id = facet.id
          JOIN integration_spec_revisions revision ON revision.api_facet_id = api.facet_id
          WHERE facet.plugin_version_id = version.id
          ORDER BY (revision.status = 'active') DESC, revision.revision DESC
          LIMIT 1
        )
      ),
      'definitionProvenance',
      COALESCE(
        NULLIF(version.manifest ->> 'definitionProvenance', ''),
        CASE
          WHEN NULLIF(version.manifest ->> 'presetId', '') IS NOT NULL THEN 'curated'
          ELSE 'workspace'
        END
      )
    ) AS manifest
  FROM capability_plugin_versions version
  WHERE version.manifest ->> 'kind' = 'integration'
)
UPDATE capability_plugin_versions version
SET manifest = migrated.manifest,
    manifest_digest = encode(
      digest(
        convert_to(
          opengeni_private.integration_definition_canonical_json(migrated.manifest),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
FROM migrated
WHERE version.id = migrated.id;

UPDATE connections
SET metadata = (metadata - 'authorizedPresetIds') || jsonb_build_object(
  'authorizedDefinitionIds',
  (
    SELECT jsonb_agg(candidate.value ORDER BY candidate.value)
    FROM (
      SELECT DISTINCT value
      FROM jsonb_array_elements_text(
        COALESCE(metadata -> 'authorizedDefinitionIds', '[]'::jsonb) ||
        COALESCE(metadata -> 'authorizedPresetIds', '[]'::jsonb)
      ) AS entry(value)
    ) AS candidate
  )
)
WHERE metadata ->> 'credentialRole' = 'api_integration_oauth'
  AND (
    metadata ? 'authorizedPresetIds'
    OR metadata ? 'authorizedDefinitionIds'
  );

DO $identity_postcondition$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM capability_plugin_versions version
    WHERE version.manifest ->> 'kind' = 'integration'
      AND (
        version.manifest ? 'presetId'
        OR NULLIF(version.manifest ->> 'definitionId', '') IS NULL
        OR version.manifest ->> 'definitionProvenance' NOT IN ('curated', 'workspace')
        OR version.manifest_digest <> encode(
          digest(
            convert_to(
              opengeni_private.integration_definition_canonical_json(version.manifest),
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Integration Definition manifest migration did not converge'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM integration_spec_revisions revision
    JOIN capability_api_facets api ON api.facet_id = revision.api_facet_id
    JOIN capability_facets facet ON facet.id = api.facet_id
    JOIN capability_plugin_versions version ON version.id = facet.plugin_version_id
    WHERE version.manifest ->> 'kind' = 'integration'
      AND (
        revision.spec ? 'integrationId'
        OR NULLIF(revision.spec ->> 'definitionId', '') IS NULL
        OR revision.spec ->> 'definitionId' <> version.manifest ->> 'definitionId'
      )
  ) THEN
    RAISE EXCEPTION 'Integration Definition revision migration did not converge'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM connections
    WHERE metadata ->> 'credentialRole' = 'api_integration_oauth'
      AND (
        metadata ? 'authorizedPresetIds'
        OR jsonb_typeof(metadata -> 'authorizedDefinitionIds') <> 'array'
        OR jsonb_array_length(metadata -> 'authorizedDefinitionIds') = 0
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(metadata -> 'authorizedDefinitionIds') AS entry(value)
          WHERE jsonb_typeof(entry.value) <> 'string'
            OR btrim(entry.value #>> '{}') = ''
        )
      )
  ) THEN
    RAISE EXCEPTION 'Integration Definition Connection metadata migration did not converge'
      USING ERRCODE = '23514';
  END IF;
END
$identity_postcondition$;

ALTER TABLE capability_plugin_versions ENABLE TRIGGER capability_plugin_versions_restrict_update;
ALTER TABLE integration_spec_revisions ENABLE TRIGGER integration_spec_revisions_immutable;

DROP FUNCTION opengeni_private.integration_definition_canonical_json(jsonb);
-- deployment-mode: maintenance
-- Replace the Integration Feature submodel with authoritative Integration
-- Facet definitions and bindings across physical storage, Pack manifests,
-- ownership, and operation results. This is a one-way protocol cutover: all
-- opengeni_app sessions must be stopped and in-flight Pack/Facet operations
-- must be settled before activation.

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
      'Integration Facet activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM capability_operations
    WHERE target_kind IN ('pack', 'facet_binding')
      AND status IN ('pending', 'running')
  ) THEN
    RAISE EXCEPTION
      'Integration Facet activation requires Pack and Facet operations to be settled'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_preflight_guard$;

DO $lock_authority$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'integration_feature_binding_owners',
    'integration_facet_binding_owners',
    'integration_feature_bindings',
    'integration_facet_bindings',
    'integration_feature_facets',
    'integration_facet_definitions',
    'pack_installation_components',
    'pack_installations',
    'workspace_packs',
    'capability_installations',
    'capability_operations'
  ]
  LOOP
    IF to_regclass(relation_name) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', relation_name);
    END IF;
  END LOOP;
END
$lock_authority$;

DO $facet_precondition$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM workspace_packs pack
    WHERE pack.manifest ? 'components'
      AND jsonb_typeof(pack.manifest -> 'components') <> 'array'
  ) OR EXISTS (
    SELECT 1
    FROM pack_installations installation
    WHERE installation.manifest_snapshot IS NOT NULL
      AND installation.manifest_snapshot ? 'components'
      AND jsonb_typeof(installation.manifest_snapshot -> 'components') <> 'array'
  ) THEN
    RAISE EXCEPTION 'a persisted Pack has a non-array components manifest'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workspace_packs pack,
      LATERAL jsonb_array_elements(COALESCE(pack.manifest -> 'components', '[]'::jsonb)) component
    WHERE (
      component ->> 'kind' = 'feature'
      AND (
        NULLIF(component ->> 'featureKey', '') IS NULL
        OR component ? 'facetKey'
      )
    ) OR (
      component ? 'featureKey'
      AND component ->> 'kind' <> 'feature'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pack_installations installation,
      LATERAL jsonb_array_elements(COALESCE(installation.manifest_snapshot -> 'components', '[]'::jsonb)) component
    WHERE installation.manifest_snapshot IS NOT NULL
      AND (
        (
          component ->> 'kind' = 'feature'
          AND (
            NULLIF(component ->> 'featureKey', '') IS NULL
            OR component ? 'facetKey'
          )
        ) OR (
          component ? 'featureKey'
          AND component ->> 'kind' <> 'feature'
        )
      )
  ) THEN
    RAISE EXCEPTION 'a persisted Pack Facet component has ambiguous identity'
      USING ERRCODE = '23514';
  END IF;
END
$facet_precondition$;

CREATE OR REPLACE FUNCTION opengeni_private.integration_facet_rewrite_pack(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $rewrite_pack$
DECLARE
  components jsonb;
BEGIN
  IF NOT (value ? 'components') THEN
    RETURN value;
  END IF;
  IF jsonb_typeof(value -> 'components') <> 'array' THEN
    RAISE EXCEPTION 'Pack components must be an array' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN component.value ->> 'kind' = 'feature' THEN
          (component.value - 'kind' - 'featureKey') || jsonb_build_object(
            'kind', 'facet',
            'facetKey', component.value -> 'featureKey'
          )
        ELSE component.value
      END
      ORDER BY component.ordinality
    ),
    '[]'::jsonb
  )
  INTO components
  FROM jsonb_array_elements(value -> 'components') WITH ORDINALITY AS component(value, ordinality);

  RETURN jsonb_set(value, '{components}', components, false);
END
$rewrite_pack$;

CREATE OR REPLACE FUNCTION opengeni_private.integration_facet_canonical_json(value jsonb)
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
            opengeni_private.integration_facet_canonical_json(entry.value),
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
          opengeni_private.integration_facet_canonical_json(entry.value),
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

UPDATE workspace_packs
SET manifest = opengeni_private.integration_facet_rewrite_pack(manifest)
WHERE manifest ? 'components'
  AND manifest IS DISTINCT FROM opengeni_private.integration_facet_rewrite_pack(manifest);

CREATE TEMP TABLE integration_facet_pack_cutover ON COMMIT DROP AS
  SELECT
    id,
    workspace_id,
    pack_id,
    opengeni_private.integration_facet_rewrite_pack(manifest_snapshot) AS manifest_snapshot
  FROM pack_installations
  WHERE manifest_snapshot IS NOT NULL
    AND manifest_snapshot IS DISTINCT FROM
      opengeni_private.integration_facet_rewrite_pack(manifest_snapshot);

UPDATE pack_installations installation
SET manifest_snapshot = migrated.manifest_snapshot,
    manifest_digest = encode(
      digest(
        convert_to(
          opengeni_private.integration_facet_canonical_json(migrated.manifest_snapshot),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
FROM integration_facet_pack_cutover migrated
WHERE installation.id = migrated.id;

UPDATE capability_installations capability
SET metadata = jsonb_set(
  capability.metadata,
  '{manifestDigest}',
  to_jsonb(installation.manifest_digest),
  true
)
FROM pack_installations installation
JOIN integration_facet_pack_cutover migrated ON migrated.id = installation.id
WHERE capability.workspace_id = migrated.workspace_id
  AND capability.capability_id = 'pack:' || migrated.pack_id
  AND capability.metadata ->> 'platformVersion' = '2';

DELETE FROM capability_operations operation
USING integration_facet_pack_cutover migrated
WHERE operation.workspace_id = migrated.workspace_id
  AND operation.target_kind = 'pack'
  AND operation.target_id = migrated.pack_id;

ALTER TABLE pack_installation_components
  DROP CONSTRAINT IF EXISTS pack_installation_components_kind_chk;

UPDATE pack_installation_components
SET kind = CASE WHEN kind = 'feature' THEN 'facet' ELSE kind END,
    metadata = CASE
      WHEN metadata ? 'featureKey' THEN
        (metadata - 'featureKey') || jsonb_build_object('facetKey', metadata -> 'featureKey')
      ELSE metadata
    END
WHERE kind = 'feature' OR metadata ? 'featureKey';

ALTER TABLE pack_installation_components
  ADD CONSTRAINT pack_installation_components_kind_chk CHECK (
    kind IN ('plugin', 'skill', 'integration', 'facet', 'inline_skill')
  ) NOT VALID;
ALTER TABLE pack_installation_components
  VALIDATE CONSTRAINT pack_installation_components_kind_chk;

DELETE FROM capability_operations
WHERE target_kind = 'facet_binding'
  AND result IS NOT NULL
  AND (
    result ? 'featureKey'
    OR (jsonb_typeof(result -> 'binding') = 'object' AND result -> 'binding' ? 'featureKey')
  );

DO $drop_legacy_triggers$
BEGIN
  IF to_regclass('integration_feature_bindings') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS integration_feature_bindings_validate ON integration_feature_bindings';
  END IF;
  IF to_regclass('integration_facet_bindings') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS integration_feature_bindings_validate ON integration_facet_bindings';
    EXECUTE 'DROP TRIGGER IF EXISTS integration_facet_bindings_validate ON integration_facet_bindings';
  END IF;
  IF to_regclass('integration_feature_binding_owners') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS integration_feature_binding_owners_validate ON integration_feature_binding_owners';
  END IF;
  IF to_regclass('integration_facet_binding_owners') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS integration_feature_binding_owners_validate ON integration_facet_binding_owners';
    EXECUTE 'DROP TRIGGER IF EXISTS integration_facet_binding_owners_validate ON integration_facet_binding_owners';
  END IF;
END
$drop_legacy_triggers$;

DROP FUNCTION IF EXISTS capability_v2_validate_feature_binding();
DROP FUNCTION IF EXISTS capability_v2_validate_feature_binding_owner();

DO $rename_relations$
BEGIN
  IF to_regclass('integration_feature_facets') IS NOT NULL
    AND to_regclass('integration_facet_definitions') IS NULL
  THEN
    ALTER TABLE integration_feature_facets RENAME TO integration_facet_definitions;
  END IF;
  IF to_regclass('integration_feature_bindings') IS NOT NULL
    AND to_regclass('integration_facet_bindings') IS NULL
  THEN
    ALTER TABLE integration_feature_bindings RENAME TO integration_facet_bindings;
  END IF;
  IF to_regclass('integration_feature_binding_owners') IS NOT NULL
    AND to_regclass('integration_facet_binding_owners') IS NULL
  THEN
    ALTER TABLE integration_feature_binding_owners RENAME TO integration_facet_binding_owners;
  END IF;
END
$rename_relations$;

DO $rename_columns$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'integration_facet_definitions'
      AND column_name = 'feature_key'
  ) THEN
    ALTER TABLE integration_facet_definitions RENAME COLUMN feature_key TO facet_key;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'integration_facet_bindings'
      AND column_name = 'feature_facet_id'
  ) THEN
    ALTER TABLE integration_facet_bindings RENAME COLUMN feature_facet_id TO facet_definition_id;
  END IF;
END
$rename_columns$;

DO $rename_constraints$
DECLARE
  target_table text;
  old_name text;
  new_name text;
  constraint_row record;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'integration_facet_definitions',
    'integration_facet_bindings',
    'integration_facet_binding_owners'
  ]
  LOOP
    FOR constraint_row IN
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = to_regclass(target_table)
        AND conname LIKE '%feature%'
      ORDER BY conname
    LOOP
      old_name := constraint_row.conname;
      new_name := replace(old_name, 'integration_feature_facets', 'integration_facet_definitions');
      new_name := replace(new_name, 'integration_feature_bindings', 'integration_facet_bindings');
      new_name := replace(new_name, 'integration_feature_binding_owners', 'integration_facet_binding_owners');
      new_name := replace(new_name, 'feature_facet', 'facet_definition');
      new_name := replace(new_name, 'feature_key', 'facet_key');
      new_name := replace(new_name, 'integration_feature', 'integration_facet');
      new_name := replace(new_name, 'feature', 'facet');
      IF old_name <> new_name THEN
        EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', target_table, old_name, new_name);
      END IF;
    END LOOP;
  END LOOP;
END
$rename_constraints$;

DO $rename_indexes$
DECLARE
  index_row record;
  new_name text;
BEGIN
  FOR index_row IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename IN (
        'integration_facet_definitions',
        'integration_facet_bindings',
        'integration_facet_binding_owners'
      )
      AND indexname LIKE '%feature%'
    ORDER BY indexname
  LOOP
    new_name := replace(index_row.indexname, 'integration_feature_facets', 'integration_facet_definitions');
    new_name := replace(new_name, 'integration_feature_bindings', 'integration_facet_bindings');
    new_name := replace(new_name, 'integration_feature_binding_owners', 'integration_facet_binding_owners');
    new_name := replace(new_name, 'feature_facet', 'facet_definition');
    new_name := replace(new_name, 'feature_key', 'facet_key');
    new_name := replace(new_name, 'integration_feature', 'integration_facet');
    new_name := replace(new_name, 'feature', 'facet');
    IF index_row.indexname <> new_name THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', index_row.indexname, new_name);
    END IF;
  END LOOP;
END
$rename_indexes$;

UPDATE integration_facet_binding_owners
SET owner_id = 'facet:' || substr(owner_id, length('feature:') + 1)
WHERE owner_kind = 'direct'
  AND owner_id LIKE 'feature:%';

CREATE OR REPLACE FUNCTION capability_v2_validate_facet_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM integration_facet_definitions definition
    JOIN capability_facet_installations installation
      ON installation.id = NEW.integration_facet_installation_id
     AND installation.facet_id = definition.integration_facet_id
    WHERE definition.id = NEW.facet_definition_id
      AND installation.account_id = NEW.account_id
      AND installation.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'Facet binding does not match its Integration installation or tenant'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM connections connection
    WHERE connection.id = NEW.connection_id
      AND connection.account_id = NEW.account_id
      AND connection.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'Facet binding Connection belongs to another tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER integration_facet_bindings_validate
  BEFORE INSERT OR UPDATE ON integration_facet_bindings
  FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_facet_binding();

CREATE OR REPLACE FUNCTION capability_v2_validate_facet_binding_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM integration_facet_bindings binding
    WHERE binding.id = NEW.binding_id
      AND binding.account_id = NEW.account_id
      AND binding.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'Facet binding owner does not match its binding tenant'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.owner_kind = 'plugin' THEN
    IF NEW.owner_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Plugin Facet binding owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    ELSIF NOT EXISTS (
      SELECT 1 FROM capability_plugin_installations plugin
      WHERE plugin.id = NEW.owner_id::uuid
        AND plugin.account_id = NEW.account_id
        AND plugin.workspace_id = NEW.workspace_id
    ) THEN
      RAISE EXCEPTION 'Plugin Facet binding owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.owner_kind = 'pack'
    AND NEW.owner_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    IF NOT EXISTS (
      SELECT 1 FROM pack_installations pack
      WHERE pack.id = NEW.owner_id::uuid
        AND pack.account_id = NEW.account_id
        AND pack.workspace_id = NEW.workspace_id
    ) THEN
      RAISE EXCEPTION 'Pack Facet binding owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER integration_facet_binding_owners_validate
  BEFORE INSERT OR UPDATE ON integration_facet_binding_owners
  FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_facet_binding_owner();

DO $facet_postcondition$
BEGIN
  IF to_regclass('integration_feature_facets') IS NOT NULL
    OR to_regclass('integration_feature_bindings') IS NOT NULL
    OR to_regclass('integration_feature_binding_owners') IS NOT NULL
    OR to_regclass('integration_facet_definitions') IS NULL
    OR to_regclass('integration_facet_bindings') IS NULL
    OR to_regclass('integration_facet_binding_owners') IS NULL
  THEN
    RAISE EXCEPTION 'Integration Facet physical authority migration did not converge'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name IN (
        'integration_facet_definitions',
        'integration_facet_bindings',
        'integration_facet_binding_owners'
      )
      AND column_name LIKE '%feature%'
  ) OR EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid IN (
      to_regclass('integration_facet_definitions'),
      to_regclass('integration_facet_bindings'),
      to_regclass('integration_facet_binding_owners')
    )
      AND conname LIKE '%feature%'
  ) OR EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename IN (
        'integration_facet_definitions',
        'integration_facet_bindings',
        'integration_facet_binding_owners'
      )
      AND indexname LIKE '%feature%'
  ) OR EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_schema = current_schema()
      AND event_object_table IN (
        'integration_facet_definitions',
        'integration_facet_bindings',
        'integration_facet_binding_owners'
      )
      AND trigger_name LIKE '%feature%'
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = current_schema()
      AND procedure.proname LIKE '%feature_binding%'
  ) THEN
    RAISE EXCEPTION 'Integration Facet catalog names retain legacy Feature identity'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workspace_packs pack,
      LATERAL jsonb_array_elements(COALESCE(pack.manifest -> 'components', '[]'::jsonb)) component
    WHERE component ->> 'kind' = 'feature'
      OR component ? 'featureKey'
  ) OR EXISTS (
    SELECT 1
    FROM pack_installations installation,
      LATERAL jsonb_array_elements(COALESCE(installation.manifest_snapshot -> 'components', '[]'::jsonb)) component
    WHERE installation.manifest_snapshot IS NOT NULL
      AND (component ->> 'kind' = 'feature' OR component ? 'featureKey')
  ) OR EXISTS (
    SELECT 1 FROM pack_installation_components
    WHERE kind = 'feature' OR metadata ? 'featureKey'
  ) OR EXISTS (
    SELECT 1 FROM integration_facet_binding_owners
    WHERE owner_kind = 'direct' AND owner_id LIKE 'feature:%'
  ) OR EXISTS (
    SELECT 1 FROM capability_operations
    WHERE target_kind = 'facet_binding'
      AND result IS NOT NULL
      AND (
        result ? 'featureKey'
        OR (jsonb_typeof(result -> 'binding') = 'object' AND result -> 'binding' ? 'featureKey')
      )
  ) THEN
    RAISE EXCEPTION 'Integration Facet persisted identity migration did not converge'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pack_installations
    WHERE manifest_snapshot IS NOT NULL
      AND manifest_digest <> encode(
        digest(
          convert_to(
            opengeni_private.integration_facet_canonical_json(manifest_snapshot),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
  ) THEN
    RAISE EXCEPTION 'Integration Facet Pack digest migration did not converge'
      USING ERRCODE = '23514';
  END IF;
END
$facet_postcondition$;

DROP FUNCTION opengeni_private.integration_facet_rewrite_pack(jsonb);
DROP FUNCTION opengeni_private.integration_facet_canonical_json(jsonb);

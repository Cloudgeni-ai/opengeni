-- deployment-mode: rolling
-- contract-step: no application binary reads this registry; only the two
--   database routines redefined below do, in the same transaction
SET lock_timeout = '5s';

-- pg_upgrade cannot carry reg* columns across a PostgreSQL major version:
-- they hold catalog OIDs that the new cluster assigns afresh, so
-- pg_upgrade --check refuses any user table that has one. The session tenancy
-- fence registry kept its bound schema as regnamespace, which blocked every
-- in-place major upgrade. Record the schema by name instead and compare
-- requested schemas with the registry by name.
CREATE FUNCTION pg_temp.session_tenancy_fence_schema_name(target oid)
RETURNS name
LANGUAGE sql
STABLE
AS $schema_name$
  SELECT namespace.nspname FROM pg_catalog.pg_namespace namespace WHERE namespace.oid = target
$schema_name$;

ALTER TABLE opengeni_private.session_tenancy_fence_target_registry
  ALTER COLUMN target_schema TYPE pg_catalog.name
  USING pg_temp.session_tenancy_fence_schema_name(target_schema::pg_catalog.oid);

CREATE OR REPLACE FUNCTION
  opengeni_private.open_session_tenancy_fence_inventory(p_target_schema oid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $open_inventory$
DECLARE
  capability_id_value uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace namespace
    JOIN opengeni_private.session_tenancy_fence_target_registry registry
      ON registry.target_schema = namespace.nspname
      AND registry.singleton
    WHERE namespace.oid = p_target_schema
  ) THEN
    RAISE EXCEPTION 'session tenancy inventory target schema is not registered'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.session_tenancy_fence_inventory_capabilities (
    capability_id, target_schema, backend_pid, transaction_id
  ) VALUES (
    capability_id_value,
    p_target_schema,
    pg_catalog.pg_backend_pid(),
    pg_catalog.pg_current_xact_id()
  );
  RETURN capability_id_value;
END
$open_inventory$;

CREATE OR REPLACE FUNCTION
  opengeni_private.open_session_tenancy_fenced_access(p_target_schema oid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $open_fenced_access$
DECLARE
  capability_id_value uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace namespace
    JOIN opengeni_private.session_tenancy_fence_target_registry registry
      ON registry.target_schema = namespace.nspname
      AND registry.singleton
    WHERE namespace.oid = p_target_schema
  ) THEN
    RAISE EXCEPTION 'session tenancy fenced-access target schema is not registered'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.session_tenancy_fenced_access_capabilities (
    capability_id, target_schema, backend_pid, transaction_id
  ) VALUES (
    capability_id_value,
    p_target_schema,
    pg_catalog.pg_backend_pid(),
    pg_catalog.pg_current_xact_id()
  );
  RETURN capability_id_value;
END
$open_fenced_access$;

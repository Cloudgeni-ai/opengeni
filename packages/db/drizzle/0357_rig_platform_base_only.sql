-- deployment-mode: rolling
-- Rig definitions may customize setup and checks, but the deployment owns the
-- sandbox base image. Preserve historical image-bearing rows for audit and
-- harmless active/provider metadata updates while rejecting every new image
-- override at the storage boundary.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION opengeni_private.enforce_rig_platform_base_only_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.image IS NOT NULL THEN
    RAISE EXCEPTION
      'Rig image overrides are unsupported; Rigs use the deployment platform sandbox image'
      USING ERRCODE = '23514',
        CONSTRAINT = 'rig_versions_platform_base_only';
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.image IS NOT NULL
    AND NEW.image IS DISTINCT FROM OLD.image
  THEN
    RAISE EXCEPTION
      'Rig image overrides are unsupported; Rigs use the deployment platform sandbox image'
      USING ERRCODE = '23514',
        CONSTRAINT = 'rig_versions_platform_base_only';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION opengeni_private.enforce_rig_platform_base_only_v1() FROM PUBLIC;

CREATE TRIGGER rig_versions_platform_base_only
BEFORE INSERT OR UPDATE OF image ON rig_versions
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_rig_platform_base_only_v1();

COMMENT ON COLUMN rig_versions.image IS
  'Legacy audit field only. Runtime ignores it and new non-null values are rejected.';
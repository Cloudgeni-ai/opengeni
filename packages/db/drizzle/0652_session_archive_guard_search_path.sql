-- deployment-mode: rolling
-- 0649 replaced the two imported-archive guard triggers with
-- `SET search_path FROM CURRENT`, which dropped the explicit pin 0560 gave
-- them. Without it a caller's TEMP table could shadow `sessions` inside the
-- guards. Restore the same data-schema pin 0560 applies.
DO $$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION guard_imported_archive_identity() SET search_path=pg_catalog,%I,pg_temp',
    data_schema);
  EXECUTE format(
    'ALTER FUNCTION refuse_imported_archive_execution() SET search_path=pg_catalog,%I,pg_temp',
    data_schema);
END $$;

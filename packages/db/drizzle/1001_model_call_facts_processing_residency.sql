-- deployment-mode: rolling
-- Where the route that served each model call processed it, for EU-only
-- inference: geography, deployment type and regions, never the evidence
-- reference. A nullable column without default or check is a catalog-only
-- change; the previous release never writes it, and null means the call was
-- recorded before calls carried a processing residency.
SET LOCAL lock_timeout = '5s';

ALTER TABLE model_call_facts
  ADD COLUMN IF NOT EXISTS processing_residency jsonb;
COMMENT ON COLUMN model_call_facts.processing_residency IS
  'Processing residency claim of the route that served the call: geography, deploymentType and regions. Never evidence text. Null for calls recorded before 1001.';

-- The Insights calls reader returns each call's processing geography only when
-- the caller asks for it with the private processingGeography query key, which
-- insights_usage_filter ignores. The previous release never asks, so its
-- strict response parser keeps receiving the shape it knows. Assert the exact
-- anchor so source drift cannot silently skip the change.
DO $calls_geography$
DECLARE
  routine regprocedure := 'opengeni_private.insights_scoped_calls_rows(uuid,uuid,timestamptz,timestamptz,jsonb,timestamptz,uuid,integer,uuid[],boolean)'::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(routine);
  anchor text := $old$'cacheWrite',f.list_cache_write_cost_micros,'output',f.list_output_cost_micros) END)$old$;
  replacement text := $new$'cacheWrite',f.list_cache_write_cost_micros,'output',f.list_output_cost_micros) END)
            ||CASE WHEN p_query?'processingGeography' THEN jsonb_build_object('processingGeography',
              CASE WHEN f.processing_residency IS NULL THEN NULL
                WHEN f.processing_residency->>'geography' IN('eu','us','global','other','unknown')
                THEN f.processing_residency->>'geography' ELSE 'unknown' END) ELSE '{}'::jsonb END$new$;
BEGIN
  IF (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, anchor, '')))
    <> pg_catalog.length(anchor) THEN
    RAISE EXCEPTION 'insights calls processing geography: % changed near: %', routine, anchor;
  END IF;
  EXECUTE pg_catalog.replace(definition, anchor, replacement);
END
$calls_geography$;

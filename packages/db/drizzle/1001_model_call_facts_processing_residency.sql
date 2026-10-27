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
-- The reader agrees with parseModelCallProcessingResidency: a malformed stored
-- value (not an object, an unlisted geography or deployment type, regions that
-- are not an array of at most 32 region-shaped strings) reads as unknown, and
-- an eu claim reads as eu only under ModelCallProcessingResidencyV1's rules
-- (EU_CAPABLE_DEPLOYMENT_TYPES, and for Azure and Bedrock at least one region,
-- every one in EU_AZURE_REGIONS or EU_AWS_REGIONS); anything else is unknown.
DO $calls_geography$
DECLARE
  routine regprocedure := 'opengeni_private.insights_scoped_calls_rows(uuid,uuid,timestamptz,timestamptz,jsonb,timestamptz,uuid,integer,uuid[],boolean)'::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(routine);
  anchor text := $old$'cacheWrite',f.list_cache_write_cost_micros,'output',f.list_output_cost_micros) END)$old$;
  replacement text := $new$'cacheWrite',f.list_cache_write_cost_micros,'output',f.list_output_cost_micros) END)
            ||CASE WHEN p_query?'processingGeography' THEN jsonb_build_object('processingGeography',
              CASE WHEN f.processing_residency IS NULL THEN NULL
                WHEN pg_catalog.jsonb_typeof(f.processing_residency) IS DISTINCT FROM 'object' THEN 'unknown'
                WHEN COALESCE(f.processing_residency->>'geography','') NOT IN('eu','us','global','other','unknown') THEN 'unknown'
                WHEN COALESCE(f.processing_residency->>'deploymentType','') NOT IN('azure_regional','azure_data_zone','azure_global','bedrock_regional','bedrock_geo_profile','bedrock_global_profile','gateway','subscription','provider_default','self_hosted','unknown') THEN 'unknown'
                WHEN pg_catalog.jsonb_typeof(f.processing_residency->'regions') IS DISTINCT FROM 'array' THEN 'unknown'
                WHEN pg_catalog.jsonb_array_length(f.processing_residency->'regions')>32 THEN 'unknown'
                WHEN EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(f.processing_residency->'regions') r(v)
                  WHERE pg_catalog.jsonb_typeof(r.v) IS DISTINCT FROM 'string' OR (r.v#>>'{}') !~ '^[a-z0-9][a-z0-9-]{0,62}$') THEN 'unknown'
                WHEN f.processing_residency->>'geography'<>'eu' THEN f.processing_residency->>'geography'
                WHEN f.processing_residency->>'deploymentType' IN('provider_default','self_hosted') THEN 'eu'
                WHEN f.processing_residency->>'deploymentType' NOT IN('azure_regional','azure_data_zone','bedrock_regional','bedrock_geo_profile') THEN 'unknown'
                WHEN pg_catalog.jsonb_array_length(f.processing_residency->'regions')=0 THEN 'unknown'
                WHEN f.processing_residency->>'deploymentType' IN('azure_regional','azure_data_zone')
                  AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(f.processing_residency->'regions') r(v)
                    WHERE r.v NOT IN('"austriaeast"','"belgiumcentral"','"denmarkeast"','"francecentral"','"francesouth"','"germanynorth"','"germanywestcentral"','"italynorth"','"northeurope"','"norwayeast"','"norwaywest"','"polandcentral"','"spaincentral"','"swedencentral"','"swedensouth"','"switzerlandnorth"','"switzerlandwest"','"westeurope"'))
                  THEN 'eu'
                WHEN f.processing_residency->>'deploymentType' IN('bedrock_regional','bedrock_geo_profile')
                  AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(f.processing_residency->'regions') r(v)
                    WHERE r.v NOT IN('"eu-central-1"','"eu-central-2"','"eu-north-1"','"eu-south-1"','"eu-south-2"','"eu-west-1"','"eu-west-3"'))
                  THEN 'eu'
                ELSE 'unknown' END) ELSE '{}'::jsonb END$new$;
BEGIN
  IF (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, anchor, '')))
    <> pg_catalog.length(anchor) THEN
    RAISE EXCEPTION 'insights calls processing geography: % changed near: %', routine, anchor;
  END IF;
  EXECUTE pg_catalog.replace(definition, anchor, replacement);
END
$calls_geography$;

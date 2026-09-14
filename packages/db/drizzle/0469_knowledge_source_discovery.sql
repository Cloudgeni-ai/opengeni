-- deployment-mode: maintenance
-- Source retention and discovery are separate. Preserve exact historical bodies,
-- decisions, evidence links and originals. Classify historical incidental sources
-- only by typed preparation identity / conversation provenance, never their text.
-- Explicit purpose on a new revision overrides this compatibility classification.
-- New source purpose metadata is rejected by pre-0469 strict readers. Drain
-- every API/control/turn runtime login before activation; never restart an old
-- binary after the first purpose-bearing revision is written.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0469 requires explicit application database roles' USING ERRCODE='55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR octet_length(item #>> '{}') NOT BETWEEN 1 AND 63
      OR item #>> '{}' <> btrim(item #>> '{}')
  ) THEN RAISE EXCEPTION '0469 received invalid application roles' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(roles) r ON r.value=a.usename
    WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()) THEN
    RAISE EXCEPTION '0469 requires drained application sessions' USING ERRCODE='55000';
  END IF;
END $drain$;

DO $migration$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure);
  anchor := $old$      AND (NOT(p_request ? 'kind') OR r.body->>'kind'=p_request->>'kind')$old$;
  replacement := anchor || $new$
      -- Apply before scoring and pagination. Evidence access and review remain
      -- governed by the unchanged recursive revision/source visibility checks.
      AND (operation<>'list' OR coalesce(p_request->>'view','published')<>'published'
        OR coalesce((p_request->>'includeEvidence')::boolean,false)
        OR r.body->>'kind'<>'source'
        OR coalesce(r.body#>>'{source,purpose}',CASE
          WHEN e.prepared_file_id IS NOT NULL THEN 'evidence'
          WHEN r.body#>>'{source,kind}'='conversation'
            AND e.legacy_memory_id IS NULL AND e.legacy_document_id IS NULL
            AND e.legacy_claim_id IS NULL AND e.legacy_document_version_id IS NULL THEN 'evidence'
          ELSE 'reference' END)<>'evidence')$new$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge discovery candidate anchor changed';
  END IF;
  EXECUTE replace(definition,anchor,replacement);

  definition := pg_get_functiondef('knowledge_validate_source(uuid,uuid,jsonb)'::regprocedure);
  anchor := $old$  IF NOT knowledge_source_visible(p_account,p_body) THEN$old$;
  replacement := $new$  IF (p_body->'source') ? 'purpose' AND (
    jsonb_typeof(p_body#>'{source,purpose}') IS DISTINCT FROM 'string'
    OR p_body#>>'{source,purpose}' NOT IN ('evidence','reference')) THEN
    RAISE EXCEPTION 'Invalid source purpose' USING ERRCODE='22023'; END IF;
$new$ || anchor;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge source validation anchor changed';
  END IF;
  EXECUTE replace(definition,anchor,replacement);

  definition := pg_get_functiondef('knowledge_entry_prepare_file(uuid,uuid,jsonb,jsonb)'::regprocedure);
  anchor := $old$  body:=jsonb_build_object('title',p_request->'title','kind','source','content',p_request->'content',$old$;
  replacement := $new$  IF p_request ? 'purpose' AND (
    jsonb_typeof(p_request->'purpose') IS DISTINCT FROM 'string'
    OR p_request->>'purpose' NOT IN ('evidence','reference')) THEN
    RAISE EXCEPTION 'Invalid source purpose' USING ERRCODE='22023'; END IF;
$new$ || anchor;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge preparation validation anchor changed';
  END IF;
  definition := replace(definition,anchor,replacement);
  anchor := $old$'retention','full_text','capturedAt',clock_timestamp())$old$;
  replacement := $new$'retention',CASE WHEN p_request->>'content'='' THEN 'reference' ELSE 'full_text' END,
      'purpose',coalesce(p_request->>'purpose','evidence'),'capturedAt',clock_timestamp())$new$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge preparation source anchor changed';
  END IF;
  EXECUTE replace(definition,anchor,replacement);
END $migration$;

-- pg_get_functiondef retains each existing owner, security mode and hardened
-- search_path. CREATE OR REPLACE retains existing ACLs. No new read capability,
-- runtime table grant or alternate lifecycle is introduced by this migration.

-- deployment-mode: rolling
-- The dispatcher table is not readable by the app role. Recheck every exact
-- visible revision through the canonical Knowledge reader before projecting a
-- content-free status; an entry ID supplied by a caller is not an access grant.
CREATE FUNCTION knowledge_visible_index_status(p_account uuid,p_workspace uuid,p_actor jsonb,p_items jsonb,p_view text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE item jsonb; visible jsonb; result jsonb := '[]'::jsonb;
  job knowledge_index_jobs%ROWTYPE;
  previous text := current_setting('opengeni.knowledge_index_dispatcher',true);
  status text;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)>50
    OR p_view IS NULL OR p_view NOT IN ('published','needs_review','archived','rejected') THEN
    RAISE EXCEPTION 'Invalid Knowledge index status request' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (item->>'entryId') IS NULL
      OR (item->>'revisionId') IS NULL THEN
      RAISE EXCEPTION 'Invalid Knowledge index status item' USING ERRCODE='22023';
    END IF;
    visible := knowledge_entry_read(p_account,p_workspace,p_actor,
      jsonb_build_object('operation','get','entryId',item->>'entryId','view',p_view,'limit',1));
    IF visible#>>'{0,revision,id}' IS DISTINCT FROM item->>'revisionId'
      OR visible#>>'{0,revision,kind}' IS DISTINCT FROM 'source' THEN
      CONTINUE;
    END IF;
    PERFORM set_config('opengeni.knowledge_index_dispatcher','1',true);
    SELECT * INTO job FROM knowledge_index_jobs j WHERE j.account_id=p_account
      AND j.entry_id=(item->>'entryId')::uuid AND j.revision_id=(item->>'revisionId')::uuid;
    PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
    status := CASE
      WHEN job.revision_id IS NULL THEN 'saved'
      WHEN job.state='ready' AND job.completed_generation=job.generation THEN 'indexed'
      WHEN job.state='running' THEN 'indexing'
      WHEN job.state='pending' AND job.last_failure='waiting_for_funding' THEN 'awaiting_funding'
      WHEN job.state='pending' AND job.last_failure='source_unavailable' THEN 'source_unavailable'
      WHEN job.state='pending' AND job.last_failure='embedding_unavailable' THEN 'provider_failed'
      ELSE 'queued' END;
    result := result || jsonb_build_array(jsonb_build_object(
      'entryId',item->>'entryId','revisionId',item->>'revisionId','status',status));
  END LOOP;
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION knowledge_visible_index_status(uuid,uuid,jsonb,jsonb,text) FROM PUBLIC;
DO $roles$
DECLARE runtime_role text;
BEGIN
  FOR runtime_role IN SELECT jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) LOOP
    IF runtime_role <> current_user AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION knowledge_visible_index_status(uuid,uuid,jsonb,jsonb,text) TO %I',runtime_role);
    END IF;
  END LOOP;
END $roles$;
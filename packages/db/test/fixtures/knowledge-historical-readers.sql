-- Historical Knowledge reader definitions, copied verbatim from the migrations
-- that shipped them (now folded into the migration baseline). The Knowledge
-- comparison fixtures and benchmarks install them under suffixed names as
-- oracles for the current readers. Never applied by the migrator.

-- section: knowledge_entry_read (from 0461_unified_knowledge.sql)
CREATE FUNCTION knowledge_entry_read(p_account uuid,p_workspace uuid,p_actor jsonb,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
<<knowledge_entry_read>>
DECLARE actor jsonb; result jsonb; pending boolean:=p_request->>'view'='needs_review';
  operation text:=coalesce(p_request->>'operation','list'); take integer:=coalesce((p_request->>'limit')::integer,20);
  query_embedding vector:=CASE WHEN jsonb_typeof(p_request->'embedding')='array' THEN (p_request->'embedding')::text::vector END;
BEGIN
  actor:=knowledge_resolve_actor(p_account,p_workspace,p_actor);
  pending:=coalesce(pending,false);
  IF operation='policy' AND actor->>'kind'='agent' THEN RETURN actor->'policy'; END IF;
  IF take NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid Knowledge page size' USING ERRCODE='22023'; END IF;
  IF operation IN ('source_list','source_read') THEN
    IF actor->>'kind'<>'agent' OR actor#>>'{policy,scheduledTaskRunId}' IS NULL THEN
      RAISE EXCEPTION 'Source content requires its accepted agent run' USING ERRCODE='42501'; END IF;
    SELECT coalesce(jsonb_agg(value ORDER BY id),'[]'::jsonb) INTO result FROM (
      SELECT e.id,jsonb_build_object('entryId',e.id,'revisionId',r.id,'title',r.body->'title',
        'codecVersion',r.body_codec_version,'pending',r.id IS DISTINCT FROM e.published_revision_id)
        || CASE WHEN operation='source_read' THEN jsonb_build_object('content',r.body->'content') ELSE '{}'::jsonb END AS value
      FROM scheduled_task_runs run
      JOIN knowledge_document_versions v ON v.account_id=run.account_id
        AND v.source_id=(run.accepted_execution_snapshot#>>'{task,agentConfig,knowledgeSource,sourceId}')::uuid
      JOIN knowledge_entries e ON e.account_id=v.account_id AND e.legacy_document_version_id=v.id
      JOIN knowledge_entry_revisions r ON r.account_id=e.account_id AND r.entry_id=e.id
        AND r.id=coalesce(CASE WHEN EXISTS(SELECT 1 FROM knowledge_review_batches b
          JOIN knowledge_entry_revisions candidate ON candidate.account_id=b.account_id AND candidate.review_batch_id=b.id
          JOIN knowledge_entry_decisions d ON d.account_id=e.account_id AND d.entry_id=e.id
            AND d.revision_id=candidate.id AND d.version=e.version AND d.outcome='pending'
          WHERE b.account_id=e.account_id AND b.scheduled_task_run_id=run.id AND candidate.id=e.latest_revision_id)
          THEN e.latest_revision_id END,e.published_revision_id)
      WHERE run.account_id=p_account AND run.workspace_id=p_workspace
        AND run.id=(knowledge_entry_read.actor#>>'{policy,scheduledTaskRunId}')::uuid
        AND run.action_kind='agent_turn' AND NOT e.archived AND knowledge_scope_visible(e)
        AND (operation='source_read' OR (r.created_at>=run.created_at
          AND e.document_preparation->>'scheduledTaskRunId'=run.id::text))
        AND knowledge_revision_visible(p_account,e.id,r.id,true)
        AND (NOT(p_request ? 'afterId') OR e.id>(p_request->>'afterId')::uuid)
        AND (operation<>'source_read' OR e.id=(p_request->>'entryId')::uuid)
      ORDER BY e.id LIMIT CASE WHEN operation='source_read' THEN 1 ELSE take+1 END
    ) page;
    RETURN result;
  END IF;

  IF (operation='history' OR p_request->>'view'='rejected')
    AND (actor->>'kind'<>'human' OR actor->>'review' IS DISTINCT FROM 'true') THEN
    RAISE EXCEPTION 'Knowledge history requires human review access' USING ERRCODE='42501';
  END IF;
  IF pending AND actor->>'kind'<>'agent'
    AND (actor->>'kind'<>'human' OR actor->>'review' IS DISTINCT FROM 'true') THEN
    RAISE EXCEPTION 'Pending Knowledge requires a live agent or human reviewer' USING ERRCODE='42501';
  END IF;
  IF p_request->>'view'='archived' AND actor->>'kind'<>'human' THEN
    RAISE EXCEPTION 'Archived Knowledge is a human management view' USING ERRCODE='42501';
  END IF;
  IF operation='review_batches' THEN
    IF actor->>'kind'<>'human' OR actor->>'review' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'Knowledge review groups require human review access' USING ERRCODE='42501'; END IF;
    WITH visible AS MATERIALIZED (
      SELECT b.id,e.scope,b.session_id,b.scheduled_task_run_id,b.created_at,e.id AS entry_id
      FROM knowledge_entries e JOIN knowledge_entry_revisions r
        ON r.account_id=e.account_id AND r.entry_id=e.id AND r.id=e.latest_revision_id
      JOIN knowledge_review_batches b ON b.account_id=e.account_id AND b.id=r.review_batch_id
      JOIN LATERAL (SELECT d.outcome FROM knowledge_entry_decisions d WHERE d.account_id=e.account_id
        AND d.entry_id=e.id AND d.revision_id=r.id ORDER BY d.version DESC LIMIT 1) decision ON true
      WHERE e.account_id=p_account AND decision.outcome='pending' AND knowledge_scope_visible(e)
        AND (knowledge_entry_read.actor->'writeScopes') ? e.scope AND knowledge_revision_visible(p_account,e.id,r.id,true)
        AND (NOT(p_request ? 'scope') OR e.scope=p_request->>'scope')
    ), batches AS (
      SELECT id,scope,session_id,scheduled_task_run_id,created_at,count(*) AS pending_count FROM visible
      GROUP BY id,scope,session_id,scheduled_task_run_id,created_at
      HAVING NOT(p_request ? 'afterId') OR id>(p_request->>'afterId')::uuid
      ORDER BY id LIMIT take+1
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'scope',b.scope,'pendingCount',b.pending_count,
      'createdAt',b.created_at,'sessionId',s.id,'scheduledTaskId',task.id,'scheduledTaskRunId',run.id,
      'title',coalesce(task.name,s.title)) ORDER BY b.id),'[]'::jsonb) INTO result
      FROM batches b LEFT JOIN sessions s ON s.account_id=p_account AND s.id=b.session_id
      LEFT JOIN scheduled_task_runs run ON run.account_id=p_account AND run.id=b.scheduled_task_run_id
      LEFT JOIN scheduled_tasks task ON task.account_id=p_account AND task.id=run.task_id;
    RETURN result;
  END IF;
  IF operation NOT IN ('list','get','history','file') OR (operation='file' AND NOT(p_request ? 'entryId')) THEN RAISE EXCEPTION 'Invalid Knowledge read' USING ERRCODE='22023'; END IF;
  -- Materialize access-filtered records before matching, ranking or pagination.
  WITH candidates AS MATERIALIZED (
    SELECT e.*,r.id AS revision_id,r.number,r.change_kind,r.body,r.body_codec_version,r.preview,r.preview_codec_version,
      r.previous_revision_id,r.restored_from_revision_id,r.created_by_session_id,r.review_batch_id,r.created_at AS revision_created_at,
      CASE WHEN r.id=e.published_revision_id THEN 'published'
        WHEN d.outcome='pending' AND r.id=e.latest_revision_id THEN 'pending'
        WHEN d.outcome='rejected' THEN 'rejected' ELSE 'superseded' END AS outcome
    FROM knowledge_entries e
    JOIN knowledge_entry_revisions r ON r.account_id=e.account_id AND r.entry_id=e.id
      AND (operation='history' OR r.id=CASE WHEN p_request ? 'revisionId' THEN (p_request->>'revisionId')::uuid
        WHEN pending THEN e.latest_revision_id
        WHEN p_request->>'view'='rejected' THEN e.latest_revision_id
        WHEN p_request->>'view'='archived' THEN coalesce(e.published_revision_id,e.latest_revision_id)
        ELSE e.published_revision_id END)
    LEFT JOIN LATERAL (SELECT outcome FROM knowledge_entry_decisions v WHERE v.account_id=e.account_id
      AND v.entry_id=e.id AND v.revision_id=r.id ORDER BY v.version DESC LIMIT 1) d ON true
    WHERE e.account_id=p_account AND knowledge_scope_visible(e)
      AND (operation='history' OR (p_request ? 'revisionId' AND knowledge_entry_read.actor->>'kind'='human' AND knowledge_entry_read.actor->>'review'='true')
        OR e.archived=coalesce(p_request->>'view'='archived',false))
      AND (NOT pending OR (d.outcome='pending' AND r.id=e.latest_revision_id
        AND (knowledge_entry_read.actor->>'kind'='agent' OR (knowledge_entry_read.actor->'writeScopes') ? e.scope)))
      AND (p_request->>'view' IS DISTINCT FROM 'rejected' OR d.outcome='rejected')
      AND (NOT(p_request ? 'scope') OR e.scope=p_request->>'scope')
      AND (NOT(p_request ? 'entryId') OR e.id=(p_request->>'entryId')::uuid)
      AND (NOT(p_request ? 'kind') OR r.body->>'kind'=p_request->>'kind')
      AND (NOT(p_request ? 'fileId') OR r.body#>>'{source,fileId}'=p_request->>'fileId'
        OR EXISTS(SELECT 1 FROM knowledge_entry_links l
          JOIN knowledge_entry_revisions source_revision ON source_revision.account_id=l.account_id
            AND source_revision.entry_id=l.target_entry_id AND source_revision.id=l.target_revision_id
          WHERE l.account_id=e.account_id AND l.entry_id=e.id AND l.revision_id=r.id
            AND l.relation='evidence' AND source_revision.body#>>'{source,fileId}'=p_request->>'fileId'))
      AND (NOT(p_request ? 'sessionId') OR r.created_by_session_id=(p_request->>'sessionId')::uuid)
      AND (NOT(p_request ? 'reviewBatchId') OR r.review_batch_id=(p_request->>'reviewBatchId')::uuid)
      AND (NOT(p_request ? 'groupId') OR EXISTS(SELECT 1 FROM knowledge_entry_links l
        WHERE l.account_id=e.account_id AND l.entry_id=e.id AND l.revision_id=r.id
          AND l.relation='group' AND l.target_entry_id=(p_request->>'groupId')::uuid
          AND EXISTS(SELECT 1 FROM knowledge_entries g WHERE g.account_id=p_account AND g.id=l.target_entry_id
            AND NOT g.archived AND knowledge_revision_visible(p_account,g.id,
              CASE WHEN pending THEN g.latest_revision_id ELSE g.published_revision_id END,pending))))
      -- Filter before pagination. A hidden, archived, or out-of-scope parent must
      -- never strand an otherwise readable entry outside the tree.
      AND (NOT coalesce((p_request->>'rootOnly')::boolean,false) OR NOT EXISTS(
        SELECT 1 FROM knowledge_entry_links l
        JOIN knowledge_entries g ON g.account_id=l.account_id AND g.id=l.target_entry_id
        JOIN knowledge_entry_revisions gr ON gr.account_id=g.account_id AND gr.entry_id=g.id
          AND gr.id=CASE WHEN pending THEN g.latest_revision_id ELSE g.published_revision_id END
        WHERE l.account_id=e.account_id AND l.entry_id=e.id AND l.revision_id=r.id AND l.relation='group'
          AND NOT g.archived AND gr.body->>'kind'='group'
          AND (NOT(p_request ? 'scope') OR g.scope=p_request->>'scope')
          AND knowledge_revision_visible(p_account,g.id,gr.id,pending)))
      AND (NOT(p_request ? 'beforeRevision') OR r.number<(p_request->>'beforeRevision')::integer)
      AND (knowledge_entry_read.actor->>'kind'='human' AND knowledge_entry_read.actor->>'review'='true'
        OR (pending AND knowledge_entry_read.actor->>'kind'='agent')
        OR EXISTS(SELECT 1 FROM knowledge_entry_decisions v WHERE v.account_id=e.account_id
          AND v.entry_id=e.id AND v.revision_id=r.id AND v.outcome='published'))
      AND knowledge_revision_visible(p_account,e.id,r.id,
        pending OR (knowledge_entry_read.actor->>'kind'='human' AND knowledge_entry_read.actor->>'review'='true'))
  ), scored AS (
    SELECT c.*,coalesce(lex.score,0) AS keyword_score,coalesce(semantic.similarity,0) AS similarity,
      CASE WHEN coalesce(p_request->>'query','')='' THEN 0
        WHEN coalesce(p_request->>'mode','hybrid')='vector' THEN coalesce(semantic.similarity,0)
        WHEN coalesce(p_request->>'mode','hybrid')='keyword' THEN coalesce(lex.score/(1+lex.score),0)
        ELSE coalesce(lex.score/(1+lex.score),0)+coalesce(semantic.similarity,0) END AS score,
      CASE WHEN semantic.keyword_match OR semantic.similarity>=0.2 THEN
        jsonb_build_array(jsonb_build_object('field',semantic.field,'start',semantic.start_offset,'end',semantic.end_offset,
          'text',semantic.text,'codecVersion',semantic.text_codec_version)) ELSE '[]'::jsonb END AS excerpts
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT max(ts_rank_cd(s.search_vector,websearch_to_tsquery('simple',p_request->>'query'))) AS score
      FROM knowledge_entry_search s WHERE s.account_id=p_account AND s.entry_id=c.id AND s.revision_id=c.revision_id
        AND coalesce(p_request->>'query','')<>''
    ) lex ON true
    LEFT JOIN LATERAL (
      SELECT v.field,v.start_offset,v.end_offset,v.text,v.text_codec_version,
        v.keyword_match,max(v.similarity) OVER () AS similarity FROM (
        SELECT cache.*,
          to_tsvector('simple',cache.text)@@websearch_to_tsquery('simple',p_request->>'query') AS keyword_match,
          CASE WHEN query_embedding IS NOT NULL AND cache.dimensions=vector_dims(query_embedding)
            AND cache.model=p_request->>'embeddingModel' AND vector_norm(query_embedding)>0
            THEN greatest(0,least(1,1-(cache.embedding<=>query_embedding))) ELSE 0 END AS similarity
        FROM knowledge_entry_vectors cache JOIN knowledge_index_jobs job ON job.account_id=cache.account_id
          AND job.revision_id=cache.revision_id AND job.completed_generation=cache.generation
        WHERE cache.account_id=p_account AND cache.entry_id=c.id AND cache.revision_id=c.revision_id
          AND coalesce(p_request->>'query','')<>''
      ) v ORDER BY CASE WHEN p_request->>'mode'='vector' THEN false ELSE v.keyword_match END DESC,v.similarity DESC,v.chunk_index LIMIT 1
    ) semantic ON true
  ), page AS (
    SELECT * FROM scored s WHERE (coalesce(p_request->>'query','')=''
      OR (coalesce(p_request->>'mode','hybrid')<>'vector' AND s.keyword_score>0)
      OR (coalesce(p_request->>'mode','hybrid')<>'keyword' AND s.similarity>=0.2))
      AND (NOT(p_request ? 'afterId') OR s.score<(p_request->>'afterScore')::double precision
        OR (s.score=(p_request->>'afterScore')::double precision AND s.id>(p_request->>'afterId')::uuid))
    ORDER BY s.score DESC,s.id,s.number DESC LIMIT take+1
  ) SELECT coalesce(jsonb_agg(jsonb_build_object(
    'score',c.score,'excerpts',c.excerpts,'id',c.id,'scope',c.scope,'version',c.version,'publishedRevisionId',c.published_revision_id,
    'latestRevisionId',c.latest_revision_id,'archived',c.archived,'createdAt',c.created_at,'updatedAt',c.updated_at,
    'revision',jsonb_build_object('id',c.revision_id,'entryId',c.id,'number',c.number,
      'entry',CASE WHEN operation IN ('get','file') THEN knowledge_entry_visible_body(p_account,c.body,pending) ELSE NULL END,'change',c.change_kind,
      'title',c.body->'title','kind',c.body->>'kind','preview',c.preview,'groupIds',knowledge_entry_visible_body(p_account,c.body,pending)->'groupIds',
      'sourceKind',c.body#>>'{source,kind}','bodyCodecVersion',c.body_codec_version,'previewCodecVersion',c.preview_codec_version,
      'previousRevisionId',c.previous_revision_id,'restoredFromRevisionId',c.restored_from_revision_id,
      'createdAt',c.revision_created_at,'createdBySessionId',c.created_by_session_id,
      'reviewBatchId',c.review_batch_id,'outcome',c.outcome)
  ) ORDER BY c.score DESC,c.id,c.number DESC),'[]'::jsonb) INTO result FROM page c;
  IF operation='file' THEN
    IF result#>>'{0,revision,entry,source,documentId}' IS NOT NULL THEN
      SELECT to_jsonb(f) INTO result FROM resolve_document_original_file(p_account,p_workspace,
        nullif(current_setting('opengeni.subject_id',true),''),(result#>>'{0,revision,entry,source,documentId}')::uuid) f;
    ELSE
      SELECT to_jsonb(f) INTO result FROM files f WHERE f.account_id=p_account AND f.status='ready'
        AND f.id=(result#>>'{0,revision,entry,source,fileId}')::uuid;
    END IF;
  END IF;
  RETURN result;
END $$;

-- section: knowledge_entry_visible_body (from 0461_unified_knowledge.sql)
CREATE FUNCTION knowledge_entry_visible_body(p_account uuid,p_body jsonb,p_pending boolean)
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path FROM CURRENT AS $$
  SELECT p_body || jsonb_build_object(
    'groupIds',coalesce((SELECT jsonb_agg(g.value ORDER BY g.ordinality)
      FROM jsonb_array_elements(p_body->'groupIds') WITH ORDINALITY g(value,ordinality)
      JOIN knowledge_entries e ON e.account_id=p_account AND e.id=(g.value#>>'{}')::uuid
      WHERE NOT e.archived AND knowledge_revision_visible(p_account,e.id,
        coalesce(e.published_revision_id,CASE WHEN p_pending THEN e.latest_revision_id END),p_pending)), '[]'::jsonb),
    'relationships',coalesce((SELECT jsonb_agg(l.value ORDER BY l.ordinality)
      FROM jsonb_array_elements(p_body->'relationships') WITH ORDINALITY l(value,ordinality)
      JOIN knowledge_entries e ON e.account_id=p_account AND e.id=(l.value->>'entryId')::uuid
      WHERE NOT e.archived AND knowledge_revision_visible(p_account,e.id,
        coalesce(e.published_revision_id,CASE WHEN p_pending THEN e.latest_revision_id END),p_pending)), '[]'::jsonb))
$$;

-- section: knowledge_revision_visible (from 0461_unified_knowledge.sql)
CREATE FUNCTION knowledge_revision_visible(p_account uuid,p_entry uuid,p_revision uuid,p_pending boolean)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path FROM CURRENT AS $$
  WITH RECURSIVE dependencies(entry_id,revision_id) AS (
    SELECT p_entry,p_revision
    UNION
    SELECT l.target_entry_id,l.target_revision_id FROM dependencies d
      JOIN knowledge_entry_links l ON l.account_id=p_account AND l.entry_id=d.entry_id
        AND l.revision_id=d.revision_id AND l.relation='evidence'
  ) SELECT EXISTS(SELECT 1 FROM knowledge_entry_revisions r WHERE r.account_id=p_account
    AND r.entry_id=p_entry AND r.id=p_revision)
    AND NOT EXISTS (
      SELECT 1 FROM dependencies d LEFT JOIN knowledge_entries e ON e.account_id=p_account AND e.id=d.entry_id
        LEFT JOIN knowledge_entry_revisions r ON r.account_id=p_account AND r.entry_id=d.entry_id AND r.id=d.revision_id
      WHERE e.id IS NULL OR NOT knowledge_scope_visible(e) OR (e.archived AND e.id<>p_entry)
        OR (NOT p_pending AND NOT EXISTS(SELECT 1 FROM knowledge_entry_decisions v
          WHERE v.account_id=p_account AND v.entry_id=d.entry_id AND v.revision_id=d.revision_id AND v.outcome='published'))
        OR (e.legacy_document_version_id IS NOT NULL AND NOT knowledge_legacy_version_visible(p_account,e.legacy_document_version_id))
        OR (e.legacy_document_id IS NOT NULL AND NOT knowledge_document_visible(e.legacy_document_id))
        OR (e.access_document_id IS NOT NULL AND NOT knowledge_document_visible(e.access_document_id))
        OR (e.access_file_id IS NOT NULL AND NOT google_drive_file_authorized(p_account,
          nullif(current_setting('opengeni.workspace_id',true),'')::uuid,
          nullif(current_setting('opengeni.subject_id',true),''),e.access_file_id))
        OR r.id IS NULL OR NOT knowledge_source_visible(p_account,r.body)
    )
$$;

-- section: knowledge_scope_visible (from 0461_unified_knowledge.sql)
CREATE FUNCTION knowledge_scope_visible(e knowledge_entries) RETURNS boolean
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT coalesce(e.account_id=nullif(current_setting('opengeni.account_id',true),'')::uuid
    AND (e.scope='organization'
      OR (e.scope='workspace' AND e.scope_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid)
      OR (e.scope='personal' AND e.scope_subject_id=nullif(current_setting('opengeni.subject_id',true),'')
        AND (current_setting('opengeni.knowledge_actor_kind',true)='human'
          OR current_setting('opengeni.knowledge_default_scope',true)='personal')))
    AND (e.legacy_scope_workspace_id IS NULL OR e.legacy_scope_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid)
    AND e.valid_from<=transaction_timestamp() AND (e.valid_until IS NULL OR e.valid_until>transaction_timestamp())
    AND (e.legacy_memory_id IS NULL OR e.origin_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid)
    AND (e.legacy_scope_type IS NULL OR opengeni_private.memory_scope_visible(
      e.legacy_scope_type,e.scope_subject_id,e.legacy_scope_role_key,e.legacy_scope_session_id,e.valid_from,e.valid_until)),false)
$$;

-- section: knowledge_source_discovery_reader (from 0469_knowledge_source_discovery.sql, its reader rewrite only)
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


END $migration$;

-- section: knowledge_entry_created_since (from 0640_knowledge_entry_created_since.sql)
-- deployment-mode: rolling
-- Additive list/search filter on original entry creation, not revision/update
-- time. Existing binaries omit the parameter and retain their exact behavior.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $migration$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure);
  anchor := $old$      AND (NOT(p_request ? 'entryId') OR e.id=(p_request->>'entryId')::uuid)$old$;
  replacement := anchor || $new$
      -- Filter the authorized candidate set before keyword/vector ranking and
      -- take+one pagination, consistently for every list view and scope.
      AND (operation<>'list' OR NOT(p_request ? 'createdSince')
        OR e.created_at >= (p_request->>'createdSince')::timestamptz)$new$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge creation-date candidate anchor changed';
  END IF;
  EXECUTE replace(definition,anchor,replacement);
END $migration$;

-- pg_get_functiondef preserves the owner, SECURITY DEFINER and hardened
-- search_path; CREATE OR REPLACE preserves the existing function ACLs. No new
-- grants, indexes, content backfills or changes to visibility are required.

-- section: keyed_knowledge_visibility (from 0878_keyed_knowledge_visibility.sql)
-- deployment-mode: rolling
-- Walk only the exact dependency identities, not every account entry/link for
-- each visibility check. OFFSET 0 retains parameterized index lookups even when
-- the recursive CTE's generic row estimate is much larger than the real graph.
-- UNION still deduplicates cycles; every scope, revision and source ACL predicate
-- is unchanged. This replaces an internal function, not its authority or grants.
CREATE OR REPLACE FUNCTION knowledge_revision_visible(p_account uuid,p_entry uuid,p_revision uuid,p_pending boolean)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path FROM CURRENT AS $$
  WITH RECURSIVE dependencies(entry_id,revision_id) AS (
    SELECT p_entry,p_revision
    UNION
    SELECT l.target_entry_id,l.target_revision_id FROM dependencies d
      CROSS JOIN LATERAL (
        SELECT l.target_entry_id,l.target_revision_id FROM knowledge_entry_links l
        WHERE l.account_id=p_account AND l.entry_id=d.entry_id
          AND l.revision_id=d.revision_id AND l.relation='evidence' OFFSET 0
      ) l
  ) SELECT EXISTS(SELECT 1 FROM knowledge_entry_revisions r WHERE r.account_id=p_account
    AND r.entry_id=p_entry AND r.id=p_revision)
    AND NOT EXISTS (
      SELECT 1 FROM dependencies d
        LEFT JOIN LATERAL (
          SELECT e.* FROM knowledge_entries e
          WHERE e.account_id=p_account AND e.id=d.entry_id OFFSET 0
        ) e ON true
        LEFT JOIN LATERAL (
          SELECT r.* FROM knowledge_entry_revisions r
          WHERE r.account_id=p_account AND r.entry_id=d.entry_id AND r.id=d.revision_id OFFSET 0
        ) r ON true
      WHERE e.id IS NULL OR NOT knowledge_scope_visible(e::knowledge_entries) OR (e.archived AND e.id<>p_entry)
        OR (NOT p_pending AND NOT EXISTS(SELECT 1 FROM knowledge_entry_decisions v
          WHERE v.account_id=p_account AND v.entry_id=d.entry_id
            AND v.revision_id=d.revision_id AND v.outcome='published' OFFSET 0))
        OR (e.legacy_document_version_id IS NOT NULL AND NOT knowledge_legacy_version_visible(p_account,e.legacy_document_version_id))
        OR (e.legacy_document_id IS NOT NULL AND NOT knowledge_document_visible(e.legacy_document_id))
        OR (e.access_document_id IS NOT NULL AND NOT knowledge_document_visible(e.access_document_id))
        OR (e.access_file_id IS NOT NULL AND NOT google_drive_file_authorized(p_account,
          nullif(current_setting('opengeni.workspace_id',true),'')::uuid,
          nullif(current_setting('opengeni.subject_id',true),''),e.access_file_id))
        OR r.id IS NULL OR NOT knowledge_source_visible(p_account,r.body)
    )
$$;

-- CREATE OR REPLACE also replaces proconfig. Preserve the hardened lookup order
-- in the actual installation schema, including embedded installations.
DO $secure$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.knowledge_revision_visible(uuid,uuid,uuid,boolean) SET search_path = %I, pg_catalog, pg_temp',
    current_schema(),current_schema());
END $secure$;

-- section: knowledge_revisions_visible_sql (from 0902_batched_knowledge_visibility.sql)
CREATE FUNCTION knowledge_revisions_visible(
  p_account uuid, p_entries uuid[], p_revisions uuid[], p_pending boolean
) RETURNS TABLE(entry_id uuid, revision_id uuid)
LANGUAGE sql VOLATILE SET search_path FROM CURRENT AS $$
  WITH RECURSIVE roots AS MATERIALIZED (
    SELECT DISTINCT entry_id,revision_id
    FROM unnest(p_entries,p_revisions) AS x(entry_id,revision_id)
  ), dependencies(root_entry_id,root_revision_id,entry_id,revision_id) AS (
    SELECT entry_id,revision_id,entry_id,revision_id FROM roots
    UNION
    SELECT d.root_entry_id,d.root_revision_id,l.target_entry_id,l.target_revision_id
    FROM dependencies d
    CROSS JOIN LATERAL (
      SELECT l.target_entry_id,l.target_revision_id FROM knowledge_entry_links l
      WHERE l.account_id=p_account AND l.entry_id=d.entry_id
        AND l.revision_id=d.revision_id AND l.relation='evidence' OFFSET 0
    ) l
  ), identities AS MATERIALIZED (
    SELECT DISTINCT entry_id,revision_id FROM dependencies
  ), visibility AS MATERIALIZED (
    SELECT d.entry_id,d.revision_id,e.archived,
      e.id IS NOT NULL AND knowledge_scope_visible(e::knowledge_entries)
        AND (p_pending OR EXISTS(SELECT 1 FROM knowledge_entry_decisions v
          WHERE v.account_id=p_account AND v.entry_id=d.entry_id
            AND v.revision_id=d.revision_id AND v.outcome='published' OFFSET 0))
        AND (e.legacy_document_version_id IS NULL OR knowledge_legacy_version_visible(p_account,e.legacy_document_version_id))
        AND (e.legacy_document_id IS NULL OR knowledge_document_visible(e.legacy_document_id))
        AND (e.access_document_id IS NULL OR knowledge_document_visible(e.access_document_id))
        AND (e.access_file_id IS NULL OR google_drive_file_authorized(p_account,
          nullif(current_setting('opengeni.workspace_id',true),'')::uuid,
          nullif(current_setting('opengeni.subject_id',true),''),e.access_file_id))
        AND r.id IS NOT NULL AND knowledge_source_visible(p_account,r.body) AS visible
    FROM identities d
    LEFT JOIN LATERAL (SELECT e.* FROM knowledge_entries e
      WHERE e.account_id=p_account AND e.id=d.entry_id OFFSET 0) e ON true
    LEFT JOIN LATERAL (SELECT r.* FROM knowledge_entry_revisions r
      WHERE r.account_id=p_account AND r.entry_id=d.entry_id AND r.id=d.revision_id OFFSET 0) r ON true
  ), root_visibility AS MATERIALIZED (
    SELECT d.root_entry_id,d.root_revision_id,
      bool_or(NOT v.visible OR (v.archived AND d.entry_id<>d.root_entry_id)) AS denied
    FROM dependencies d JOIN visibility v USING(entry_id,revision_id)
    GROUP BY d.root_entry_id,d.root_revision_id
  )
  SELECT root.entry_id,root.revision_id FROM roots root
  JOIN root_visibility checked ON checked.root_entry_id=root.entry_id
    AND checked.root_revision_id=root.revision_id
  WHERE EXISTS(SELECT 1 FROM knowledge_entry_revisions r WHERE r.account_id=p_account
    AND r.entry_id=root.entry_id AND r.id=root.revision_id)
    AND checked.denied IS NOT TRUE
$$;

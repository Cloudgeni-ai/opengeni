-- deployment-mode: rolling
-- Evaluate the matched candidate population together. Evidence identities shared
-- by multiple roots need one ACL check, rather than one recursive SQL invocation
-- per candidate. All visibility decisions remain inside the current read; the
-- existing VOLATILE source helpers and accepted-agent locks are unchanged.
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

-- Keep scalar callers on the same visibility implementation. Its exported
-- boolean contract, volatility, owner and grants do not change.
CREATE OR REPLACE FUNCTION knowledge_revision_visible(p_account uuid,p_entry uuid,p_revision uuid,p_pending boolean)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path FROM CURRENT AS $$
  SELECT EXISTS(SELECT 1 FROM knowledge_revisions_visible(
    p_account,ARRAY[p_entry],ARRAY[p_revision],p_pending))
$$;

-- Validate catalog text separately; this preflight reads no tenant data.
DO $verify$
DECLARE
  definition text := pg_get_functiondef('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure);
  anchor text := $anchor$      AND knowledge_revision_visible(p_account,e.id,r.id,
        pending OR (knowledge_entry_read.actor->>'kind'='human' AND knowledge_entry_read.actor->>'review'='true'))
  ), scored AS ($anchor$;
BEGIN
  IF (length(definition)-length(replace(definition,'WITH candidates AS MATERIALIZED (','')))/length('WITH candidates AS MATERIALIZED (')<>1
    OR (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
    RAISE EXCEPTION 'Knowledge read source contract changed before batched visibility';
  END IF;
END
$verify$;

DO $read$
DECLARE
  definition text := pg_get_functiondef('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure);
  anchor text := $anchor$      AND knowledge_revision_visible(p_account,e.id,r.id,
        pending OR (knowledge_entry_read.actor->>'kind'='human' AND knowledge_entry_read.actor->>'review'='true'))
  ), scored AS ($anchor$;
BEGIN
  definition:=replace(definition,'WITH candidates AS MATERIALIZED (','WITH candidate_rows AS MATERIALIZED (');
  definition:=replace(definition,anchor,$replacement$
      -- Keyword ranks are per revision, not normalized across the population.
      -- This is the same positive-rank condition as page, before any LIMIT.
      -- Vector/hybrid eligibility is deliberately left unchanged.
      AND (coalesce(p_request->>'mode','hybrid')<>'keyword'
        OR coalesce(p_request->>'query','')=''
        OR EXISTS(SELECT 1 FROM knowledge_entry_search search
          WHERE search.account_id=p_account AND search.entry_id=e.id AND search.revision_id=r.id
            AND ts_rank_cd(search.search_vector,websearch_to_tsquery('simple',p_request->>'query'))>0))
  ), allowed AS MATERIALIZED (
    SELECT v.* FROM (SELECT array_agg(id) ids,array_agg(revision_id) revisions FROM candidate_rows) c
    CROSS JOIN LATERAL knowledge_revisions_visible(p_account,c.ids,c.revisions,
      pending OR (knowledge_entry_read.actor->>'kind'='human' AND knowledge_entry_read.actor->>'review'='true')) v
  ), candidates AS MATERIALIZED (
    SELECT c.* FROM candidate_rows c JOIN allowed a ON a.entry_id=c.id AND a.revision_id=c.revision_id
  ), scored AS ($replacement$);
  definition:=replace(definition,
    '-- Materialize access-filtered records before matching, ranking or pagination.',
    '-- Match keyword candidates, then materialize access-filtered records before ranking or pagination.');
  EXECUTE definition;
END
$read$;

-- The new helper is internal and owned by the existing visibility owner. CREATE
-- OR REPLACE preserves existing ownership/ACL but replaces proconfig, so harden
-- both helpers in the actual installation schema, including embedded installs.
DO $secure$
DECLARE
  owner_name text := pg_get_userbyid((SELECT proowner FROM pg_proc
    WHERE oid='knowledge_revision_visible(uuid,uuid,uuid,boolean)'::regprocedure));
BEGIN
  EXECUTE format('ALTER FUNCTION %I.knowledge_revisions_visible(uuid,uuid[],uuid[],boolean) OWNER TO %I',
    current_schema(),owner_name);
  EXECUTE format('ALTER FUNCTION %I.knowledge_revisions_visible(uuid,uuid[],uuid[],boolean) SET search_path = %I, pg_catalog, pg_temp',
    current_schema(),current_schema());
  EXECUTE format('REVOKE ALL ON FUNCTION %I.knowledge_revisions_visible(uuid,uuid[],uuid[],boolean) FROM PUBLIC',current_schema());
  EXECUTE format('ALTER FUNCTION %I.knowledge_revision_visible(uuid,uuid,uuid,boolean) SET search_path = %I, pg_catalog, pg_temp',
    current_schema(),current_schema());
END
$secure$;

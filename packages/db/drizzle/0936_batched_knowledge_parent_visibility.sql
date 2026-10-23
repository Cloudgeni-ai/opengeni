-- deployment-mode: rolling
-- Parent collection checks share the existing per-read batch visibility seam.
-- Filtering still precedes candidate ACL checks, ranking and pagination. No
-- authority persists beyond this statement; scalar/full-body readers stay live.
-- Catalog-only preflight; it reads no FORCE-RLS tenant data.
DO $verify$
DECLARE
  definition text := pg_get_functiondef('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure);
  first_anchor text := $a$      AND (NOT(p_request ? 'groupId') OR EXISTS$a$;
  last_anchor text := $a$      AND (NOT(p_request ? 'beforeRevision')$a$;
  batch_anchor text := $a$  ), allowed AS MATERIALIZED ($a$;
  group_call text := $a$knowledge_revision_visible(p_account,g.id,
              CASE WHEN pending THEN g.latest_revision_id ELSE g.published_revision_id END,pending)$a$;
  root_call text := 'knowledge_revision_visible(p_account,g.id,gr.id,pending)';
  first_offset integer := strpos(definition,first_anchor);
  last_offset integer := strpos(definition,last_anchor);
  predicates text;
BEGIN
  IF first_offset=0 OR last_offset<=first_offset
    OR (length(definition)-length(replace(definition,first_anchor,'')))/length(first_anchor)<>1
    OR (length(definition)-length(replace(definition,last_anchor,'')))/length(last_anchor)<>1
    OR (length(definition)-length(replace(definition,batch_anchor,'')))/length(batch_anchor)<>1
    OR strpos(definition,'FROM candidate_rows) c')=0
    OR strpos(definition,'SELECT c.* FROM candidate_rows c JOIN allowed')=0 THEN
    RAISE EXCEPTION 'Knowledge parent batching source contract changed';
  END IF;
  predicates:=substr(definition,first_offset,last_offset-first_offset);
  IF strpos(predicates,group_call)=0 OR strpos(predicates,root_call)=0 THEN
    RAISE EXCEPTION 'Knowledge parent visibility predicates changed';
  END IF;
END
$verify$;

DO $parents$
DECLARE
  definition text := pg_get_functiondef('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure);
  first_offset integer := strpos(definition,$a$      AND (NOT(p_request ? 'groupId') OR EXISTS$a$);
  last_offset integer := strpos(definition,$a$      AND (NOT(p_request ? 'beforeRevision')$a$);
  batch_anchor text := $a$  ), allowed AS MATERIALIZED ($a$;
  group_call text := $a$knowledge_revision_visible(p_account,g.id,
              CASE WHEN pending THEN g.latest_revision_id ELSE g.published_revision_id END,pending)$a$;
  root_call text := 'knowledge_revision_visible(p_account,g.id,gr.id,pending)';
  predicates text := substr(definition,first_offset,last_offset-first_offset);
BEGIN
  definition:=substr(definition,1,first_offset-1)||substr(definition,last_offset);
  predicates:=replace(predicates,group_call,
    'EXISTS(SELECT 1 FROM visible_parents vp WHERE vp.entry_id=g.id AND vp.revision_id=CASE WHEN pending THEN g.latest_revision_id ELSE g.published_revision_id END)');
  predicates:=replace(predicates,root_call,
    'EXISTS(SELECT 1 FROM visible_parents vp WHERE vp.entry_id=g.id AND vp.revision_id=gr.id)');
  predicates:=replace(predicates,'l.account_id=e.account_id','l.account_id=c.account_id');
  predicates:=replace(predicates,'l.entry_id=e.id','l.entry_id=c.id');
  predicates:=replace(predicates,'l.revision_id=r.id','l.revision_id=c.revision_id');
  definition:=replace(definition,batch_anchor,$batch$  ), parent_targets AS MATERIALIZED (
    SELECT DISTINCT g.id AS entry_id,
      CASE WHEN pending THEN g.latest_revision_id ELSE g.published_revision_id END AS revision_id
    FROM candidate_rows c
    JOIN knowledge_entry_links l ON l.account_id=c.account_id AND l.entry_id=c.id
      AND l.revision_id=c.revision_id AND l.relation='group'
    JOIN knowledge_entries g ON g.account_id=l.account_id AND g.id=l.target_entry_id
    WHERE NOT g.archived
      AND ((p_request ? 'groupId' AND g.id=(p_request->>'groupId')::uuid)
        OR (coalesce((p_request->>'rootOnly')::boolean,false)
          AND (NOT(p_request ? 'scope') OR g.scope=p_request->>'scope')
          AND EXISTS(SELECT 1 FROM knowledge_entry_revisions gr
            WHERE gr.account_id=g.account_id AND gr.entry_id=g.id
              AND gr.id=CASE WHEN pending THEN g.latest_revision_id ELSE g.published_revision_id END
              AND gr.body->>'kind'='group')))
  ), visible_parents AS MATERIALIZED (
    SELECT v.* FROM (SELECT array_agg(entry_id) ids,array_agg(revision_id) revisions FROM parent_targets) p
    CROSS JOIN LATERAL knowledge_revisions_visible(p_account,p.ids,p.revisions,pending) v
  ), matched_candidates AS MATERIALIZED (
    SELECT c.* FROM candidate_rows c WHERE true
$batch$||predicates||batch_anchor);
  definition:=replace(definition,'FROM candidate_rows) c','FROM matched_candidates) c');
  definition:=replace(definition,'SELECT c.* FROM candidate_rows c JOIN allowed','SELECT c.* FROM matched_candidates c JOIN allowed');
  -- Keep the exact existing metadata, owner, grants and hardened search_path.
  EXECUTE definition;
END
$parents$;

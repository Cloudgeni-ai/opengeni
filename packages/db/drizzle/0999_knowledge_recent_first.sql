-- deployment-mode: rolling
-- Knowledge lists without a query ranked every entry 0 and tie-broke on the
-- random entry id, so lists had no meaningful order. A list request may now ask
-- for `order` = 'updated' (latest change first; a collection counts as changed
-- when it or anything inside it changes) or 'created' (newest entry first).
-- A change is the latest decision on the revision this read shows (published,
-- proposed or rejected), or its creation without one, so
-- approving a proposal moves it up while a pending or rejected proposal never
-- reorders the published Library.
-- Relevance still leads when there is a query; the order key only breaks ties.
-- Review groups may ask for 'updated' too: the newest pending change first.
-- Existing binaries never send `order` and keep their exact results, cursors
-- and projection; only requests that send it get the extra order keys.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $migration$
DECLARE definition text; anchor text;
  procedure regprocedure := 'knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure;
BEGIN
  definition := pg_get_functiondef(procedure);

  -- 0. Keep the time of the latest decision on each read revision.
  anchor := $old$r.review_batch_id,r.created_at AS revision_created_at,$old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge revision time anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$r.review_batch_id,r.created_at AS revision_created_at,d.created_at AS decided_at,$new$);
  anchor := $old$(SELECT outcome FROM$old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge decision anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$(SELECT outcome,created_at FROM$new$);

  -- 1. Collection activity: walk current membership edges below the listed
  -- collections, descending only into sub-collections (UNION ends cycles), then
  -- count only members this reader may see, using the same batched visibility
  -- check as the candidates. Searches rank by relevance and skip the walk.
  anchor := $old$  ), candidates AS MATERIALIZED (
    SELECT c.* FROM candidate_rows c JOIN allowed a ON a.entry_id=c.id AND a.revision_id=c.revision_id
  ), scored AS ($old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge candidates anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$  ), candidates AS MATERIALIZED (
    SELECT c.* FROM candidate_rows c JOIN allowed a ON a.entry_id=c.id AND a.revision_id=c.revision_id
  ), member_rows AS MATERIALIZED (
    WITH RECURSIVE walk(group_id,entry_id,revision_id,changed_at,is_group) AS (
      SELECT g.id,e.id,l.revision_id,coalesce(d.created_at,r.created_at),r.body->>'kind'='group'
      FROM candidates g
      JOIN knowledge_entry_links l ON l.account_id=p_account AND l.target_entry_id=g.id AND l.relation='group'
      JOIN knowledge_entries e ON e.account_id=l.account_id AND e.id=l.entry_id
        AND l.revision_id=CASE WHEN pending THEN e.latest_revision_id ELSE e.published_revision_id END
      JOIN knowledge_entry_revisions r ON r.account_id=l.account_id AND r.id=l.revision_id
      LEFT JOIN LATERAL (SELECT v.created_at FROM knowledge_entry_decisions v WHERE v.account_id=e.account_id
        AND v.entry_id=e.id AND v.revision_id=l.revision_id ORDER BY v.version DESC LIMIT 1) d ON true
      WHERE p_request->>'order'='updated' AND coalesce(p_request->>'query','')=''
        AND g.body->>'kind'='group'
        AND NOT e.archived AND knowledge_scope_visible(e)
        AND (NOT(p_request ? 'scope') OR e.scope=p_request->>'scope')
      UNION
      SELECT w.group_id,e.id,l.revision_id,coalesce(d.created_at,r.created_at),r.body->>'kind'='group'
      FROM walk w
      JOIN knowledge_entry_links l ON l.account_id=p_account AND l.target_entry_id=w.entry_id AND l.relation='group'
      JOIN knowledge_entries e ON e.account_id=l.account_id AND e.id=l.entry_id
        AND l.revision_id=CASE WHEN pending THEN e.latest_revision_id ELSE e.published_revision_id END
      JOIN knowledge_entry_revisions r ON r.account_id=l.account_id AND r.id=l.revision_id
      LEFT JOIN LATERAL (SELECT v.created_at FROM knowledge_entry_decisions v WHERE v.account_id=e.account_id
        AND v.entry_id=e.id AND v.revision_id=l.revision_id ORDER BY v.version DESC LIMIT 1) d ON true
      WHERE w.is_group AND NOT e.archived AND knowledge_scope_visible(e)
        AND (NOT(p_request ? 'scope') OR e.scope=p_request->>'scope')
    ) SELECT * FROM walk
  ), member_allowed AS MATERIALIZED (
    SELECT v.* FROM (SELECT array_agg(m.entry_id) ids,array_agg(m.revision_id) revisions FROM (
      SELECT DISTINCT m.entry_id,m.revision_id FROM member_rows m
      WHERE NOT EXISTS(SELECT 1 FROM allowed a WHERE a.entry_id=m.entry_id AND a.revision_id=m.revision_id)) m) c
    CROSS JOIN LATERAL knowledge_revisions_visible(p_account,c.ids,c.revisions,
      pending OR (knowledge_entry_read.actor->>'kind'='human' AND knowledge_entry_read.actor->>'review'='true')) v
  ), group_activity AS MATERIALIZED (
    SELECT m.group_id,max(m.changed_at) AS changed_at FROM member_rows m
    WHERE EXISTS(SELECT 1 FROM allowed a WHERE a.entry_id=m.entry_id AND a.revision_id=m.revision_id)
      OR EXISTS(SELECT 1 FROM member_allowed a WHERE a.entry_id=m.entry_id AND a.revision_id=m.revision_id)
    GROUP BY m.group_id
  ), scored AS ($new$);

  -- 2. The order key, next to the relevance score.
  anchor := $old$    SELECT c.*,coalesce(lex.score,0) AS keyword_score,$old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge score anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$    SELECT c.*,CASE p_request->>'order' WHEN 'created' THEN c.created_at
        WHEN 'updated' THEN greatest(coalesce(c.decided_at,c.revision_created_at),activity.changed_at)
        END AS ordered_at,
      coalesce(lex.score,0) AS keyword_score,$new$);
  anchor := $old$    FROM candidates c
    LEFT JOIN LATERAL ($old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge scored source anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$    FROM candidates c
    LEFT JOIN group_activity activity ON activity.group_id=c.id
    LEFT JOIN LATERAL ($new$);

  -- 3. Keyset pages on (score, order key, id). Without `order` the key is NULL
  -- everywhere and this is exactly the previous (score, id) order.
  anchor := $old$      AND (NOT(p_request ? 'afterId') OR s.score<(p_request->>'afterScore')::double precision
        OR (s.score=(p_request->>'afterScore')::double precision AND s.id>(p_request->>'afterId')::uuid))
    ORDER BY s.score DESC,s.id,s.number DESC LIMIT take+1$old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge page anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$      AND (NOT(p_request ? 'afterId') OR s.score<(p_request->>'afterScore')::double precision
        OR (s.score=(p_request->>'afterScore')::double precision
          AND (s.ordered_at<(p_request->>'afterOrderedAt')::timestamptz
            OR (s.ordered_at IS NOT DISTINCT FROM (p_request->>'afterOrderedAt')::timestamptz
              AND s.id>(p_request->>'afterId')::uuid))))
    ORDER BY s.score DESC,s.ordered_at DESC,s.id,s.number DESC LIMIT take+1$new$);

  -- 4. Return the key only to callers that asked for an order.
  anchor := $old$  ) SELECT coalesce(jsonb_agg(jsonb_build_object(
    'score',c.score,$old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge projection anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$  ) SELECT coalesce(jsonb_agg(CASE WHEN c.ordered_at IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('orderedAt',c.ordered_at) END||jsonb_build_object(
    'score',c.score,$new$);
  anchor := $old$  ) ORDER BY c.score DESC,c.id,c.number DESC),'[]'::jsonb) INTO result FROM page c;$old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge result order anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$  ) ORDER BY c.score DESC,c.ordered_at DESC,c.id,c.number DESC),'[]'::jsonb) INTO result FROM page c;$new$);

  -- 5. Review groups: the newest pending change first.
  anchor := $old$      SELECT b.id,e.scope,b.session_id,b.scheduled_task_run_id,b.created_at,e.id AS entry_id$old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge review group source anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$      SELECT b.id,e.scope,b.session_id,b.scheduled_task_run_id,b.created_at,e.id AS entry_id,
        r.created_at AS changed_at$new$);
  anchor := $old$      SELECT id,scope,session_id,scheduled_task_run_id,created_at,count(*) AS pending_count FROM visible
      GROUP BY id,scope,session_id,scheduled_task_run_id,created_at
      HAVING NOT(p_request ? 'afterId') OR id>(p_request->>'afterId')::uuid
      ORDER BY id LIMIT take+1$old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge review group page anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$      SELECT id,scope,session_id,scheduled_task_run_id,created_at,count(*) AS pending_count,
        CASE WHEN p_request->>'order'='updated' THEN max(changed_at) END AS ordered_at FROM visible
      GROUP BY id,scope,session_id,scheduled_task_run_id,created_at
      HAVING NOT(p_request ? 'afterId') OR (CASE WHEN p_request->>'order'='updated' THEN max(changed_at) END)
          <(p_request->>'afterOrderedAt')::timestamptz
        OR ((CASE WHEN p_request->>'order'='updated' THEN max(changed_at) END)
          IS NOT DISTINCT FROM (p_request->>'afterOrderedAt')::timestamptz AND id>(p_request->>'afterId')::uuid)
      ORDER BY ordered_at DESC,id LIMIT take+1$new$);
  anchor := $old$    ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,$old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge review group projection anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$    ) SELECT coalesce(jsonb_agg(CASE WHEN b.ordered_at IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('orderedAt',b.ordered_at) END||jsonb_build_object('id',b.id,$new$);
  anchor := $old$'title',coalesce(task.name,s.title)) ORDER BY b.id),'[]'::jsonb) INTO result$old$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge review group order anchor changed';
  END IF;
  definition := replace(definition,anchor,$new$'title',coalesce(task.name,s.title)) ORDER BY b.ordered_at DESC,b.id),'[]'::jsonb) INTO result$new$);

  EXECUTE definition;
END $migration$;

-- pg_get_functiondef preserves the owner, SECURITY DEFINER and hardened
-- search_path; CREATE OR REPLACE preserves the existing function ACLs. The walk
-- uses knowledge_entry_links_target_idx. No new grants, indexes or backfills.

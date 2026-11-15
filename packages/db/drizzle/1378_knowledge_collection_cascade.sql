-- deployment-mode: rolling
-- Archiving a Knowledge collection takes what is only inside it along.
--
-- Archiving a collection used to archive only the collection. Its
-- sub-collections then appeared at the top level (a hidden or archived parent
-- never strands a readable entry), and its entries stayed in use, so the
-- collection seemed to come back. The host now archives, in the same
-- transaction, every live entry whose collections are all inside the archived
-- tree, through knowledge_entry_apply with operation ids derived from the
-- collection's archive. Restoring that collection restores exactly those.
--
-- This adds knowledge_entry_read's read-only 'collection_cascade' operation,
-- which finds those entries. 'archive' lists the visible live entries under a
-- live collection, with their collections and citing entries inside the tree,
-- and whether a live collection or entry outside it holds or cites them.
-- 'restore' lists the visible entries archived with the archive that this
-- restore undoes, also when it was a collection above that took this one
-- along. A member's operation id is md5('opengeni:knowledge-archived-with:'
-- || archive operation || ':' || entry) as a version 8 UUID, so it is found
-- by key. Every write still goes through knowledge_entry_apply's checks.
-- Older binaries never call the operation; newer ones archive without the
-- cascade until it exists.
SET LOCAL lock_timeout = '5s';

DO $knowledge_collection_cascade$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(format(
    '%I.knowledge_entry_read(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure);
  anchor := $a$  IF operation='policy' AND actor->>'kind'='agent' THEN RETURN actor->'policy'; END IF;
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_entry_read policy anchor drifted';
  END IF;
  definition := replace(definition, anchor, anchor || $r$  IF operation='collection_cascade' THEN
    DECLARE root knowledge_entries%ROWTYPE; root_operation uuid; cascade_operation uuid;
    BEGIN
      SELECT * INTO root FROM knowledge_entries h WHERE h.account_id=p_account
        AND h.id=(p_request->>'entryId')::uuid;
      IF NOT FOUND OR NOT knowledge_scope_visible(root) OR NOT EXISTS(
        SELECT 1 FROM knowledge_entry_revisions r WHERE r.account_id=p_account
          AND r.id=root.latest_revision_id AND r.body->>'kind'='group') THEN
        RETURN jsonb_build_object('members','[]'::jsonb);
      END IF;
      IF p_request->>'mode'='archive' AND NOT root.archived THEN
        -- Live published members under the collection. A member stays when a
        -- live collection outside the tree holds it, or a live entry outside
        -- it cites or relates to it; links inside the tree are returned so
        -- the host keeps what a kept member holds or cites.
        WITH RECURSIVE tree(id,depth) AS (
          SELECT root.id,0
          UNION
          SELECT c.id,tree.depth+1 FROM tree
          JOIN knowledge_entry_links l ON l.account_id=p_account AND l.target_entry_id=tree.id
            AND l.relation='group'
          JOIN knowledge_entries c ON c.account_id=l.account_id AND c.id=l.entry_id
            AND l.revision_id=c.published_revision_id AND NOT c.archived
          WHERE tree.depth<1000
        ), nodes AS (
          SELECT id,min(depth) AS depth FROM tree GROUP BY id
        ), inbound AS (
          SELECT l.target_entry_id AS id,l.relation,s.id AS source_id,
            EXISTS(SELECT 1 FROM nodes n WHERE n.id=s.id) AS inside
          FROM nodes JOIN knowledge_entry_links l ON l.account_id=p_account AND l.target_entry_id=nodes.id
          JOIN knowledge_entries s ON s.account_id=l.account_id AND s.id=l.entry_id
            AND l.revision_id=s.published_revision_id AND NOT s.archived
          WHERE nodes.id<>root.id AND s.id<>l.target_entry_id
        )
        SELECT jsonb_build_object('members',coalesce(jsonb_agg(jsonb_build_object(
            'entryId',c.id,'version',c.version,'depth',n.depth,
            'parentIds',coalesce((SELECT jsonb_agg(DISTINCT g.id) FROM knowledge_entry_links l
              JOIN knowledge_entries g ON g.account_id=l.account_id AND g.id=l.target_entry_id AND NOT g.archived
              WHERE l.account_id=c.account_id AND l.entry_id=c.id AND l.revision_id=c.published_revision_id
                AND l.relation='group' AND EXISTS(SELECT 1 FROM nodes t WHERE t.id=g.id)),'[]'::jsonb),
            'citedByIds',coalesce((SELECT jsonb_agg(DISTINCT i.source_id) FROM inbound i
              WHERE i.id=c.id AND i.inside AND i.relation<>'group'),'[]'::jsonb),
            'heldElsewhere',EXISTS(SELECT 1 FROM inbound i WHERE i.id=c.id AND NOT i.inside)
              OR EXISTS(SELECT 1 FROM knowledge_entry_links l
                JOIN knowledge_entries g ON g.account_id=l.account_id AND g.id=l.target_entry_id AND NOT g.archived
                WHERE l.account_id=c.account_id AND l.entry_id=c.id AND l.revision_id=c.published_revision_id
                  AND l.relation='group' AND NOT EXISTS(SELECT 1 FROM nodes t WHERE t.id=g.id)))
          ORDER BY n.depth,c.id),'[]'::jsonb))
        INTO result
        FROM nodes n JOIN knowledge_entries c ON c.account_id=p_account AND c.id=n.id
        WHERE c.id<>root.id AND knowledge_scope_visible(c);
        RETURN result;
      ELSIF p_request->>'mode'='restore' AND root.archived THEN
        -- The archive this restore undoes: the collection's own, or that of
        -- the archived collection above it that took it along.
        SELECT o.operation_id INTO root_operation FROM knowledge_entry_operations o
          WHERE o.account_id=p_account AND o.entry_id=root.id
            AND o.receipt->>'revisionId'=root.latest_revision_id::text
            AND o.receipt->>'outcome'='archived';
        IF root_operation IS NULL THEN RETURN jsonb_build_object('members','[]'::jsonb); END IF;
        cascade_operation:=root_operation;
        WITH RECURSIVE up(id,depth) AS (
          SELECT root.id,0
          UNION
          SELECT g.id,up.depth+1 FROM up
          JOIN knowledge_entries u ON u.account_id=p_account AND u.id=up.id
          JOIN knowledge_entry_links l ON l.account_id=u.account_id AND l.entry_id=u.id
            AND l.relation='group' AND l.revision_id=u.latest_revision_id
          JOIN knowledge_entries g ON g.account_id=l.account_id AND g.id=l.target_entry_id AND g.archived
          WHERE up.depth<1000
        )
        SELECT o.operation_id INTO cascade_operation FROM up
        JOIN knowledge_entries a ON a.account_id=p_account AND a.id=up.id
        JOIN knowledge_entry_operations o ON o.account_id=a.account_id AND o.entry_id=a.id
          AND o.receipt->>'revisionId'=a.latest_revision_id::text AND o.receipt->>'outcome'='archived'
        WHERE up.id<>root.id AND overlay(overlay(md5('opengeni:knowledge-archived-with:'||o.operation_id::text
          ||':'||root.id::text) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid=root_operation
        LIMIT 1;
        cascade_operation:=coalesce(cascade_operation,root_operation);
        -- Members archived with that archive, through collections restored since.
        WITH RECURSIVE tree(id,depth) AS (
          SELECT root.id,0
          UNION
          SELECT c.id,tree.depth+1 FROM tree
          JOIN knowledge_entry_links l ON l.account_id=p_account AND l.target_entry_id=tree.id
            AND l.relation='group'
          JOIN knowledge_entries c ON c.account_id=l.account_id AND c.id=l.entry_id
            AND l.revision_id IN (c.latest_revision_id,c.published_revision_id)
          WHERE tree.depth<1000
        ), nodes AS (
          SELECT id,min(depth) AS depth FROM tree GROUP BY id
        )
        SELECT jsonb_build_object('archiveOperationId',cascade_operation,'members',
          coalesce(jsonb_agg(jsonb_build_object('entryId',c.id,'version',c.version,'depth',n.depth,
            'publishedRevisionId',c.published_revision_id) ORDER BY n.depth,c.id),'[]'::jsonb))
        INTO result
        FROM nodes n JOIN knowledge_entries c ON c.account_id=p_account AND c.id=n.id
        JOIN knowledge_entry_operations o ON o.account_id=c.account_id
          AND o.operation_id=overlay(overlay(md5('opengeni:knowledge-archived-with:'||cascade_operation::text
            ||':'||c.id::text) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid
          AND o.receipt->>'revisionId'=c.latest_revision_id::text
        WHERE c.id<>root.id AND c.archived AND c.published_revision_id IS NOT NULL
          AND knowledge_scope_visible(c);
        RETURN result;
      END IF;
      RETURN jsonb_build_object('members','[]'::jsonb);
    END;
  END IF;
$r$);
  EXECUTE definition;
END
$knowledge_collection_cascade$;

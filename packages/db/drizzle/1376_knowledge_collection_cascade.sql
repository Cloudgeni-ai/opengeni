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
-- which finds those entries: 'archive' lists the live entries under a live
-- collection the caller can see, with their parents inside the tree and
-- whether a live collection outside it also holds them; 'restore' lists the
-- archived entries under an archived collection with the operation that
-- archived each, and the collection's own. Every write still goes through
-- knowledge_entry_apply's checks. Older binaries never call the operation.
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
    DECLARE root knowledge_entries%ROWTYPE; root_operation uuid;
    BEGIN
      SELECT * INTO root FROM knowledge_entries h WHERE h.account_id=p_account
        AND h.id=(p_request->>'entryId')::uuid;
      IF NOT FOUND OR NOT knowledge_scope_visible(root) OR NOT EXISTS(
        SELECT 1 FROM knowledge_entry_revisions r WHERE r.account_id=p_account
          AND r.id=root.latest_revision_id AND r.body->>'kind'='group') THEN
        RETURN jsonb_build_object('members','[]'::jsonb);
      END IF;
      IF p_request->>'mode'='archive' AND NOT root.archived THEN
        WITH RECURSIVE tree(id) AS (
          SELECT root.id
          UNION
          SELECT c.id FROM tree
          JOIN knowledge_entry_links l ON l.account_id=p_account AND l.target_entry_id=tree.id
            AND l.relation='group'
          JOIN knowledge_entries c ON c.account_id=l.account_id AND c.id=l.entry_id
            AND l.revision_id=c.published_revision_id AND NOT c.archived
        ), parents AS (
          SELECT c.id,c.version,g.id AS parent_id,EXISTS(SELECT 1 FROM tree t WHERE t.id=g.id) AS inside
          FROM tree JOIN knowledge_entries c ON c.account_id=p_account AND c.id=tree.id
          LEFT JOIN knowledge_entry_links l ON l.account_id=c.account_id AND l.entry_id=c.id
            AND l.revision_id=c.published_revision_id AND l.relation='group'
          LEFT JOIN knowledge_entries g ON g.account_id=l.account_id AND g.id=l.target_entry_id
            AND NOT g.archived
          WHERE c.id<>root.id AND knowledge_scope_visible(c)
        )
        SELECT jsonb_build_object('members',coalesce(jsonb_agg(m ORDER BY m->>'entryId'),'[]'::jsonb))
        INTO result FROM (
          SELECT jsonb_build_object('entryId',p.id,'version',p.version,
            'parentIds',coalesce(jsonb_agg(DISTINCT p.parent_id) FILTER (WHERE p.inside),'[]'::jsonb),
            'heldElsewhere',coalesce(bool_or(p.parent_id IS NOT NULL AND NOT p.inside),false)) AS m
          FROM parents p GROUP BY p.id,p.version
        ) members;
        RETURN result;
      ELSIF p_request->>'mode'='restore' AND root.archived THEN
        SELECT o.operation_id INTO root_operation FROM knowledge_entry_operations o
          WHERE o.account_id=p_account AND o.entry_id=root.id
            AND o.receipt->>'revisionId'=root.latest_revision_id::text
            AND o.receipt->>'outcome'='archived';
        WITH RECURSIVE tree(id) AS (
          SELECT root.id
          UNION
          SELECT c.id FROM tree
          JOIN knowledge_entry_links l ON l.account_id=p_account AND l.target_entry_id=tree.id
            AND l.relation='group'
          JOIN knowledge_entries c ON c.account_id=l.account_id AND c.id=l.entry_id
            AND l.revision_id=c.latest_revision_id AND c.archived
        )
        SELECT jsonb_build_object('archiveOperationId',root_operation,'members',
          coalesce(jsonb_agg(jsonb_build_object('entryId',c.id,'version',c.version,
            'publishedRevisionId',c.published_revision_id,'archiveOperationId',o.operation_id)
            ORDER BY c.id),'[]'::jsonb))
        INTO result
        FROM tree JOIN knowledge_entries c ON c.account_id=p_account AND c.id=tree.id
        JOIN knowledge_entry_operations o ON o.account_id=c.account_id AND o.entry_id=c.id
          AND o.receipt->>'revisionId'=c.latest_revision_id::text AND o.receipt->>'outcome'='archived'
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

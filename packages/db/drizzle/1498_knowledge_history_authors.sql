-- deployment-mode: rolling
-- Knowledge history says "You" for the versions you saved.
--
-- A Knowledge entry's history named every person's version "A teammate",
-- including your own, because a history read returns no author. This adds
-- knowledge_entry_read's read-only 'history_authors' operation: of the
-- revision ids given, the ones of a visible entry that the person asking
-- saved. It answers only for a person, compares only with the verified
-- subject (knowledge_resolve_actor), and returns ids, never another person's
-- identity. Older binaries never call it; newer ones fall back to "A
-- teammate" until it exists.
SET LOCAL lock_timeout = '5s';

DO $knowledge_history_authors$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(format(
    '%I.knowledge_entry_read(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure);
  anchor := $a$  IF operation='policy' AND actor->>'kind'='agent' THEN RETURN actor->'policy'; END IF;
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_entry_read policy anchor drifted';
  END IF;
  definition := replace(definition, anchor, anchor || $r$  IF operation='history_authors' THEN
    IF knowledge_entry_read.actor->>'kind' IS DISTINCT FROM 'human'
      OR jsonb_typeof(p_request->'revisionIds') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_request->'revisionIds')>50 THEN
      RETURN '[]'::jsonb;
    END IF;
    RETURN coalesce((
      SELECT jsonb_agg(r.id ORDER BY r.number DESC)
      FROM knowledge_entries e
      JOIN knowledge_entry_revisions r ON r.account_id=e.account_id AND r.entry_id=e.id
      WHERE e.account_id=p_account AND e.id=(p_request->>'entryId')::uuid
        AND knowledge_scope_visible(e)
        AND r.id IN (SELECT value::uuid FROM jsonb_array_elements_text(p_request->'revisionIds'))
        AND r.actor->>'kind'='human'
        AND r.actor->>'subjectId'=knowledge_entry_read.actor->>'subjectId'
    ),'[]'::jsonb);
  END IF;
$r$);
  EXECUTE definition;
END
$knowledge_history_authors$;

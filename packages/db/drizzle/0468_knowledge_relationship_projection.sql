-- deployment-mode: rolling
-- Preserve the read capability, ACL/evidence checks and pagination contract.
-- A join from jsonb_array_elements (estimated at 100 rows) can hash against the
-- whole account and evaluate the VOLATILE recursive visibility predicate before
-- matching an endpoint. A scalar subquery pins each check to its exact identity:
-- absent endpoints remain hidden, duplicates and original array order survive.
CREATE OR REPLACE FUNCTION knowledge_entry_visible_body(p_account uuid,p_body jsonb,p_pending boolean)
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path FROM CURRENT AS $$
  SELECT p_body || jsonb_build_object(
    'groupIds',coalesce((SELECT jsonb_agg(g.value ORDER BY g.ordinality)
      FROM jsonb_array_elements(p_body->'groupIds') WITH ORDINALITY g(value,ordinality)
      WHERE (SELECT NOT e.archived AND knowledge_revision_visible(p_account,e.id,
          coalesce(e.published_revision_id,CASE WHEN p_pending THEN e.latest_revision_id END),p_pending)
        FROM knowledge_entries e
        WHERE e.account_id=p_account AND e.id=(g.value#>>'{}')::uuid)), '[]'::jsonb),
    'relationships',coalesce((SELECT jsonb_agg(l.value ORDER BY l.ordinality)
      FROM jsonb_array_elements(p_body->'relationships') WITH ORDINALITY l(value,ordinality)
      WHERE (SELECT NOT e.archived AND knowledge_revision_visible(p_account,e.id,
          coalesce(e.published_revision_id,CASE WHEN p_pending THEN e.latest_revision_id END),p_pending)
        FROM knowledge_entries e
        WHERE e.account_id=p_account AND e.id=(l.value->>'entryId')::uuid)), '[]'::jsonb))
$$;

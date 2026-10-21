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

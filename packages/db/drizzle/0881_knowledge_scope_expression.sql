-- deployment-mode: rolling
-- Keep the scope predicate as one cached PL/pgSQL expression rather than a
-- non-inline SQL query executed for every candidate and evidence identity.
-- No predicate, volatility, ownership, privilege or lookup-path change.
CREATE OR REPLACE FUNCTION knowledge_scope_visible(e knowledge_entries) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
BEGIN
  RETURN coalesce(e.account_id=nullif(current_setting('opengeni.account_id',true),'')::uuid
    AND (e.scope='organization'
      OR (e.scope='workspace' AND e.scope_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid)
      OR (e.scope='personal' AND e.scope_subject_id=nullif(current_setting('opengeni.subject_id',true),'')
        AND (current_setting('opengeni.knowledge_actor_kind',true)='human'
          OR current_setting('opengeni.knowledge_default_scope',true)='personal')))
    AND (e.legacy_scope_workspace_id IS NULL OR e.legacy_scope_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid)
    AND e.valid_from<=transaction_timestamp() AND (e.valid_until IS NULL OR e.valid_until>transaction_timestamp())
    AND (e.legacy_memory_id IS NULL OR e.origin_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid)
    AND (e.legacy_scope_type IS NULL OR opengeni_private.memory_scope_visible(
      e.legacy_scope_type,e.scope_subject_id,e.legacy_scope_role_key,e.legacy_scope_session_id,e.valid_from,e.valid_until)),false);
END
$$;

-- CREATE OR REPLACE resets proconfig. Reapply the existing hardened path in the
-- actual installation schema, including embedded installations.
DO $secure$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.knowledge_scope_visible(%I.knowledge_entries) SET search_path = %I, pg_catalog, pg_temp',
    current_schema(),current_schema(),current_schema());
END
$secure$;

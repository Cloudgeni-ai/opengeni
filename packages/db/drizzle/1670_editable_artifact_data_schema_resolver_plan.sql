-- deployment-mode: rolling
-- resolve_editable_artifact_data_schema runs at the start of every editable
-- artifact routine (prod: 3,625 calls in 5 h, 11.5 ms self each, mostly from
-- the cleanup_expired_editable_artifact_live_tickets loop). Its cost was
-- planning, not execution: one statement joined pg_namespace, six pg_class
-- rows and pg_roles, an 8-way join that took about 26 ms to plan warm (about
-- 0.3 ms to run) and was planned again on most calls, since PL/pgSQL plans a
-- parameterized statement afresh for its first five calls on each pooled
-- connection and idle connections close after 30 s.
--
-- Same checks, one relation to plan: the six relations are counted in the
-- requested schema instead of joined. (relname, relnamespace) is unique in
-- pg_class, so a count of 6 means each of the six names exists there as an
-- ordinary or partitioned table with RLS enabled and forced, owned by
-- current_user. The old join required exactly that: every relation's owner
-- equal to editable_artifact_live_outbox's owner, and that owner's rolname
-- equal to current_user. The schema conditions, the session_user USAGE check,
-- the NULL check, the result and both errors are unchanged.
--
-- CREATE OR REPLACE keeps the owner, ACL, signature, SECURITY DEFINER and
-- search path. No table is locked.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE OR REPLACE FUNCTION opengeni_private.resolve_editable_artifact_data_schema(requested_schema name) RETURNS name
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE data_schema name;
BEGIN
  IF requested_schema IS NULL THEN
    RAISE EXCEPTION 'editable artifact data schema is unavailable or untrusted'
      USING ERRCODE = '42501';
  END IF;
  SELECT namespace.nspname INTO data_schema
  FROM pg_catalog.pg_namespace namespace
  WHERE namespace.nspname = requested_schema
    AND namespace.nspname !~ '^pg_'
    AND namespace.nspname <> 'information_schema'
    AND (SELECT count(*) FROM pg_catalog.pg_class relation
      WHERE relation.relnamespace = namespace.oid
        AND relation.relname IN ('editable_artifact_live_outbox', 'editable_artifacts',
          'editable_artifact_scope_authorization_heads', 'editable_artifact_materialization_jobs',
          'editable_artifact_materialization_results', 'editable_artifact_blob_refs')
        AND relation.relkind IN ('r', 'p')
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
        AND relation.relowner = (SELECT owner_role.oid FROM pg_catalog.pg_roles owner_role
          WHERE owner_role.rolname = current_user)) = 6
    AND pg_catalog.has_schema_privilege(session_user, namespace.oid, 'USAGE');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'editable artifact data schema is unavailable or untrusted'
      USING ERRCODE = '42501';
  END IF;
  RETURN data_schema;
END;
$$;

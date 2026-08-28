-- deployment-mode: rolling
-- Migration 0352 activated ordered session Variable Set selections and extended
-- accepted personal-resource grants, but four runtime authorization seams
-- still consulted only the legacy final-entry `sessions.variable_set_id` alias.
-- A selected set earlier in `variable_set_ids` could therefore be accepted and
-- snapshotted correctly, then rejected during materialization or an exact agent
-- secret read. Keep every public signature, return type, grant, search path, and
-- audit behavior unchanged while switching those selection checks to the full
-- ordered session selection.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $repair_ordered_variable_set_runtime_authority$
DECLARE
  data_schema text := pg_catalog.current_schema();
  patch_record record;
  function_oid regprocedure;
  definition text;
  patched text;
  occurrences integer;
BEGIN
  FOR patch_record IN
    SELECT * FROM (VALUES
      (
        'materialize_scoped_variable_set_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid)',
        'session_value.variable_set_id = variable_set_row.id',
        'coalesce(session_value.variable_set_ids, ''[]''::jsonb) ? variable_set_row.id::text'
      ),
      (
        'read_scoped_variable_set_secret(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,integer)',
        'session_value.variable_set_id = variable_set_row.id',
        'coalesce(session_value.variable_set_ids, ''[]''::jsonb) ? variable_set_row.id::text'
      ),
      (
        'materialize_scoped_variable_set_for_session(uuid,uuid,uuid,uuid)',
        'AND session_value.variable_set_id = p_variable_set_id',
        'AND coalesce(session_value.variable_set_ids, ''[]''::jsonb) ? p_variable_set_id::text'
      ),
      (
        'authorize_session_attempt_personal_resource_reads(uuid,uuid,uuid)',
        'variable_set.id = session_value.variable_set_id',
        'coalesce(session_value.variable_set_ids, ''[]''::jsonb) ? variable_set.id::text'
      )
    ) AS patches(function_signature, old_anchor, new_anchor)
  LOOP
    function_oid := pg_catalog.to_regprocedure(
      pg_catalog.quote_ident(data_schema) || '.' || patch_record.function_signature
    );
    IF function_oid IS NULL THEN
      RAISE EXCEPTION '0370 required function is unavailable: %',
        patch_record.function_signature
        USING ERRCODE = '55000';
    END IF;

    definition := pg_catalog.pg_get_functiondef(function_oid);
    occurrences := (
      pg_catalog.length(definition)
        - pg_catalog.length(pg_catalog.replace(definition, patch_record.old_anchor, ''))
    ) / pg_catalog.length(patch_record.old_anchor);
    IF occurrences <> 1 OR pg_catalog.strpos(definition, patch_record.new_anchor) > 0 THEN
      RAISE EXCEPTION '0370 ordered Variable Set authority definition drift: %',
        patch_record.function_signature
        USING ERRCODE = '55000';
    END IF;

    patched := pg_catalog.replace(
      definition,
      patch_record.old_anchor,
      patch_record.new_anchor
    );
    IF pg_catalog.strpos(patched, patch_record.new_anchor) = 0
      OR pg_catalog.strpos(patched, patch_record.old_anchor) > 0
    THEN
      RAISE EXCEPTION '0370 ordered Variable Set authority patch failed: %',
        patch_record.function_signature
        USING ERRCODE = '55000';
    END IF;
    EXECUTE patched;
  END LOOP;
END
$repair_ordered_variable_set_runtime_authority$;
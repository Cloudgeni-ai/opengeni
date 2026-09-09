-- deployment-mode: rolling
-- 0352 extended atomic attachment acceptance (protocol 1), but ordinary causal
-- successor turns still use protocol 0's live exact-session grants. Enumerate
-- the same fixed session attachments in its count and snapshot loop. The locked
-- session's ordered variable_set_ids is the source of the 0352 attachment rows;
-- using it avoids a second RLS-scoped read of that synchronized projection. No grant,
-- owner, membership, epoch, generation, or causal-attempt fence changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

DO $session_personal_variable_set_continuations$
DECLARE
  function_oid regprocedure := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.admit_session_attempt_personal_resources()', current_schema()
  ));
  function_definition text;
  old_selection constant text := 'variable_set.id = session_row.variable_set_id';
  new_selection constant text := $selection$coalesce(session_row.variable_set_ids, '[]'::jsonb) ? variable_set.id::text$selection$;
BEGIN
  IF function_oid IS NULL THEN
    RAISE EXCEPTION '0430 requires the personal-resource admission function'
      USING ERRCODE = '55000';
  END IF;
  function_definition := pg_catalog.pg_get_functiondef(function_oid);
  -- Refuse source drift rather than silently patching only one selection.
  IF (length(function_definition) - length(replace(function_definition, old_selection, '')))
      / length(old_selection) <> 2 THEN
    RAISE EXCEPTION '0430 expected exactly two legacy Variable Set selections'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(function_definition, old_selection, new_selection);
  -- CREATE OR REPLACE preserves ownership, SECURITY DEFINER, search_path and
  -- the PUBLIC-revoked ACL. The separate protocol-0 machine trigger is untouched.
END
$session_personal_variable_set_continuations$;
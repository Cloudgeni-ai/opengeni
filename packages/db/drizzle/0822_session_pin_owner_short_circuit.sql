-- deployment-mode: rolling
-- 0805 exposed the session-reference probe to the planner. On populated pin
-- ranges it hashes every visible session before checking the existing owner
-- disjunct. Preserve that disjunct and every other policy; short-circuit only
-- its already-authorized case. WITH CHECK deliberately remains unchanged:
-- owning a stale pin never authorizes writing a pin for an invisible session.
SET LOCAL lock_timeout = '5s';

DO $pin_owner_short_circuit$
DECLARE
  data_schema text := current_schema();
  caller_search_path text := pg_catalog.current_setting('search_path');
  policy record;
  owner_suffix text := ' OR (subject_id = opengeni_private.current_subject_id()))';
BEGIN
  PERFORM pg_catalog.set_config('search_path', pg_catalog.format('%I, pg_catalog', data_schema), true);
  SELECT p.polpermissive, p.polcmd, pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual,
    pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
  INTO STRICT policy
  FROM pg_catalog.pg_policy p
  WHERE p.polrelid = pg_catalog.format('%I.session_pins', data_schema)::regclass
    AND p.polname = 'session_visibility_isolation';
  IF policy.polpermissive OR policy.polcmd <> '*' OR policy.qual IS NULL
    OR policy.check_expr IS NULL
    OR pg_catalog.right(policy.qual, pg_catalog.length(owner_suffix)) <> owner_suffix THEN
    RAISE EXCEPTION 'Unexpected session pin visibility policy' USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.format(
    'ALTER POLICY session_visibility_isolation ON %I.session_pins USING ('
      || 'CASE WHEN subject_id = opengeni_private.current_subject_id() THEN true ELSE (%s) END)',
    data_schema, policy.qual
  );
  PERFORM pg_catalog.set_config('search_path', caller_search_path, true);
END
$pin_owner_short_circuit$;

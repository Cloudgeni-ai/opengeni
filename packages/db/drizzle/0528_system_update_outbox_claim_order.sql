-- deployment-mode: rolling
-- Return claimed child-lifecycle outbox rows in the order they were claimed.
--
-- The claim selects pending rows by (created_at, id), but it returned them
-- straight from `UPDATE ... FROM claimed ... RETURNING`, whose row order is
-- whatever the join plan produces. PostgreSQL hash-joins the claimed ids
-- against a sequential scan of the outbox, so the result followed the heap,
-- and free-space reuse or any earlier row update puts an older row after a
-- newer one there. The worker reconciler delivers rows in the returned order,
-- the parent orders pending machine input by its own insert time, and a newer
-- child notice supersedes an older pending one only when it is delivered
-- after it. A backlog could therefore reach the parent reversed: sibling
-- results claimed out of completion order, or an older progress notice
-- superseding a newer one.
--
-- Only the row order changes. The returned columns are read from the installed
-- function instead of restated, so the replacement keeps exactly the row type
-- the database already has (CREATE OR REPLACE may not change it). In ledger
-- order that is the 0494 shape every current caller reads. Migration fixtures
-- that withhold 0494 run this file against the older 0234 shape and replay
-- 0494 afterwards; 0494 textually adds its column to the RETURNING list, and
-- the final `SELECT b.*` follows it. CREATE OR REPLACE keeps the owner and
-- grants; SECURITY DEFINER and the pinned search_path are restated and checked
-- below, so old and new binaries can run against either definition.
DO $outbox_claim_order$
DECLARE
  claim constant regprocedure :=
    'opengeni_private.claim_session_system_update_outbox(integer)'::regprocedure;
  outbox constant regclass :=
    format('%I.session_system_update_outbox', current_schema())::regclass;
  prior_config text[];
  prior_definer boolean;
  result_before text;
  result_after text;
  config_after text[];
  definer_after boolean;
  result_columns text;
  returning_columns text;
  column_count bigint;
  id_columns bigint;
  foreign_columns bigint;
BEGIN
  SELECT p.proconfig, p.prosecdef, pg_get_function_result(p.oid)
  INTO prior_config, prior_definer, result_before
  FROM pg_proc p
  WHERE p.oid = claim;

  -- Every returned column must be the outbox column of the same name and type,
  -- because the body returns them straight from the claimed rows.
  SELECT
    string_agg(
      format('%I %s', arg.arg_name, format_type(arg.arg_type, NULL)), ', '
      ORDER BY arg.arg_position
    ),
    string_agg(format('o.%I', arg.arg_name), ', ' ORDER BY arg.arg_position),
    count(*),
    count(*) FILTER (WHERE arg.arg_name = 'id'),
    count(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        WHERE attribute.attrelid = outbox
          AND attribute.attname = arg.arg_name
          AND attribute.atttypid = arg.arg_type
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )
    )
  INTO result_columns, returning_columns, column_count, id_columns, foreign_columns
  FROM pg_proc p
  CROSS JOIN LATERAL unnest(p.proargnames, p.proargmodes, p.proallargtypes)
    WITH ORDINALITY AS arg(arg_name, arg_mode, arg_type, arg_position)
  WHERE p.oid = claim AND arg.arg_mode = 't';

  IF NOT coalesce(prior_definer, false)
    OR column_count = 0
    OR id_columns <> 1
    OR foreign_columns <> 0 THEN
    RAISE EXCEPTION '0528 outbox claim prerequisite drift' USING ERRCODE = '55000';
  END IF;

  EXECUTE format(
    $ddl$
CREATE OR REPLACE FUNCTION opengeni_private.claim_session_system_update_outbox(p_limit integer)
RETURNS TABLE (%s)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, %I
AS $function$
BEGIN
  RETURN QUERY
    WITH claimed AS (
      SELECT o.id, o.created_at FROM session_system_update_outbox o
      WHERE o.status = 'pending'
      ORDER BY o.created_at, o.id
      FOR UPDATE SKIP LOCKED
      LIMIT greatest(1, least(coalesce(p_limit, 100), 100))
    ), bumped AS (
      UPDATE session_system_update_outbox o
      SET attempts = o.attempts + 1, updated_at = now()
      FROM claimed c WHERE o.id = c.id
      RETURNING %s
    )
    SELECT b.* FROM bumped b
    JOIN claimed c ON c.id = b.id
    ORDER BY c.created_at, c.id;
END
$function$
$ddl$,
    result_columns,
    current_schema(),
    returning_columns
  );

  SELECT p.proconfig, p.prosecdef, pg_get_function_result(p.oid)
  INTO config_after, definer_after, result_after
  FROM pg_proc p
  WHERE p.oid = claim;

  IF result_after IS DISTINCT FROM result_before
    OR config_after IS DISTINCT FROM prior_config
    OR NOT definer_after THEN
    RAISE EXCEPTION '0528 outbox claim posture drift' USING ERRCODE = '55000';
  END IF;
END
$outbox_claim_order$;

REVOKE ALL ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer) FROM PUBLIC;

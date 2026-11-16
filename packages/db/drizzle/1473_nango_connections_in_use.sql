-- deployment-mode: rolling
-- Which Nango connections any live Opengeni connection still stands for
-- (docs/nango.md, "One Nango connection per account").
--
-- One person's rows for one Nango connection can sit in several
-- organizations, and some of them are invisible to that person's own
-- reads (a suspended membership, a row without bound authority). Deleting
-- a Nango connection must not depend on what those reads happen to see.
-- opengeni_private.nango_connections_in_use_v1(ids) returns the given
-- Nango connection ids that some non-revoked Nango-backed connection row
-- names, deployment-wide. Nango connection ids are random, so the answer
-- reveals nothing about anyone else's rows.
--
-- As 0937, 0978 and 1060 explain, the previous release rejects a runtime
-- EXECUTE grant on a definer it doesn't know, so this migration grants
-- nothing. Until a later migration grants it, the runtime decides from the
-- person's own reads as before, and treats any organization it cannot fully
-- read as a reason to delete nothing.
--
-- connections forces row-level security on its owner too, and the definer
-- runs as that owner with no workspace context, so it reads through an
-- owner-only policy limited to Nango-backed rows (the runtime role never
-- matches it, as in 1153 and 1406).
--
-- Rolling: one owner-only read policy and one read-only definer the
-- previous release never calls.
SET LOCAL lock_timeout = '5s';

DO $nango_connections_in_use_read$
DECLARE
  owner_name text := current_user;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY nango_connections_in_use_read ON connections FOR SELECT TO %I '
      'USING (metadata ->> ''integrationBackend'' = ''nango'')',
    owner_name
  );
END
$nango_connections_in_use_read$;

DO $nango_connections_in_use$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.nango_connections_in_use_v1(p_nango_connection_ids text[])
    RETURNS TABLE(nango_connection_id text)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      SELECT DISTINCT connection.metadata ->> 'nangoConnectionId'
      FROM connections connection
      WHERE connection.metadata ->> 'integrationBackend' = 'nango'
        AND connection.metadata ->> 'nangoConnectionId' = ANY (p_nango_connection_ids[1:1000])
        AND connection.status <> 'revoked'
    $body$
  $definition$, data_schema);
END
$nango_connections_in_use$;

REVOKE ALL ON FUNCTION opengeni_private.nango_connections_in_use_v1(text[]) FROM PUBLIC;

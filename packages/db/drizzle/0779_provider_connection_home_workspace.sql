-- deployment-mode: rolling
-- A connected vault can be reached from workspaces other than the one its
-- provider connection was added in: an Only-me vault follows its owner into
-- every workspace they use, and an organization vault reaches every workspace
-- it is available in. The connection's token stays in the workspace it was
-- added in, so loading it needs that workspace. This routine names it, only
-- for a connection the caller may use there:
--   * a personal connection of the subject in the GUCs, while that subject is
--     an active member of the organization; or
--   * a shared (not personal) connection that an organization vault is linked
--     through.
-- Every caller reaches the vault first; this only says where its token lives.
CREATE FUNCTION provider_connection_home_workspace(p_connection uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
  SELECT connection.workspace_id
  FROM connections connection
  WHERE connection.id = p_connection
    AND connection.account_id = nullif(pg_catalog.current_setting('opengeni.account_id', true), '')::uuid
    AND connection.status <> 'revoked'
    AND (
      (connection.subject_id IS NOT NULL
        AND connection.subject_id = nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
        AND vault_actor_membership(connection.account_id, connection.subject_id) IS NOT NULL)
      OR (connection.subject_id IS NULL AND EXISTS (
        SELECT 1 FROM vaults vault
        WHERE vault.account_id = connection.account_id
          AND vault.owner_kind = 'organization'
          AND vault.provider_connection_id = connection.id))
    )
$$;

DO $home_routine$
DECLARE
  target_schema text := current_schema();
  routine regprocedure := format('%I.provider_connection_home_workspace(uuid)', target_schema)::regprocedure;
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
  EXECUTE format(
    'ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    routine, target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO opengeni_app', routine);
  END IF;
END
$home_routine$;

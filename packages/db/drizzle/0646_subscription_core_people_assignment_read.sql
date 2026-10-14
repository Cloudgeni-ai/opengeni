-- deployment-mode: rolling
-- Move designation-read capability checks behind a definer helper so the
-- runtime role never needs direct access to the private capability relation.

CREATE FUNCTION opengeni_private.subscription_people_designation_visible(
  p_account_id uuid,
  p_workspace_id uuid,
  p_connection_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, opengeni_private, pg_temp
AS $function$
  SELECT p_account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND p_workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')
    AND EXISTS (
      SELECT 1
      FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'designation_management'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.connection_id = p_connection_id
    )
$function$;

REVOKE ALL ON FUNCTION opengeni_private.subscription_people_designation_visible(uuid, uuid, uuid)
  FROM PUBLIC;
DO $grant_people_designation_visible$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_people_designation_visible(uuid, uuid, uuid)
      TO opengeni_app;
  END IF;
END
$grant_people_designation_visible$;

DROP POLICY subscription_connection_people_designation_read ON subscription_connection_people;
CREATE POLICY subscription_connection_people_designation_read
  ON subscription_connection_people FOR SELECT
  USING (opengeni_private.subscription_people_designation_visible(
    account_id,
    nullif(current_setting('opengeni.workspace_id', true), '')::uuid,
    connection_id
  ));

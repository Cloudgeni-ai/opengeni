-- deployment-mode: rolling
-- Database consistency checks for externally authenticated owning users.
-- Authentication remains in the API's dedicated external resolver proof.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- The native xAI lifecycle locks the owning membership with SELECT FOR UPDATE.
-- FORCE RLS requires an UPDATE policy for that lock in addition to SELECT.
-- Permit only the table owner's private transaction-local lifecycle capability;
-- WITH CHECK false forbids using this policy to actually rewrite a membership.
CREATE POLICY xai_subscription_membership_lock ON organization_memberships
  FOR UPDATE USING (
    current_user = pg_catalog.pg_get_userbyid(
      (SELECT relowner FROM pg_catalog.pg_class
       WHERE oid = 'organization_memberships'::regclass)
    )
    AND EXISTS (
      SELECT 1 FROM opengeni_private.xai_subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'lifecycle'
    )
  ) WITH CHECK (false);

CREATE FUNCTION opengeni_private.active_external_owning_subject(p_account_id uuid, p_subject_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$
DECLARE
  result boolean;
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  IF p_account_id IS NULL OR p_subject_id IS NULL
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN RETURN false; END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'external_identity_provisioning', true);
  SELECT EXISTS (
    SELECT 1 FROM external_identities identity_row
    JOIN organization_memberships membership
      ON membership.id = identity_row.organization_membership_id
      AND membership.account_id = identity_row.account_id
      AND membership.subject_id = identity_row.subject_id
      AND membership.personal_workspace_id = identity_row.personal_workspace_id
    WHERE identity_row.account_id = p_account_id AND identity_row.subject_id = p_subject_id
      AND identity_row.status = 'active' AND membership.status = 'active'
  ) INTO result;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
  RAISE;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.active_external_owning_subject(uuid,text) FROM PUBLIC;

DO $patch$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef('list_self_organization_memberships(text)'::regprocedure);
  anchor := 'OR p_subject_id NOT LIKE ''user:%''';
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '0418 self membership guard drift' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, anchor,
    'OR (p_subject_id NOT LIKE ''user:%'' AND NOT opengeni_private.active_external_owning_subject(opengeni_private.current_account_id(), p_subject_id))');
  anchor := 'WHERE membership.subject_id = p_subject_id;';
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '0418 self membership scope drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor,
    'WHERE membership.subject_id = p_subject_id AND (p_subject_id LIKE ''user:%'' OR membership.account_id = opengeni_private.current_account_id());');
  definition := pg_get_functiondef('open_private_session_create_capability(uuid,uuid,uuid,text)'::regprocedure);
  anchor := 'OR p_actor_subject_id NOT LIKE ''user:%''';
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1
    OR strpos(definition, 'organization_private_sessions_enabled') = 0 THEN
    RAISE EXCEPTION '0418 private create policy drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor,
    'OR (p_actor_subject_id NOT LIKE ''user:%'' AND NOT opengeni_private.active_external_owning_subject(p_account_id, p_actor_subject_id))');
END
$patch$;
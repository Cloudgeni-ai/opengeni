-- deployment-mode: rolling
-- Authenticating a request for an app's external user no longer queues behind
-- every other request of the same organization.
--
-- Each request with the external actor header ran ensure_external_identity
-- under the organization membership fence taken exclusively, so all requests
-- of one organization authenticated one at a time. A page that loads many
-- chats in parallel waited for each of them in turn: the fence is held across
-- the transaction's commit, and under load that is mostly time spent waiting
-- for the busy API process to send it.
--
-- read_external_identity reads an existing identity without locking it or
-- changing anything. The caller holds the same fence in shared mode, which
-- still orders the read against every membership lifecycle writer (they take
-- it exclusively) but not against other requests. It returns NULL when the
-- identity does not exist yet; the caller then provisions it through
-- ensure_external_identity under the exclusive fence, as before. An inactive
-- or inconsistent identity is refused exactly as ensure_external_identity
-- refuses it.
--
-- A new routine that the previous release never calls.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION read_external_identity(p_account_id uuid, p_source text, p_external_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  identity_row external_identities%ROWTYPE;
  membership_row organization_memberships%ROWTYPE;
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  IF p_account_id IS NULL OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_source IS NULL OR char_length(p_source) NOT BETWEEN 1 AND 200
    OR p_external_id IS NULL OR char_length(p_external_id) NOT BETWEEN 1 AND 1024
  THEN RAISE EXCEPTION 'invalid external identity scope' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'external_identity_provisioning', true);
  SELECT * INTO identity_row FROM external_identities
    WHERE account_id = p_account_id AND source = p_source AND external_id = p_external_id;
  IF NOT FOUND THEN
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
    RETURN NULL;
  END IF;
  SELECT * INTO membership_row FROM organization_memberships
    WHERE id = identity_row.organization_membership_id AND account_id = p_account_id;
  IF NOT FOUND OR identity_row.status <> 'active' OR membership_row.status <> 'active'
    OR membership_row.subject_id IS DISTINCT FROM identity_row.subject_id
    OR membership_row.personal_workspace_id IS DISTINCT FROM identity_row.personal_workspace_id
  THEN RAISE EXCEPTION 'external identity is unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  RETURN jsonb_build_object('id', identity_row.id, 'accountId', identity_row.account_id,
    'source', identity_row.source, 'externalId', identity_row.external_id,
    'subjectId', identity_row.subject_id, 'organizationMembershipId', identity_row.organization_membership_id,
    'personalWorkspaceId', identity_row.personal_workspace_id, 'status', identity_row.status,
    'authorizationRevision', identity_row.authorization_revision);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  RAISE;
END
$$;

REVOKE ALL ON FUNCTION read_external_identity(p_account_id uuid, p_source text, p_external_id text) FROM PUBLIC;

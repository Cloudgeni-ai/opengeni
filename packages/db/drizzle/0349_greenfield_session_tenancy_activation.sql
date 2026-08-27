-- deployment-mode: rolling
-- Automatically activates only a newly inserted self-service organization
-- after the deployment has crossed the irreversible session-tenancy boundary.
-- Existing organizations, including the explicit 0348 orphan-account adoption
-- path, remain on the drained operator inventory/parity/backfill procedure.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE session_tenancy_greenfield_activation_evidence (
  account_id uuid PRIMARY KEY
    REFERENCES session_tenancy_activations(account_id) ON DELETE RESTRICT,
  eligibility_version integer NOT NULL,
  setup_auth_user_id text NOT NULL UNIQUE
    REFERENCES self_service_organization_setup_receipts(auth_user_id) ON DELETE RESTRICT,
  setup_operation_id uuid NOT NULL UNIQUE
    REFERENCES self_service_organization_setup_receipts(operation_id) ON DELETE RESTRICT,
  setup_request_fingerprint text NOT NULL,
  personal_workspace_id uuid NOT NULL UNIQUE
    REFERENCES self_service_organization_setup_receipts(personal_workspace_id)
      ON DELETE RESTRICT,
  organization_membership_id uuid NOT NULL UNIQUE
    REFERENCES self_service_organization_setup_receipts(organization_membership_id)
      ON DELETE RESTRICT,
  boundary_witness_account_id uuid NOT NULL
    REFERENCES session_tenancy_activations(account_id) ON DELETE RESTRICT,
  boundary_witness_activated_at timestamptz NOT NULL,
  graph_evidence jsonb NOT NULL,
  graph_digest text NOT NULL,
  activation_parity_digest text NOT NULL,
  private_setting_version bigint NOT NULL,
  private_setting_event_id uuid NOT NULL UNIQUE
    REFERENCES organization_private_session_setting_events(id) ON DELETE RESTRICT,
  activated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT session_tenancy_greenfield_eligibility_version_check CHECK (
    eligibility_version = 1
  ),
  CONSTRAINT session_tenancy_greenfield_fingerprint_check CHECK (
    setup_request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT session_tenancy_greenfield_digests_check CHECK (
    graph_digest ~ '^[0-9a-f]{64}$'
    AND activation_parity_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT session_tenancy_greenfield_witness_check CHECK (
    boundary_witness_account_id <> account_id
  ),
  CONSTRAINT session_tenancy_greenfield_graph_check CHECK (
    pg_catalog.jsonb_typeof(graph_evidence) = 'object'
  ),
  CONSTRAINT session_tenancy_greenfield_setting_version_check CHECK (
    private_setting_version > 0
  )
);
ALTER TABLE session_tenancy_greenfield_activation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_tenancy_greenfield_activation_evidence FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE session_tenancy_greenfield_activation_evidence FROM PUBLIC;
CREATE POLICY session_tenancy_greenfield_activation_evidence_lifecycle
  ON session_tenancy_greenfield_activation_evidence
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'session_tenancy_greenfield_activation')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'session_tenancy_greenfield_activation');

-- The activation table is FORCE-RLS, so its owner is policy-bound in the
-- documented production posture. This value-free witness policy is open only
-- while an owner-executed SECURITY DEFINER lifecycle holds the exact marker.
-- The runtime role cannot satisfy current_user even if it forges the GUC.
DO $greenfield_activation_witness_policy$
DECLARE
  data_schema text := pg_catalog.current_schema();
  migration_owner text := current_user;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY session_tenancy_greenfield_activation_witness_read '
      || 'ON %I.session_tenancy_activations FOR SELECT USING ('
      || 'current_user = %L AND current_setting('
      || '''opengeni.organization_tenancy_lifecycle'', true) '
      || '= ''session_tenancy_greenfield_activation'')',
    data_schema, migration_owner
  );
END
$greenfield_activation_witness_policy$;

-- Repair the existing value-free deployment witness for the same real owner
-- posture. Its signature and boolean contract stay unchanged; the marker is
-- restored on every exit and grants no row projection.
CREATE OR REPLACE FUNCTION session_tenancy_any_product_activation()
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $witness$
DECLARE
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  activated boolean;
BEGIN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'session_tenancy_greenfield_activation', true
  );
  SELECT EXISTS (
    SELECT 1 FROM session_tenancy_activations
  ) INTO activated;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RETURN activated;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RAISE;
END
$witness$;
REVOKE ALL ON FUNCTION session_tenancy_any_product_activation() FROM PUBLIC;

-- Owner-only greenfield lifecycle. It is called only by the fresh INSERT
-- branch of complete_self_service_organization_setup, after the canonical
-- graph and setup receipt exist. It verifies that the account row itself was
-- inserted by this transaction and has never been updated, proving the 0348
-- adoption UPDATE cannot cross this boundary even if a future refactor moved
-- the call accidentally.
CREATE FUNCTION activate_greenfield_session_tenancy_from_setup(
  p_auth_user_id text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $activation$
DECLARE
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  actor_subject text := 'user:' || p_auth_user_id;
  setup self_service_organization_setup_receipts%ROWTYPE;
  account_row managed_accounts%ROWTYPE;
  membership organization_memberships%ROWTYPE;
  workspace workspaces%ROWTYPE;
  witness session_tenancy_activations%ROWTYPE;
  inserted_activation session_tenancy_activations%ROWTYPE;
  existing_evidence session_tenancy_greenfield_activation_evidence%ROWTYPE;
  account_inserted_in_current_transaction boolean;
  account_never_updated boolean;
  membership_count integer;
  workspace_count integer;
  workspace_control_count integer;
  workspace_membership_count integer;
  graph_evidence_value jsonb;
  graph_digest_value text;
  parity_digest_value text;
BEGIN
  IF p_auth_user_id IS NULL
    OR pg_catalog.octet_length(pg_catalog.convert_to(p_auth_user_id, 'UTF8'))
      NOT BETWEEN 1 AND 1019
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN
    RAISE EXCEPTION 'greenfield session tenancy setup authority required'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO setup
  FROM self_service_organization_setup_receipts receipt
  WHERE receipt.auth_user_id = p_auth_user_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR setup.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR setup.result ->> 'status' IS DISTINCT FROM 'complete'
    OR setup.result ->> 'organizationId' IS DISTINCT FROM setup.account_id::text
    OR setup.result ->> 'personalWorkspaceId' IS DISTINCT FROM setup.personal_workspace_id::text
    OR setup.result ->> 'workspaceId' IS DISTINCT FROM setup.personal_workspace_id::text
  THEN
    RAISE EXCEPTION 'greenfield session tenancy setup receipt is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO account_row
  FROM managed_accounts account
  WHERE account.id = setup.account_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR account_row.external_source IS DISTINCT FROM 'better-auth:user'
    OR account_row.external_id IS DISTINCT FROM p_auth_user_id
    OR account_row.name IS DISTINCT FROM setup.organization_name
  THEN
    RAISE EXCEPTION 'greenfield session tenancy requires a newly inserted account'
      USING ERRCODE = '55000';
  END IF;
  SELECT account.xmin::text::bigint
      = pg_catalog.pg_current_xact_id()::text::bigint,
    account.created_at = account.updated_at
  INTO account_inserted_in_current_transaction, account_never_updated
  FROM managed_accounts account
  WHERE account.id = setup.account_id;
  IF account_inserted_in_current_transaction IS NOT TRUE
    OR account_never_updated IS NOT TRUE
  THEN
    RAISE EXCEPTION 'greenfield session tenancy requires a newly inserted account'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO membership
  FROM organization_memberships candidate
  WHERE candidate.id = setup.organization_membership_id
    AND candidate.account_id = setup.account_id
  FOR KEY SHARE;
  SELECT count(*)::integer INTO membership_count
  FROM organization_memberships candidate
  WHERE candidate.account_id = setup.account_id;
  IF membership.id IS NULL
    OR membership_count <> 1
    OR membership.subject_id IS DISTINCT FROM actor_subject
    OR membership.role IS DISTINCT FROM 'owner'
    OR membership.status IS DISTINCT FROM 'active'
    OR membership.personal_workspace_id IS DISTINCT FROM setup.personal_workspace_id
  THEN
    RAISE EXCEPTION 'greenfield session tenancy membership graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO workspace
  FROM workspaces candidate
  WHERE candidate.id = setup.personal_workspace_id
    AND candidate.account_id = setup.account_id
  FOR KEY SHARE;
  SELECT count(*)::integer INTO workspace_count
  FROM workspaces candidate WHERE candidate.account_id = setup.account_id;
  SELECT count(*)::integer INTO workspace_control_count
  FROM workspace_inference_controls control
  WHERE control.account_id = setup.account_id
    AND control.workspace_id = setup.personal_workspace_id;
  SELECT count(*)::integer INTO workspace_membership_count
  FROM workspace_memberships candidate
  WHERE candidate.account_id = setup.account_id;
  IF workspace.id IS NULL
    OR workspace_count <> 1
    OR workspace_control_count <> 1
    OR workspace_membership_count <> 0
    OR workspace.name IS DISTINCT FROM 'Personal workspace'
    OR workspace.slug IS NOT NULL
    OR workspace.external_source IS DISTINCT FROM 'opengeni:organization-membership'
    OR workspace.external_id IS DISTINCT FROM
      setup.account_id::text || ':' || actor_subject
  THEN
    RAISE EXCEPTION 'greenfield session tenancy Personal workspace graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  graph_evidence_value := pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'kind', 'self_service_personal_only',
    'accountId', setup.account_id,
    'setupAuthUserId', setup.auth_user_id,
    'setupOperationId', setup.operation_id,
    'personalWorkspaceId', setup.personal_workspace_id,
    'organizationMembershipId', setup.organization_membership_id,
    'organizationMembershipCount', membership_count,
    'workspaceCount', workspace_count,
    'workspaceControlCount', workspace_control_count,
    'workspaceMembershipCount', workspace_membership_count
  );
  graph_digest_value := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    graph_evidence_value::text, 'UTF8'
  )), 'hex');

  -- Graph first, deployment boundary last. Operator activation takes every
  -- source-table lock before this same fence, so either setup commits before
  -- the first witness or it waits and observes the committed witness.
  PERFORM lock_session_tenancy_activation_boundary();
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'session_tenancy_greenfield_activation', true
  );

  SELECT * INTO existing_evidence
  FROM session_tenancy_greenfield_activation_evidence evidence
  WHERE evidence.account_id = setup.account_id;
  IF FOUND THEN
    IF existing_evidence.setup_auth_user_id IS DISTINCT FROM setup.auth_user_id
      OR existing_evidence.setup_operation_id IS DISTINCT FROM setup.operation_id
      OR existing_evidence.setup_request_fingerprint IS DISTINCT FROM
        setup.request_fingerprint
      OR existing_evidence.personal_workspace_id IS DISTINCT FROM
        setup.personal_workspace_id
      OR existing_evidence.organization_membership_id IS DISTINCT FROM
        setup.organization_membership_id
      OR existing_evidence.graph_digest IS DISTINCT FROM graph_digest_value
    THEN
      RAISE EXCEPTION 'greenfield session tenancy evidence conflicts with durable setup'
        USING ERRCODE = '23505';
    END IF;
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
    RETURN true;
  END IF;

  SELECT * INTO witness
  FROM session_tenancy_activations activation
  WHERE activation.account_id <> setup.account_id
  ORDER BY activation.activated_at, activation.account_id
  LIMIT 1;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM session_tenancy_activations activation
    WHERE activation.account_id = setup.account_id
  ) OR EXISTS (
    SELECT 1 FROM organization_private_session_settings setting
    WHERE setting.account_id = setup.account_id
  ) THEN
    RAISE EXCEPTION 'greenfield session tenancy authority already exists without evidence'
      USING ERRCODE = '55000';
  END IF;

  parity_digest_value := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'graphDigest', graph_digest_value,
      'boundaryWitnessAccountId', witness.account_id,
      'boundaryWitnessActivatedAt', witness.activated_at
    )::text,
    'UTF8'
  )), 'hex');

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'session_tenancy_activation', true
  );
  INSERT INTO session_tenancy_activations (
    account_id, activation_version, inventory_digest, parity_digest,
    activated_by, backfill_receipt_ids
  ) VALUES (
    setup.account_id, 1, graph_digest_value, parity_digest_value,
    'opengeni:greenfield-organization-setup:v1', ARRAY[]::uuid[]
  ) RETURNING * INTO inserted_activation;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_private_session_settings', true
  );
  INSERT INTO organization_private_session_settings (
    account_id, enabled, version, updated_by_membership_id, updated_at
  ) VALUES (
    setup.account_id, true, 1, setup.organization_membership_id,
    inserted_activation.activated_at
  );
  INSERT INTO organization_private_session_setting_events (
    id, account_id, actor_membership_id, requested_enabled,
    expected_version, result_enabled, result_version, result_updated_at, changed
  ) VALUES (
    setup.operation_id, setup.account_id, setup.organization_membership_id, true,
    0, true, 1, inserted_activation.activated_at, true
  );

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'session_tenancy_greenfield_activation', true
  );
  INSERT INTO session_tenancy_greenfield_activation_evidence (
    account_id, eligibility_version, setup_auth_user_id, setup_operation_id,
    setup_request_fingerprint, personal_workspace_id,
    organization_membership_id, boundary_witness_account_id,
    boundary_witness_activated_at, graph_evidence, graph_digest,
    activation_parity_digest, private_setting_version,
    private_setting_event_id, activated_at
  ) VALUES (
    setup.account_id, 1, setup.auth_user_id, setup.operation_id,
    setup.request_fingerprint, setup.personal_workspace_id,
    setup.organization_membership_id, witness.account_id,
    witness.activated_at, graph_evidence_value, graph_digest_value,
    parity_digest_value, 1, setup.operation_id, inserted_activation.activated_at
  );

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RAISE;
END
$activation$;
REVOKE ALL ON FUNCTION activate_greenfield_session_tenancy_from_setup(text) FROM PUBLIC;

-- Both private-create membership readers predate the real migration-owner
-- harness and were silently blind on organization_memberships under FORCE RLS.
-- Open an owner-only, tenant-and-subject-fenced read/row-lock window so the
-- newly activated Personal workspace is usable immediately in production,
-- not only in superuser-backed tests. The exact marker is restored by both
-- SECURITY DEFINER routines before returning or raising.
DO $private_create_membership_policies$
DECLARE
  data_schema text := pg_catalog.current_schema();
  migration_owner text := current_user;
  marker text :=
    'current_user = ' || pg_catalog.quote_literal(migration_owner)
      || ' AND current_setting(''opengeni.organization_tenancy_lifecycle'', true) '
      || '= ''private_session_create_authority'' AND account_id = nullif('
      || 'current_setting(''opengeni.account_id'', true), '''')::uuid '
      || 'AND subject_id = opengeni_private.current_subject_id()';
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY private_session_create_membership_read '
      || 'ON %I.organization_memberships FOR SELECT USING (%s)',
    data_schema, marker
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY private_session_create_membership_lock '
      || 'ON %I.organization_memberships FOR UPDATE USING (%s)',
    data_schema, marker
  );
END
$private_create_membership_policies$;

CREATE OR REPLACE FUNCTION get_private_session_create_policy(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text
) RETURNS TABLE (
  personal_workspace boolean,
  platform_available boolean,
  organization_enabled boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $policy$
DECLARE
  actor organization_memberships%ROWTYPE;
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_actor_subject_id IS NULL
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'private session create policy authority required'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'private_session_create_authority', true
  );
  SELECT membership.* INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active';
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  ) OR NOT (
    actor.personal_workspace_id = p_workspace_id
    OR EXISTS (
      SELECT 1 FROM workspace_memberships access
      WHERE access.account_id = p_account_id
        AND access.workspace_id = p_workspace_id
        AND access.subject_id = p_actor_subject_id
    )
  ) THEN
    RAISE EXCEPTION 'private session create policy authority required'
      USING ERRCODE = '42501';
  END IF;
  personal_workspace := actor.personal_workspace_id = p_workspace_id;
  platform_available := session_tenancy_product_activated(p_account_id, 1);
  organization_enabled := organization_private_sessions_enabled(p_account_id);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RAISE;
END
$policy$;
REVOKE ALL ON FUNCTION get_private_session_create_policy(uuid,uuid,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION open_private_session_create_capability(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_actor_subject_id text
) RETURNS TABLE (capability_id uuid, owner_membership_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $private_create$
DECLARE
  new_capability_id uuid := pg_catalog.gen_random_uuid();
  actor_membership_id uuid;
  actor_personal_workspace boolean;
  workspace_access_id uuid;
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_session_id IS NULL
    OR p_actor_subject_id IS NULL OR p_actor_subject_id NOT LIKE 'user:%'
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR NOT session_tenancy_product_activated(p_account_id, 1)
  THEN
    RAISE EXCEPTION 'private session create authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));
  PERFORM 1 FROM workspace_inference_controls control
  WHERE control.account_id = p_account_id AND control.workspace_id = p_workspace_id
  FOR SHARE;
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  FOR KEY SHARE;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'private_session_create_authority', true
  );
  SELECT membership.id, membership.personal_workspace_id = p_workspace_id
  INTO actor_membership_id, actor_personal_workspace
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'private session create authority required' USING ERRCODE = '42501';
  END IF;
  IF NOT actor_personal_workspace THEN
    SELECT access.id INTO workspace_access_id
    FROM workspace_memberships access
    WHERE access.account_id = p_account_id
      AND access.workspace_id = p_workspace_id
      AND access.subject_id = p_actor_subject_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'private session create authority required' USING ERRCODE = '42501';
    END IF;
    IF NOT organization_private_sessions_enabled(p_account_id) THEN
      RAISE EXCEPTION
        'private sessions are not enabled for this organization''s shared workspaces'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.private_session_create_lifecycle', 'private_session_create', true
  );
  INSERT INTO private_session_create_capabilities (
    backend_pid, transaction_id, capability_id, account_id, workspace_id,
    session_id, actor_subject_id, owner_membership_id
  ) VALUES (
    pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(),
    new_capability_id, p_account_id, p_workspace_id, p_session_id,
    p_actor_subject_id, actor_membership_id
  );
  PERFORM pg_catalog.set_config(
    'opengeni.private_session_create_capability', new_capability_id::text, true
  );
  capability_id := new_capability_id;
  owner_membership_id := actor_membership_id;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RAISE;
END
$private_create$;
REVOKE ALL ON FUNCTION open_private_session_create_capability(uuid,uuid,uuid,text) FROM PUBLIC;

-- Replace only the 0348 setup lifecycle body so the greenfield call is inside
-- the same transaction. The adopted-account branch remains byte-for-byte
-- semantically identical and never invokes the lifecycle.
CREATE OR REPLACE FUNCTION complete_self_service_organization_setup(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  auth_user_id_value text := p_command ->> 'authUserId';
  actor_subject text := p_command ->> 'actorSubjectId';
  organization_name_value text := nullif(btrim(p_command ->> 'organizationName'), '');
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  fingerprint_value text := p_command ->> 'requestFingerprint';
  auth_user auth_users%ROWTYPE;
  account_row managed_accounts%ROWTYPE;
  existing_receipt self_service_organization_setup_receipts%ROWTYPE;
  adopted_account managed_accounts%ROWTYPE;
  adopt_existing_account boolean := false;
  account_id_value uuid := gen_random_uuid();
  workspace_id_value uuid := gen_random_uuid();
  membership_id_value uuid;
  existing_membership_count integer;
  public_result jsonb;
BEGIN
  IF auth_user_id_value IS NULL
    OR octet_length(convert_to(auth_user_id_value, 'UTF8')) NOT BETWEEN 1 AND 1019
    OR actor_subject IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR actor_subject IS DISTINCT FROM 'user:' || auth_user_id_value
    OR organization_name_value IS NULL
    OR octet_length(convert_to(organization_name_value, 'UTF8')) NOT BETWEEN 1 AND 120
    OR operation_id_value IS NULL
    OR fingerprint_value !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'self-service organization setup input is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('self-service-organization:' || auth_user_id_value, 0)
  );
  SELECT * INTO auth_user FROM auth_users candidate
  WHERE candidate.id = auth_user_id_value FOR UPDATE;
  IF NOT FOUND
    OR auth_user.email_verified IS NOT TRUE
    OR lower(btrim(auth_user.email)) = ''
  THEN
    RAISE EXCEPTION 'verified managed user required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  PERFORM bind_pending_organization_invitations_for_verified_email(
    actor_subject, auth_user.email
  );

  SELECT * INTO existing_receipt
  FROM self_service_organization_setup_receipts receipt
  WHERE receipt.auth_user_id = auth_user_id_value
  FOR UPDATE;
  IF FOUND THEN
    IF existing_receipt.operation_id IS DISTINCT FROM operation_id_value
      OR existing_receipt.request_fingerprint IS DISTINCT FROM fingerprint_value
      OR existing_receipt.organization_name IS DISTINCT FROM organization_name_value
    THEN
      RAISE EXCEPTION 'self-service organization setup was already completed'
        USING ERRCODE = '23505';
    END IF;
    RETURN existing_receipt.result;
  END IF;

  SELECT count(*)::integer INTO existing_membership_count
  FROM organization_memberships membership
  WHERE membership.subject_id = actor_subject;
  IF existing_membership_count <> 0
    OR has_pending_organization_invitation_for_subject(actor_subject)
  THEN
    RAISE EXCEPTION 'organization setup is no longer available'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO adopted_account FROM managed_accounts account
  WHERE account.external_source = 'better-auth:user'
    AND account.external_id = auth_user_id_value;
  IF FOUND THEN
    IF EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.account_id = adopted_account.id
    ) THEN
      RAISE EXCEPTION 'organization setup is no longer available'
        USING ERRCODE = '55000';
    END IF;
    account_id_value := adopted_account.id;
    adopt_existing_account := true;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-membership:' || account_id_value::text, 0)
  );
  IF NOT adopt_existing_account THEN
    INSERT INTO managed_accounts (id, name, external_source, external_id)
    VALUES (
      account_id_value, organization_name_value,
      'better-auth:user', auth_user_id_value
    ) RETURNING * INTO account_row;
  END IF;
  PERFORM pg_catalog.set_config('opengeni.account_id', account_id_value::text, true);
  PERFORM pg_catalog.set_config('opengeni.workspace_id', workspace_id_value::text, true);

  INSERT INTO workspaces (
    id, account_id, name, slug, external_source, external_id
  ) VALUES (
    workspace_id_value, account_id_value, 'Personal workspace', NULL,
    'opengeni:organization-membership', account_id_value::text || ':' || actor_subject
  );
  INSERT INTO workspace_inference_controls (workspace_id, account_id)
  VALUES (workspace_id_value, account_id_value);
  INSERT INTO organization_memberships (
    account_id, subject_id, role, status, personal_workspace_id
  ) VALUES (
    account_id_value, actor_subject, 'owner', 'active', workspace_id_value
  ) RETURNING id INTO membership_id_value;

  IF adopt_existing_account THEN
    UPDATE managed_accounts SET
      name = organization_name_value,
      updated_at = pg_catalog.clock_timestamp()
    WHERE id = account_id_value
    RETURNING * INTO account_row;
  END IF;

  public_result := pg_catalog.jsonb_build_object(
    'status', 'complete',
    'organizationId', account_id_value,
    'personalWorkspaceId', workspace_id_value,
    'organization', pg_catalog.jsonb_build_object(
      'id', account_row.id,
      'name', account_row.name,
      'createdAt', account_row.created_at,
      'updatedAt', account_row.updated_at
    ),
    'workspaceId', workspace_id_value
  );
  INSERT INTO self_service_organization_setup_receipts (
    auth_user_id, operation_id, request_fingerprint, account_id,
    personal_workspace_id, organization_membership_id,
    organization_name, result
  ) VALUES (
    auth_user_id_value, operation_id_value, fingerprint_value, account_id_value,
    workspace_id_value, membership_id_value, organization_name_value, public_result
  );

  IF NOT adopt_existing_account THEN
    PERFORM activate_greenfield_session_tenancy_from_setup(auth_user_id_value);
  END IF;
  RETURN public_result;
END
$body$;

DO $posture$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.session_tenancy_any_product_activation() '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.activate_greenfield_session_tenancy_from_setup(text) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.complete_self_service_organization_setup(jsonb) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.get_private_session_create_policy(uuid,uuid,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.open_private_session_create_capability(uuid,uuid,uuid,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END
$posture$;

DO $runtime_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON TABLE session_tenancy_greenfield_activation_evidence
      FROM opengeni_app;
    REVOKE ALL ON FUNCTION activate_greenfield_session_tenancy_from_setup(text)
      FROM opengeni_app;
  END IF;
END
$runtime_acl$;

COMMENT ON TABLE session_tenancy_greenfield_activation_evidence IS
  'Immutable exact-setup, Personal-only graph, boundary-witness, private-setting, and v1 activation evidence for eligible newly inserted organizations.';
COMMENT ON FUNCTION activate_greenfield_session_tenancy_from_setup(text) IS
  'Owner-only atomic greenfield activation lifecycle; existing and adopted accounts remain operator-activated.';

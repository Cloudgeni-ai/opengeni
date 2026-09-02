-- deployment-mode: rolling
-- Migration 0399 follows organization workspace management activation.
-- Lets an already-onboarded, verified managed human create another independent
-- organization. One transaction creates the organization, its Personal
-- workspace, its first shared workspace, and both access anchors. The original
-- first-sign-in setup remains a separate one-shot lifecycle so invitations and
-- legacy-account adoption keep their existing precedence and semantics.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE additional_organization_creation_receipts (
  operation_id uuid PRIMARY KEY,
  actor_subject_id text NOT NULL,
  account_id uuid NOT NULL UNIQUE
    REFERENCES managed_accounts(id) ON DELETE RESTRICT,
  organization_membership_id uuid NOT NULL UNIQUE
    REFERENCES organization_memberships(id) ON DELETE RESTRICT,
  personal_workspace_id uuid NOT NULL UNIQUE
    REFERENCES workspaces(id) ON DELETE RESTRICT,
  shared_workspace_id uuid NOT NULL UNIQUE
    REFERENCES workspaces(id) ON DELETE RESTRICT,
  organization_name text NOT NULL,
  workspace_name text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT additional_organization_creation_actor_check CHECK (
    actor_subject_id LIKE 'user:%'
    AND octet_length(convert_to(actor_subject_id, 'UTF8')) BETWEEN 6 AND 1024
  ),
  CONSTRAINT additional_organization_creation_names_check CHECK (
    organization_name = btrim(organization_name)
    AND char_length(organization_name) BETWEEN 1 AND 120
    AND octet_length(convert_to(organization_name, 'UTF8')) BETWEEN 1 AND 480
    AND workspace_name = btrim(workspace_name)
    AND char_length(workspace_name) BETWEEN 1 AND 120
    AND octet_length(convert_to(workspace_name, 'UTF8')) BETWEEN 1 AND 480
  ),
  CONSTRAINT additional_organization_creation_distinct_workspaces_check CHECK (
    personal_workspace_id <> shared_workspace_id
  ),
  CONSTRAINT additional_organization_creation_result_check CHECK (
    jsonb_typeof(result) = 'object'
  )
);
ALTER TABLE additional_organization_creation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE additional_organization_creation_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE additional_organization_creation_receipts FROM PUBLIC;
CREATE POLICY additional_organization_creation_lifecycle
  ON additional_organization_creation_receipts
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'additional_organization_creation')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'additional_organization_creation');

CREATE TRIGGER additional_organization_creation_receipts_immutable
  BEFORE UPDATE OR DELETE ON additional_organization_creation_receipts
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();

CREATE TABLE session_tenancy_additional_organization_activation_evidence (
  account_id uuid PRIMARY KEY
    REFERENCES session_tenancy_activations(account_id) ON DELETE RESTRICT,
  eligibility_version integer NOT NULL,
  creation_operation_id uuid NOT NULL UNIQUE
    REFERENCES additional_organization_creation_receipts(operation_id) ON DELETE RESTRICT,
  actor_subject_id text NOT NULL,
  personal_workspace_id uuid NOT NULL UNIQUE,
  shared_workspace_id uuid NOT NULL UNIQUE,
  organization_membership_id uuid NOT NULL UNIQUE,
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
  CONSTRAINT session_tenancy_additional_organization_eligibility_check CHECK (
    eligibility_version = 1
  ),
  CONSTRAINT session_tenancy_additional_organization_actor_check CHECK (
    actor_subject_id LIKE 'user:%'
  ),
  CONSTRAINT session_tenancy_additional_organization_workspaces_check CHECK (
    personal_workspace_id <> shared_workspace_id
  ),
  CONSTRAINT session_tenancy_additional_organization_digests_check CHECK (
    graph_digest ~ '^[0-9a-f]{64}$'
    AND activation_parity_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT session_tenancy_additional_organization_witness_check CHECK (
    boundary_witness_account_id <> account_id
  ),
  CONSTRAINT session_tenancy_additional_organization_graph_check CHECK (
    jsonb_typeof(graph_evidence) = 'object'
  ),
  CONSTRAINT session_tenancy_additional_organization_setting_version_check CHECK (
    private_setting_version > 0
  ),
  CONSTRAINT session_tenancy_additional_organization_personal_workspace_fk
    FOREIGN KEY (personal_workspace_id)
    REFERENCES additional_organization_creation_receipts(personal_workspace_id)
      ON DELETE RESTRICT,
  CONSTRAINT session_tenancy_additional_organization_shared_workspace_fk
    FOREIGN KEY (shared_workspace_id)
    REFERENCES additional_organization_creation_receipts(shared_workspace_id)
      ON DELETE RESTRICT,
  CONSTRAINT session_tenancy_additional_organization_membership_fk
    FOREIGN KEY (organization_membership_id)
    REFERENCES additional_organization_creation_receipts(organization_membership_id)
      ON DELETE RESTRICT
);
ALTER TABLE session_tenancy_additional_organization_activation_evidence
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_tenancy_additional_organization_activation_evidence
  FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE session_tenancy_additional_organization_activation_evidence FROM PUBLIC;
CREATE POLICY session_tenancy_additional_organization_activation_lifecycle
  ON session_tenancy_additional_organization_activation_evidence
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'session_tenancy_greenfield_activation')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'session_tenancy_greenfield_activation');

CREATE FUNCTION activate_session_tenancy_from_additional_organization(
  p_operation_id uuid
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $activation$
DECLARE
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  creation additional_organization_creation_receipts%ROWTYPE;
  account_row managed_accounts%ROWTYPE;
  organization_membership organization_memberships%ROWTYPE;
  personal_workspace workspaces%ROWTYPE;
  shared_workspace workspaces%ROWTYPE;
  shared_access workspace_memberships%ROWTYPE;
  witness session_tenancy_activations%ROWTYPE;
  inserted_activation session_tenancy_activations%ROWTYPE;
  existing_evidence session_tenancy_additional_organization_activation_evidence%ROWTYPE;
  account_inserted_in_current_transaction boolean;
  account_never_updated boolean;
  organization_membership_count integer;
  workspace_count integer;
  workspace_control_count integer;
  personal_workspace_control_count integer;
  shared_workspace_control_count integer;
  workspace_membership_count integer;
  graph_evidence_value jsonb;
  graph_digest_value text;
  parity_digest_value text;
  private_setting_event_id_value uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'additional organization activation operation is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO creation
  FROM additional_organization_creation_receipts receipt
  WHERE receipt.operation_id = p_operation_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR creation.actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR creation.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR creation.result ->> 'organizationId' IS DISTINCT FROM creation.account_id::text
    OR creation.result ->> 'personalWorkspaceId'
      IS DISTINCT FROM creation.personal_workspace_id::text
    OR creation.result ->> 'workspaceId' IS DISTINCT FROM creation.shared_workspace_id::text
  THEN
    RAISE EXCEPTION 'additional organization activation receipt is invalid'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );

  SELECT * INTO account_row
  FROM managed_accounts account
  WHERE account.id = creation.account_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR account_row.external_source IS DISTINCT FROM 'opengeni:additional-organization'
    OR account_row.external_id IS DISTINCT FROM creation.operation_id::text
    OR account_row.name IS DISTINCT FROM creation.organization_name
  THEN
    RAISE EXCEPTION 'additional organization activation requires its exact new account'
      USING ERRCODE = '55000';
  END IF;
  SELECT
    account.xmin::text::bigint = pg_catalog.pg_current_xact_id()::text::bigint,
    account.created_at = account.updated_at
  INTO account_inserted_in_current_transaction, account_never_updated
  FROM managed_accounts account
  WHERE account.id = creation.account_id;
  IF account_inserted_in_current_transaction IS NOT TRUE
    OR account_never_updated IS NOT TRUE
  THEN
    RAISE EXCEPTION 'additional organization activation requires a newly inserted account'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO organization_membership
  FROM organization_memberships membership
  WHERE membership.id = creation.organization_membership_id
    AND membership.account_id = creation.account_id
  FOR KEY SHARE;
  SELECT count(*)::integer INTO organization_membership_count
  FROM organization_memberships membership
  WHERE membership.account_id = creation.account_id;
  IF organization_membership.id IS NULL
    OR organization_membership_count <> 1
    OR organization_membership.subject_id IS DISTINCT FROM creation.actor_subject_id
    OR organization_membership.role IS DISTINCT FROM 'owner'
    OR organization_membership.status IS DISTINCT FROM 'active'
    OR organization_membership.personal_workspace_id
      IS DISTINCT FROM creation.personal_workspace_id
  THEN
    RAISE EXCEPTION 'additional organization membership graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', creation.personal_workspace_id::text, true
  );
  SELECT * INTO personal_workspace
  FROM workspaces workspace
  WHERE workspace.id = creation.personal_workspace_id
    AND workspace.account_id = creation.account_id
  FOR KEY SHARE;
  SELECT count(*)::integer INTO personal_workspace_control_count
  FROM workspace_inference_controls control
  WHERE control.account_id = creation.account_id
    AND control.workspace_id = creation.personal_workspace_id;

  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', creation.shared_workspace_id::text, true
  );
  SELECT * INTO shared_workspace
  FROM workspaces workspace
  WHERE workspace.id = creation.shared_workspace_id
    AND workspace.account_id = creation.account_id
  FOR KEY SHARE;
  SELECT count(*)::integer INTO workspace_count
  FROM workspaces workspace WHERE workspace.account_id = creation.account_id;
  SELECT count(*)::integer INTO shared_workspace_control_count
  FROM workspace_inference_controls control
  WHERE control.account_id = creation.account_id
    AND control.workspace_id = creation.shared_workspace_id;
  workspace_control_count :=
    personal_workspace_control_count + shared_workspace_control_count;
  SELECT count(*)::integer INTO workspace_membership_count
  FROM workspace_memberships membership
  WHERE membership.account_id = creation.account_id;
  SELECT * INTO shared_access
  FROM workspace_memberships membership
  WHERE membership.account_id = creation.account_id
    AND membership.workspace_id = creation.shared_workspace_id
    AND membership.subject_id = creation.actor_subject_id
  FOR KEY SHARE;
  IF personal_workspace.id IS NULL
    OR shared_workspace.id IS NULL
    OR shared_access.id IS NULL
    OR workspace_count <> 2
    OR workspace_control_count <> 2
    OR workspace_membership_count <> 1
    OR personal_workspace.name IS DISTINCT FROM 'Personal workspace'
    OR personal_workspace.slug IS NOT NULL
    OR personal_workspace.external_source IS DISTINCT FROM
      'opengeni:organization-membership'
    OR personal_workspace.external_id IS DISTINCT FROM
      creation.account_id::text || ':' || creation.actor_subject_id
    OR shared_workspace.name IS DISTINCT FROM creation.workspace_name
    OR shared_workspace.slug IS NOT NULL
    OR shared_workspace.external_source IS DISTINCT FROM
      'opengeni:additional-organization-default'
    OR shared_workspace.external_id IS DISTINCT FROM creation.account_id::text
    OR shared_access.role IS DISTINCT FROM 'admin'
    OR shared_access.permissions IS DISTINCT FROM
      opengeni_private.workspace_member_role_permissions('admin')
  THEN
    RAISE EXCEPTION 'additional organization workspace graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  graph_evidence_value := pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'kind', 'additional_organization_with_first_shared_workspace',
    'accountId', creation.account_id,
    'operationId', creation.operation_id,
    'actorSubjectId', creation.actor_subject_id,
    'organizationMembershipId', creation.organization_membership_id,
    'personalWorkspaceId', creation.personal_workspace_id,
    'sharedWorkspaceId', creation.shared_workspace_id,
    'organizationMembershipCount', organization_membership_count,
    'workspaceCount', workspace_count,
    'workspaceControlCount', workspace_control_count,
    'workspaceMembershipCount', workspace_membership_count
  );
  graph_digest_value := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    graph_evidence_value::text, 'UTF8'
  )), 'hex');

  -- The exact graph is locked before the same deployment-wide fence used by
  -- operator and first-signup activation. A creation that wins the fence stays
  -- operator-managed; one after the first product witness activates atomically.
  PERFORM lock_session_tenancy_activation_boundary();
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'session_tenancy_greenfield_activation', true
  );

  SELECT * INTO existing_evidence
  FROM session_tenancy_additional_organization_activation_evidence evidence
  WHERE evidence.account_id = creation.account_id;
  IF FOUND THEN
    IF existing_evidence.creation_operation_id IS DISTINCT FROM creation.operation_id
      OR existing_evidence.actor_subject_id IS DISTINCT FROM creation.actor_subject_id
      OR existing_evidence.personal_workspace_id IS DISTINCT FROM creation.personal_workspace_id
      OR existing_evidence.shared_workspace_id IS DISTINCT FROM creation.shared_workspace_id
      OR existing_evidence.organization_membership_id
        IS DISTINCT FROM creation.organization_membership_id
      OR existing_evidence.graph_digest IS DISTINCT FROM graph_digest_value
    THEN
      RAISE EXCEPTION 'additional organization activation evidence conflicts with creation'
        USING ERRCODE = '23505';
    END IF;
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
    RETURN true;
  END IF;

  SELECT * INTO witness
  FROM session_tenancy_activations activation
  WHERE activation.account_id <> creation.account_id
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
    WHERE activation.account_id = creation.account_id
  ) OR EXISTS (
    SELECT 1 FROM organization_private_session_settings setting
    WHERE setting.account_id = creation.account_id
  ) THEN
    RAISE EXCEPTION 'additional organization session tenancy already exists without evidence'
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
    creation.account_id, 1, graph_digest_value, parity_digest_value,
    'opengeni:additional-organization-creation:v1', ARRAY[]::uuid[]
  ) RETURNING * INTO inserted_activation;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_private_session_settings', true
  );
  INSERT INTO organization_private_session_settings (
    account_id, enabled, version, updated_by_membership_id, updated_at
  ) VALUES (
    creation.account_id, true, 1, creation.organization_membership_id,
    inserted_activation.activated_at
  );
  INSERT INTO organization_private_session_setting_events (
    id, account_id, actor_membership_id, requested_enabled,
    expected_version, result_enabled, result_version, result_updated_at, changed
  ) VALUES (
    private_setting_event_id_value, creation.account_id,
    creation.organization_membership_id, true, 0, true, 1,
    inserted_activation.activated_at, true
  );

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'session_tenancy_greenfield_activation', true
  );
  INSERT INTO session_tenancy_additional_organization_activation_evidence (
    account_id, eligibility_version, creation_operation_id, actor_subject_id,
    personal_workspace_id, shared_workspace_id, organization_membership_id,
    boundary_witness_account_id, boundary_witness_activated_at,
    graph_evidence, graph_digest, activation_parity_digest,
    private_setting_version, private_setting_event_id, activated_at
  ) VALUES (
    creation.account_id, 1, creation.operation_id, creation.actor_subject_id,
    creation.personal_workspace_id, creation.shared_workspace_id,
    creation.organization_membership_id, witness.account_id, witness.activated_at,
    graph_evidence_value, graph_digest_value, parity_digest_value,
    1, private_setting_event_id_value, inserted_activation.activated_at
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
REVOKE ALL ON FUNCTION activate_session_tenancy_from_additional_organization(uuid)
  FROM PUBLIC;

CREATE FUNCTION create_additional_managed_organization(
  p_subject_id text,
  p_subject_label text,
  p_organization_name text,
  p_workspace_name text,
  p_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $creation$
DECLARE
  auth_user_id_value text := substring(p_subject_id from length('user:') + 1);
  organization_name_value text := nullif(pg_catalog.btrim(p_organization_name), '');
  workspace_name_value text := nullif(pg_catalog.btrim(p_workspace_name), '');
  subject_label_value text := nullif(pg_catalog.btrim(p_subject_label), '');
  auth_user auth_users%ROWTYPE;
  prior additional_organization_creation_receipts%ROWTYPE;
  account_row managed_accounts%ROWTYPE;
  organization_membership organization_memberships%ROWTYPE;
  personal_workspace workspaces%ROWTYPE;
  shared_workspace workspaces%ROWTYPE;
  public_result jsonb;
BEGIN
  IF p_subject_id IS NULL
    OR p_subject_id NOT LIKE 'user:%'
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR pg_catalog.octet_length(pg_catalog.convert_to(p_subject_id, 'UTF8'))
      NOT BETWEEN 6 AND 1024
    OR organization_name_value IS NULL
    OR pg_catalog.char_length(organization_name_value) > 120
    OR pg_catalog.octet_length(pg_catalog.convert_to(organization_name_value, 'UTF8')) > 480
    OR workspace_name_value IS NULL
    OR pg_catalog.char_length(workspace_name_value) > 120
    OR pg_catalog.octet_length(pg_catalog.convert_to(workspace_name_value, 'UTF8')) > 480
    OR (subject_label_value IS NOT NULL AND
      pg_catalog.octet_length(pg_catalog.convert_to(subject_label_value, 'UTF8')) > 1024)
    OR p_operation_id IS NULL
  THEN
    RAISE EXCEPTION 'additional organization creation input is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO auth_user
  FROM auth_users candidate
  WHERE candidate.id = auth_user_id_value
  FOR KEY SHARE;
  IF NOT FOUND OR auth_user.email_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'verified managed user required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.subject_id = p_subject_id
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION 'initial organization setup must be completed first'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'additional-organization-creation:' || p_operation_id::text, 0
  ));
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'additional_organization_creation', true
  );
  SELECT * INTO prior
  FROM additional_organization_creation_receipts receipt
  WHERE receipt.operation_id = p_operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF prior.actor_subject_id IS DISTINCT FROM p_subject_id
      OR prior.organization_name IS DISTINCT FROM organization_name_value
      OR prior.workspace_name IS DISTINCT FROM workspace_name_value
    THEN
      RAISE EXCEPTION 'additional organization operation key was reused'
        USING ERRCODE = '23505';
    END IF;
    RETURN prior.result;
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );

  INSERT INTO managed_accounts (name, external_source, external_id)
  VALUES (
    organization_name_value,
    'opengeni:additional-organization',
    p_operation_id::text
  ) RETURNING * INTO account_row;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'organization-membership:' || account_row.id::text, 0
    )
  );
  PERFORM pg_catalog.set_config('opengeni.account_id', account_row.id::text, true);

  personal_workspace.id := pg_catalog.gen_random_uuid();
  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', personal_workspace.id::text, true
  );
  INSERT INTO workspaces (
    id, account_id, name, slug, external_source, external_id
  ) VALUES (
    personal_workspace.id, account_row.id, 'Personal workspace', NULL,
    'opengeni:organization-membership',
    account_row.id::text || ':' || p_subject_id
  ) RETURNING * INTO personal_workspace;
  INSERT INTO workspace_inference_controls (workspace_id, account_id)
  VALUES (personal_workspace.id, account_row.id);

  INSERT INTO organization_memberships (
    account_id, subject_id, role, status, personal_workspace_id
  ) VALUES (
    account_row.id, p_subject_id, 'owner', 'active', personal_workspace.id
  ) RETURNING * INTO organization_membership;

  shared_workspace.id := pg_catalog.gen_random_uuid();
  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', shared_workspace.id::text, true
  );
  INSERT INTO workspaces (
    id, account_id, name, slug, external_source, external_id
  ) VALUES (
    shared_workspace.id, account_row.id, workspace_name_value, NULL,
    'opengeni:additional-organization-default', account_row.id::text
  ) RETURNING * INTO shared_workspace;
  INSERT INTO workspace_inference_controls (workspace_id, account_id)
  VALUES (shared_workspace.id, account_row.id);
  INSERT INTO workspace_memberships (
    account_id, workspace_id, subject_id, subject_label, role, permissions
  ) VALUES (
    account_row.id, shared_workspace.id, p_subject_id, subject_label_value,
    'admin', opengeni_private.workspace_member_role_permissions('admin')
  );

  public_result := pg_catalog.jsonb_build_object(
    'organizationId', account_row.id,
    'organization', pg_catalog.jsonb_build_object(
      'id', account_row.id,
      'name', account_row.name,
      'createdAt', account_row.created_at,
      'updatedAt', account_row.updated_at
    ),
    'workspaceId', shared_workspace.id,
    'personalWorkspaceId', personal_workspace.id
  );
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'additional_organization_creation', true
  );
  INSERT INTO additional_organization_creation_receipts (
    operation_id, actor_subject_id, account_id, organization_membership_id,
    personal_workspace_id, shared_workspace_id, organization_name,
    workspace_name, result
  ) VALUES (
    p_operation_id, p_subject_id, account_row.id, organization_membership.id,
    personal_workspace.id, shared_workspace.id, organization_name_value,
    workspace_name_value, public_result
  );

  PERFORM activate_session_tenancy_from_additional_organization(p_operation_id);
  RETURN public_result;
END
$creation$;

REVOKE ALL ON FUNCTION create_additional_managed_organization(
  text, text, text, text, uuid
) FROM PUBLIC;

DO $posture$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.activate_session_tenancy_from_additional_organization(uuid) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.create_additional_managed_organization(text,text,text,text,uuid) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema, data_schema
  );
END
$posture$;

DO $application_grants$
DECLARE
  data_schema text := pg_catalog.current_schema();
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %1$I.create_additional_managed_organization(text,text,text,text,uuid) TO %2$I',
      data_schema, application_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE %1$I.additional_organization_creation_receipts, %1$I.session_tenancy_additional_organization_activation_evidence FROM %2$I',
      data_schema, application_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %1$I.activate_session_tenancy_from_additional_organization(uuid) FROM %2$I',
      data_schema, application_role
    );
  END LOOP;
END
$application_grants$;

COMMENT ON TABLE additional_organization_creation_receipts IS
  'Immutable exact-command receipts for additional organization creation by an already-onboarded managed human.';
COMMENT ON TABLE session_tenancy_additional_organization_activation_evidence IS
  'Immutable graph, boundary-witness, private-setting, and activation evidence for a newly created additional organization.';
COMMENT ON FUNCTION create_additional_managed_organization(text, text, text, text, uuid) IS
  'Creates an additional organization, Personal workspace, first shared workspace, owner membership, and creator access atomically.';
COMMENT ON FUNCTION activate_session_tenancy_from_additional_organization(uuid) IS
  'Owner-only atomic activation for the exact fresh graph created by create_additional_managed_organization.';

RESET statement_timeout;
RESET lock_timeout;

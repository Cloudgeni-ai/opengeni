-- deployment-mode: rolling
-- Durable, idempotent invited-user setup delivery. Setup bearers remain
-- digest-only and are derived by the application only after a durable claim.

CREATE TABLE organization_user_setup_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL,
  invitation_operation_id uuid NOT NULL,
  created_by_membership_id uuid NOT NULL,
  setup_intent_id uuid REFERENCES organization_user_setup_intents(id) ON DELETE RESTRICT,
  provider_key text NOT NULL UNIQUE,
  recipient_email text NOT NULL,
  recipient_name text,
  organization_name text NOT NULL,
  organization_role text NOT NULL,
  shared_workspace_access jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_digest text,
  payload_digest text,
  state text NOT NULL DEFAULT 'pending',
  revision bigint NOT NULL DEFAULT 1,
  claim_holder_id uuid,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  provider_started_at timestamptz,
  error_class text,
  provider_message_id text,
  sent_at timestamptz,
  failed_at timestamptz,
  outcome_unknown_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organization_user_setup_deliveries_invitation_fk
    FOREIGN KEY (invitation_id, account_id)
    REFERENCES organization_membership_invitations(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT organization_user_setup_deliveries_creator_fk
    FOREIGN KEY (created_by_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT organization_user_setup_deliveries_invitation_uq
    UNIQUE (account_id, invitation_id),
  CONSTRAINT organization_user_setup_deliveries_id_account_uq
    UNIQUE (id, account_id),
  CONSTRAINT organization_user_setup_deliveries_role_check
    CHECK (organization_role IN ('owner', 'admin', 'member')),
  CONSTRAINT organization_user_setup_deliveries_state_check
    CHECK (state IN ('pending', 'sent', 'failed', 'outcome_unknown', 'revoked')),
  CONSTRAINT organization_user_setup_deliveries_digest_check CHECK (
    (token_digest IS NULL OR token_digest ~ '^[0-9a-f]{64}$')
    AND (payload_digest IS NULL OR payload_digest ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT organization_user_setup_deliveries_bounds_check CHECK (
    recipient_email = lower(btrim(recipient_email))
    AND octet_length(convert_to(recipient_email, 'UTF8')) BETWEEN 3 AND 320
    AND (recipient_name IS NULL OR octet_length(convert_to(recipient_name, 'UTF8')) BETWEEN 1 AND 120)
    AND octet_length(convert_to(organization_name, 'UTF8')) BETWEEN 1 AND 120
    AND octet_length(convert_to(provider_key, 'UTF8')) BETWEEN 1 AND 200
    AND jsonb_typeof(shared_workspace_access) = 'array'
    AND jsonb_array_length(shared_workspace_access) <= 100
    AND (error_class IS NULL OR octet_length(convert_to(error_class, 'UTF8')) BETWEEN 1 AND 64)
    AND (provider_message_id IS NULL OR octet_length(convert_to(provider_message_id, 'UTF8')) BETWEEN 1 AND 255)
    AND attempt_count >= 0
    AND revision > 0
  ),
  CONSTRAINT organization_user_setup_deliveries_claim_check CHECK (
    (claim_holder_id IS NULL AND claim_expires_at IS NULL)
    OR (claim_holder_id IS NOT NULL AND claim_expires_at IS NOT NULL)
  ),
  CONSTRAINT organization_user_setup_deliveries_terminal_check CHECK (
    (state = 'pending' AND sent_at IS NULL AND failed_at IS NULL
      AND outcome_unknown_at IS NULL AND revoked_at IS NULL)
    OR (state = 'sent' AND sent_at IS NOT NULL AND failed_at IS NULL
      AND outcome_unknown_at IS NULL AND revoked_at IS NULL)
    OR (state = 'failed' AND sent_at IS NULL AND failed_at IS NOT NULL
      AND outcome_unknown_at IS NULL AND revoked_at IS NULL)
    OR (state = 'outcome_unknown' AND sent_at IS NULL AND failed_at IS NULL
      AND outcome_unknown_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX organization_user_setup_deliveries_account_updated_idx
  ON organization_user_setup_deliveries (account_id, updated_at DESC, id DESC);
CREATE UNIQUE INDEX organization_user_setup_deliveries_token_digest_uq
  ON organization_user_setup_deliveries (token_digest) WHERE token_digest IS NOT NULL;

CREATE TABLE organization_user_setup_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  attempt_number integer NOT NULL,
  claim_holder_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_expires_at timestamptz NOT NULL,
  provider_started_at timestamptz,
  result text,
  error_class text,
  provider_message_id text,
  settled_at timestamptz,
  CONSTRAINT organization_user_setup_delivery_attempts_operation_uq
    UNIQUE (delivery_id, operation_id),
  CONSTRAINT organization_user_setup_delivery_attempts_delivery_fk
    FOREIGN KEY (delivery_id, account_id)
    REFERENCES organization_user_setup_deliveries(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT organization_user_setup_delivery_attempts_number_uq
    UNIQUE (delivery_id, attempt_number),
  CONSTRAINT organization_user_setup_delivery_attempts_bounds_check CHECK (
    attempt_number > 0
    AND claim_expires_at > claimed_at
    AND (result IS NULL OR result IN ('sent', 'failed', 'outcome_unknown', 'revoked'))
    AND (error_class IS NULL OR octet_length(convert_to(error_class, 'UTF8')) BETWEEN 1 AND 64)
    AND (provider_message_id IS NULL OR octet_length(convert_to(provider_message_id, 'UTF8')) BETWEEN 1 AND 255)
  ),
  CONSTRAINT organization_user_setup_delivery_attempts_settlement_check CHECK (
    (result IS NULL AND settled_at IS NULL)
    OR (result IS NOT NULL AND settled_at IS NOT NULL)
  )
);

ALTER TABLE organization_user_setup_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_user_setup_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_tenancy_lifecycle ON organization_user_setup_deliveries
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');

ALTER TABLE organization_user_setup_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_user_setup_delivery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_tenancy_lifecycle ON organization_user_setup_delivery_attempts
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');

CREATE FUNCTION opengeni_private.organization_user_setup_delivery_json(
  p_delivery organization_user_setup_deliveries
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $body$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_delivery.id,
    'state', CASE
      WHEN p_delivery.state = 'pending'
        AND p_delivery.provider_started_at IS NOT NULL
        AND p_delivery.claim_expires_at <= pg_catalog.clock_timestamp()
      THEN 'outcome_unknown'
      ELSE p_delivery.state
    END,
    'attemptCount', p_delivery.attempt_count,
    'revision', p_delivery.revision,
    'errorClass', CASE
      WHEN p_delivery.state = 'pending'
        AND p_delivery.provider_started_at IS NOT NULL
        AND p_delivery.claim_expires_at <= pg_catalog.clock_timestamp()
      THEN 'provider_started_claim_expired'
      ELSE p_delivery.error_class
    END,
    'sentAt', p_delivery.sent_at,
    'updatedAt', p_delivery.updated_at
  )
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.organization_invitation_row_json(
  p_invitation organization_membership_invitations
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path FROM CURRENT
AS $body$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_invitation.id,
    'organizationId', p_invitation.account_id,
    'targetEmail', p_invitation.target_email,
    'targetName', p_invitation.target_name,
    'initialWorkspaceIds', p_invitation.initial_workspace_ids,
    'role', p_invitation.role,
    'status', CASE
      WHEN p_invitation.status = 'pending'
        AND p_invitation.expires_at <= pg_catalog.clock_timestamp()
      THEN 'expired'
      ELSE p_invitation.status
    END,
    'revision', p_invitation.revision,
    'expiresAt', p_invitation.expires_at,
    'acceptedMembershipId', p_invitation.accepted_membership_id,
    'createdAt', p_invitation.created_at,
    'updatedAt', p_invitation.updated_at,
    'delivery', (
      SELECT opengeni_private.organization_user_setup_delivery_json(delivery)
      FROM organization_user_setup_deliveries delivery
      WHERE delivery.account_id = p_invitation.account_id
        AND delivery.invitation_id = p_invitation.id
    )
  )
$body$;

CREATE FUNCTION claim_organization_user_setup_delivery(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  invitation_id_value uuid := nullif(p_command ->> 'invitationId', '')::uuid;
  invitation_operation_id_value uuid := nullif(p_command ->> 'invitationOperationId', '')::uuid;
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  actor organization_memberships%ROWTYPE;
  invitation organization_membership_invitations%ROWTYPE;
  delivery organization_user_setup_deliveries%ROWTYPE;
  attempt organization_user_setup_delivery_attempts%ROWTYPE;
  normalized_email text;
  workspace_snapshot jsonb;
  now_value timestamptz := clock_timestamp();
  delivery_id_value uuid;
BEGIN
  IF account_id_value IS NULL
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
    OR actor_subject IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR invitation_id_value IS NULL
    OR operation_id_value IS NULL
  THEN
    RAISE EXCEPTION 'organization setup delivery authority is invalid' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  SELECT lower(btrim(candidate.target_email)) INTO normalized_email
  FROM organization_membership_invitations candidate
  WHERE candidate.account_id = account_id_value AND candidate.id = invitation_id_value;
  IF normalized_email IS NULL THEN
    RAISE EXCEPTION 'organization invitation is unavailable' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('organization-invitation-email:' || normalized_email, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('organization-membership:' || account_id_value::text, 0)
  );
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = account_id_value FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.subject_id = actor_subject FOR UPDATE;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO invitation FROM organization_membership_invitations candidate
  WHERE candidate.account_id = account_id_value AND candidate.id = invitation_id_value
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization invitation is unavailable' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'workspaceId', workspace.id,
    'workspaceName', workspace.name,
    'role', 'member'
  ) ORDER BY lower(workspace.name), workspace.id), '[]'::jsonb)
  INTO workspace_snapshot
  FROM unnest(invitation.initial_workspace_ids) requested(workspace_id)
  JOIN workspaces workspace
    ON workspace.account_id = account_id_value AND workspace.id = requested.workspace_id
  WHERE NOT EXISTS (
    SELECT 1 FROM organization_memberships personal_owner
    WHERE personal_owner.account_id = account_id_value
      AND personal_owner.personal_workspace_id = workspace.id
  );
  IF jsonb_array_length(workspace_snapshot) <> cardinality(invitation.initial_workspace_ids) THEN
    RAISE EXCEPTION 'organization invitation workspace snapshot is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO delivery FROM organization_user_setup_deliveries candidate
  WHERE candidate.account_id = account_id_value
    AND candidate.invitation_id = invitation_id_value FOR UPDATE;
  IF NOT FOUND THEN
    IF invitation_operation_id_value IS NULL OR NOT EXISTS (
      SELECT 1 FROM organization_membership_operation_receipts receipt
      WHERE receipt.account_id = account_id_value
        AND receipt.operation_id = invitation_operation_id_value
        AND receipt.action = 'invite'
        AND receipt.result ->> 'id' = invitation_id_value::text
    ) THEN
      RAISE EXCEPTION 'organization invitation operation is unavailable'
        USING ERRCODE = '42501';
    END IF;
    delivery_id_value := gen_random_uuid();
    INSERT INTO organization_user_setup_deliveries (
      id, account_id, invitation_id, invitation_operation_id,
      created_by_membership_id, provider_key, recipient_email, recipient_name,
      organization_name, organization_role, shared_workspace_access
    ) SELECT
      delivery_id_value, account_id_value, invitation.id, invitation_operation_id_value,
      actor.id, 'opengeni-organization-setup-v1-' || delivery_id_value::text,
      normalized_email, invitation.target_name, account.name, invitation.role,
      workspace_snapshot
    FROM managed_accounts account WHERE account.id = account_id_value
    RETURNING * INTO delivery;
  ELSIF invitation_operation_id_value IS NOT NULL
    AND delivery.invitation_operation_id IS DISTINCT FROM invitation_operation_id_value
  THEN
    RAISE EXCEPTION 'organization setup delivery identity changed' USING ERRCODE = '23505';
  END IF;

  IF invitation.status <> 'pending' OR invitation.expires_at <= now_value THEN
    IF invitation.status = 'revoked' AND delivery.state <> 'revoked' THEN
      UPDATE organization_user_setup_deliveries SET
        state = 'revoked', revision = revision + 1, revoked_at = now_value,
        claim_holder_id = NULL, claim_expires_at = NULL,
        error_class = NULL, updated_at = now_value
      WHERE id = delivery.id RETURNING * INTO delivery;
    END IF;
    RETURN jsonb_build_object(
      'claimed', false,
      'delivery', opengeni_private.organization_user_setup_delivery_json(delivery)
    );
  END IF;
  IF delivery.state IN ('sent', 'revoked') THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'delivery', opengeni_private.organization_user_setup_delivery_json(delivery)
    );
  END IF;

  SELECT * INTO attempt FROM organization_user_setup_delivery_attempts candidate
  WHERE candidate.delivery_id = delivery.id AND candidate.operation_id = operation_id_value;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'delivery', opengeni_private.organization_user_setup_delivery_json(delivery),
      'attemptId', attempt.id,
      'claimHolderId', attempt.claim_holder_id,
      'invitationId', delivery.invitation_id,
      'providerKey', delivery.provider_key,
      'recipientEmail', delivery.recipient_email,
      'recipientName', delivery.recipient_name,
      'organizationName', delivery.organization_name,
      'organizationRole', delivery.organization_role,
      'sharedWorkspaceAccess', delivery.shared_workspace_access,
      'expiresAt', invitation.expires_at
    );
  END IF;

  IF delivery.claim_holder_id IS NOT NULL AND delivery.claim_expires_at > now_value THEN
    RAISE EXCEPTION 'organization setup delivery is already claimed' USING ERRCODE = '55P03';
  END IF;
  IF delivery.claim_holder_id IS NOT NULL THEN
    UPDATE organization_user_setup_delivery_attempts SET
      result = CASE WHEN provider_started_at IS NULL THEN 'failed' ELSE 'outcome_unknown' END,
      error_class = CASE
        WHEN provider_started_at IS NULL THEN 'claim_expired_before_provider'
        ELSE 'provider_started_claim_expired'
      END,
      settled_at = now_value
    WHERE delivery_id = delivery.id AND claim_holder_id = delivery.claim_holder_id
      AND result IS NULL;
    UPDATE organization_user_setup_deliveries SET
      state = CASE WHEN provider_started_at IS NULL THEN 'failed' ELSE 'outcome_unknown' END,
      failed_at = CASE WHEN provider_started_at IS NULL THEN now_value ELSE NULL END,
      outcome_unknown_at = CASE WHEN provider_started_at IS NULL THEN NULL ELSE now_value END,
      error_class = CASE
        WHEN provider_started_at IS NULL THEN 'claim_expired_before_provider'
        ELSE 'provider_started_claim_expired'
      END,
      claim_holder_id = NULL, claim_expires_at = NULL,
      revision = revision + 1, updated_at = now_value
    WHERE id = delivery.id RETURNING * INTO delivery;
  END IF;

  INSERT INTO organization_user_setup_delivery_attempts (
    account_id, delivery_id, operation_id, attempt_number,
    claim_holder_id, claim_expires_at
  ) VALUES (
    account_id_value, delivery.id, operation_id_value, delivery.attempt_count + 1,
    gen_random_uuid(), now_value + interval '2 minutes'
  ) RETURNING * INTO attempt;
  UPDATE organization_user_setup_deliveries SET
    state = 'pending', revision = revision + 1,
    claim_holder_id = attempt.claim_holder_id,
    claim_expires_at = attempt.claim_expires_at,
    attempt_count = attempt.attempt_number,
    provider_started_at = NULL, error_class = NULL, provider_message_id = NULL,
    sent_at = NULL, failed_at = NULL, outcome_unknown_at = NULL, revoked_at = NULL,
    updated_at = now_value
  WHERE id = delivery.id RETURNING * INTO delivery;
  RETURN jsonb_build_object(
    'claimed', true,
    'delivery', opengeni_private.organization_user_setup_delivery_json(delivery),
    'attemptId', attempt.id,
    'claimHolderId', attempt.claim_holder_id,
    'invitationId', delivery.invitation_id,
    'providerKey', delivery.provider_key,
    'recipientEmail', delivery.recipient_email,
    'recipientName', delivery.recipient_name,
    'organizationName', delivery.organization_name,
    'organizationRole', delivery.organization_role,
    'sharedWorkspaceAccess', delivery.shared_workspace_access,
    'expiresAt', invitation.expires_at
  );
END
$body$;

CREATE FUNCTION prepare_organization_user_setup_delivery(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  delivery_id_value uuid := nullif(p_command ->> 'deliveryId', '')::uuid;
  attempt_id_value uuid := nullif(p_command ->> 'attemptId', '')::uuid;
  claim_holder_id_value uuid := nullif(p_command ->> 'claimHolderId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  token_digest_value text := p_command ->> 'tokenDigest';
  payload_digest_value text := p_command ->> 'payloadDigest';
  delivery organization_user_setup_deliveries%ROWTYPE;
  invitation organization_membership_invitations%ROWTYPE;
  setup organization_user_setup_intents%ROWTYPE;
  normalized_email text;
  account_id_value uuid;
  now_value timestamptz := clock_timestamp();
BEGIN
  IF delivery_id_value IS NULL OR attempt_id_value IS NULL OR claim_holder_id_value IS NULL
    OR actor_subject IS NULL OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR token_digest_value !~ '^[0-9a-f]{64}$'
    OR payload_digest_value !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'organization setup delivery preparation is invalid' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  SELECT recipient_email, account_id INTO normalized_email, account_id_value
  FROM organization_user_setup_deliveries WHERE id = delivery_id_value;
  IF normalized_email IS NULL THEN
    RAISE EXCEPTION 'organization setup delivery is unavailable' USING ERRCODE = 'P0002';
  END IF;
  IF account_id_value IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'organization setup delivery authority is invalid' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'organization-invitation-email:' || normalized_email, 0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'organization-membership:' || account_id_value::text, 0
  ));
  PERFORM 1 FROM managed_accounts account WHERE account.id = account_id_value FOR KEY SHARE;
  PERFORM 1 FROM organization_memberships membership
  WHERE membership.account_id = account_id_value AND membership.subject_id = actor_subject
    AND membership.status = 'active' AND membership.role IN ('owner', 'admin') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO delivery FROM organization_user_setup_deliveries candidate
  WHERE candidate.id = delivery_id_value FOR UPDATE;
  SELECT * INTO invitation FROM organization_membership_invitations candidate
  WHERE candidate.account_id = delivery.account_id AND candidate.id = delivery.invitation_id
  FOR UPDATE;
  IF delivery.state <> 'pending'
    OR delivery.claim_holder_id IS DISTINCT FROM claim_holder_id_value
    OR delivery.claim_expires_at <= now_value
    OR invitation.status <> 'pending'
    OR invitation.expires_at <= now_value
  THEN
    RAISE EXCEPTION 'organization setup delivery claim is unavailable' USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM organization_user_setup_delivery_attempts attempt
  WHERE attempt.id = attempt_id_value AND attempt.delivery_id = delivery.id
    AND attempt.claim_holder_id = claim_holder_id_value AND attempt.result IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization setup delivery attempt is unavailable' USING ERRCODE = '55000';
  END IF;
  IF delivery.token_digest IS NOT NULL
    AND delivery.token_digest IS DISTINCT FROM token_digest_value
  THEN
    RAISE EXCEPTION 'organization setup bearer changed under retry' USING ERRCODE = '23505';
  END IF;
  IF delivery.payload_digest IS NOT NULL
    AND delivery.payload_digest IS DISTINCT FROM payload_digest_value
  THEN
    RAISE EXCEPTION 'organization setup payload changed under retry' USING ERRCODE = '23505';
  END IF;
  PERFORM ensure_organization_user_setup_intent(jsonb_build_object(
    'organizationId', delivery.account_id,
    'actorSubjectId', actor_subject,
    'invitationId', delivery.invitation_id,
    'tokenDigest', token_digest_value,
    'expiresAt', invitation.expires_at
  ));
  SELECT * INTO setup FROM organization_user_setup_intents candidate
  WHERE candidate.account_id = delivery.account_id
    AND candidate.invitation_id = delivery.invitation_id;
  UPDATE organization_user_setup_deliveries SET
    setup_intent_id = setup.id,
    token_digest = token_digest_value,
    payload_digest = payload_digest_value,
    provider_started_at = now_value,
    revision = revision + 1,
    updated_at = now_value
  WHERE id = delivery.id RETURNING * INTO delivery;
  UPDATE organization_user_setup_delivery_attempts SET provider_started_at = now_value
  WHERE id = attempt_id_value;
  RETURN jsonb_build_object(
    'providerKey', delivery.provider_key,
    'recipientEmail', delivery.recipient_email,
    'recipientName', delivery.recipient_name,
    'organizationName', delivery.organization_name,
    'organizationRole', delivery.organization_role,
    'sharedWorkspaceAccess', delivery.shared_workspace_access
  );
END
$body$;

CREATE FUNCTION settle_organization_user_setup_delivery(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  delivery_id_value uuid := nullif(p_command ->> 'deliveryId', '')::uuid;
  attempt_id_value uuid := nullif(p_command ->> 'attemptId', '')::uuid;
  claim_holder_id_value uuid := nullif(p_command ->> 'claimHolderId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  outcome_value text := p_command ->> 'outcome';
  error_class_value text := nullif(btrim(p_command ->> 'errorClass'), '');
  provider_message_id_value text := nullif(btrim(p_command ->> 'providerMessageId'), '');
  delivery organization_user_setup_deliveries%ROWTYPE;
  invitation organization_membership_invitations%ROWTYPE;
  now_value timestamptz := clock_timestamp();
BEGIN
  IF delivery_id_value IS NULL OR attempt_id_value IS NULL OR claim_holder_id_value IS NULL
    OR actor_subject IS NULL OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR outcome_value NOT IN ('sent', 'failed', 'outcome_unknown')
    OR (outcome_value <> 'sent' AND (
      error_class_value IS NULL OR octet_length(convert_to(error_class_value, 'UTF8')) > 64
    ))
    OR (provider_message_id_value IS NOT NULL
      AND octet_length(convert_to(provider_message_id_value, 'UTF8')) > 255)
  THEN
    RAISE EXCEPTION 'organization setup delivery settlement is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  SELECT * INTO delivery FROM organization_user_setup_deliveries candidate
  WHERE candidate.id = delivery_id_value;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization setup delivery is unavailable' USING ERRCODE = 'P0002';
  END IF;
  IF delivery.account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'organization setup delivery authority is invalid' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'organization-invitation-email:' || delivery.recipient_email, 0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'organization-membership:' || delivery.account_id::text, 0
  ));
  PERFORM 1 FROM managed_accounts account WHERE account.id = delivery.account_id FOR KEY SHARE;
  PERFORM 1 FROM organization_memberships membership
  WHERE membership.account_id = delivery.account_id AND membership.subject_id = actor_subject
    AND membership.status = 'active' AND membership.role IN ('owner', 'admin') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO invitation FROM organization_membership_invitations candidate
  WHERE candidate.account_id = delivery.account_id AND candidate.id = delivery.invitation_id
  FOR UPDATE;
  SELECT * INTO delivery FROM organization_user_setup_deliveries candidate
  WHERE candidate.id = delivery_id_value FOR UPDATE;
  IF delivery.claim_holder_id IS DISTINCT FROM claim_holder_id_value THEN
    RAISE EXCEPTION 'organization setup delivery claim changed' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM organization_user_setup_delivery_attempts attempt
  WHERE attempt.id = attempt_id_value AND attempt.delivery_id = delivery.id
    AND attempt.claim_holder_id = claim_holder_id_value AND attempt.result IS NULL
    AND attempt.provider_started_at IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND OR delivery.provider_started_at IS NULL THEN
    RAISE EXCEPTION 'organization setup delivery attempt changed' USING ERRCODE = '40001';
  END IF;
  UPDATE organization_user_setup_delivery_attempts SET
    result = CASE WHEN invitation.status = 'pending' THEN outcome_value ELSE 'revoked' END,
    error_class = error_class_value,
    provider_message_id = provider_message_id_value,
    settled_at = now_value
  WHERE id = attempt_id_value;
  IF invitation.status <> 'pending' OR delivery.state = 'revoked' THEN
    UPDATE organization_user_setup_deliveries SET
      state = 'revoked', revoked_at = coalesce(revoked_at, now_value),
      claim_holder_id = NULL, claim_expires_at = NULL,
      revision = revision + 1, updated_at = now_value
    WHERE id = delivery.id RETURNING * INTO delivery;
  ELSE
    UPDATE organization_user_setup_deliveries SET
      state = outcome_value,
      error_class = CASE WHEN outcome_value = 'sent' THEN NULL ELSE error_class_value END,
      provider_message_id = provider_message_id_value,
      sent_at = CASE WHEN outcome_value = 'sent' THEN now_value ELSE NULL END,
      failed_at = CASE WHEN outcome_value = 'failed' THEN now_value ELSE NULL END,
      outcome_unknown_at = CASE WHEN outcome_value = 'outcome_unknown' THEN now_value ELSE NULL END,
      revoked_at = NULL,
      claim_holder_id = NULL, claim_expires_at = NULL,
      revision = revision + 1, updated_at = now_value
    WHERE id = delivery.id RETURNING * INTO delivery;
  END IF;
  RETURN opengeni_private.organization_user_setup_delivery_json(delivery);
END
$body$;

CREATE FUNCTION preview_organization_user_setup(p_token_digest text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  delivery organization_user_setup_deliveries%ROWTYPE;
  invitation organization_membership_invitations%ROWTYPE;
  setup organization_user_setup_intents%ROWTYPE;
BEGIN
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('state', 'unavailable');
  END IF;
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  SELECT * INTO delivery FROM organization_user_setup_deliveries candidate
  WHERE candidate.token_digest = p_token_digest;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  SELECT * INTO setup FROM organization_user_setup_intents candidate
  WHERE candidate.id = delivery.setup_intent_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  IF setup.status = 'completed' THEN
    RETURN jsonb_build_object('state', 'completed');
  END IF;
  SELECT * INTO invitation FROM organization_membership_invitations candidate
  WHERE candidate.account_id = delivery.account_id AND candidate.id = delivery.invitation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  IF invitation.status = 'revoked' OR delivery.state = 'revoked' THEN
    RETURN jsonb_build_object('state', 'revoked');
  END IF;
  IF invitation.status = 'accepted' THEN RETURN jsonb_build_object('state', 'completed'); END IF;
  IF invitation.status <> 'pending' THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  IF invitation.expires_at <= clock_timestamp() OR setup.expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('state', 'expired');
  END IF;
  RETURN jsonb_build_object(
    'state', 'pending',
    'organizationId', delivery.account_id,
    'organizationName', delivery.organization_name,
    'targetEmail', delivery.recipient_email,
    'targetName', delivery.recipient_name,
    'organizationRole', delivery.organization_role,
    'sharedWorkspaceAccess', delivery.shared_workspace_access,
    'expiresAt', invitation.expires_at
  );
END
$body$;

CREATE FUNCTION sync_organization_user_setup_delivery_revocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $body$
BEGIN
  IF NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE organization_user_setup_deliveries SET
      state = 'revoked', revoked_at = coalesce(revoked_at, clock_timestamp()),
      error_class = NULL, revision = revision + 1, updated_at = clock_timestamp()
    WHERE account_id = NEW.account_id AND invitation_id = NEW.id AND state <> 'revoked';
  END IF;
  RETURN NULL;
END
$body$;

CREATE TRIGGER organization_user_setup_delivery_revocation
AFTER UPDATE OF status ON organization_membership_invitations
FOR EACH ROW EXECUTE FUNCTION sync_organization_user_setup_delivery_revocation();

DO $pin_and_grant$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.organization_invitation_row_json(%I.organization_membership_invitations) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.claim_organization_user_setup_delivery(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.prepare_organization_user_setup_delivery(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.settle_organization_user_setup_delivery(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.preview_organization_user_setup(text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.sync_organization_user_setup_delivery_revocation() SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('REVOKE ALL ON TABLE %I.organization_user_setup_deliveries FROM opengeni_app', data_schema);
    EXECUTE format('REVOKE ALL ON TABLE %I.organization_user_setup_delivery_attempts FROM opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.claim_organization_user_setup_delivery(jsonb) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.prepare_organization_user_setup_delivery(jsonb) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.settle_organization_user_setup_delivery(jsonb) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.preview_organization_user_setup(text) TO opengeni_app', data_schema);
  END IF;
END
$pin_and_grant$;

REVOKE ALL ON TABLE organization_user_setup_deliveries FROM PUBLIC;
REVOKE ALL ON TABLE organization_user_setup_delivery_attempts FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.organization_user_setup_delivery_json(
  organization_user_setup_deliveries
) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_organization_user_setup_delivery(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION prepare_organization_user_setup_delivery(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_organization_user_setup_delivery(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION preview_organization_user_setup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_organization_user_setup_delivery_revocation() FROM PUBLIC;

COMMENT ON TABLE organization_user_setup_deliveries IS
  'Digest-only durable projection for invitation setup email claims, stable provider identity, and reconciliation.';
COMMENT ON TABLE organization_user_setup_delivery_attempts IS
  'Lifecycle-only immutable-attempt journal for invitation setup delivery provider boundaries.';

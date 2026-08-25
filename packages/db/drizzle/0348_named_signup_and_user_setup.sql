-- deployment-mode: maintenance
-- Post-sign-in self-service organization onboarding and invitation-bound
-- account setup. Ordinary Better Auth signup remains an ordinary user create;
-- a separate authenticated lifecycle creates exactly one active organization
-- membership and its canonical personal workspace. Invitation setup remains a
-- separate signed-out, hashed-bearer transaction.
-- This is a one-way application protocol cutover: stop every API, control
-- worker, and turn worker before applying it, and never restart a pre-0348
-- image. Old managed-access writers can still synthesize a fallback
-- organization and Default workspace, while old clients do not speak the
-- Personal-only setup contract.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $named_signup_writer_drain_before_lock$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0348 named signup activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0348 named signup activation received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0348 named signup activation received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0348 named signup activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$named_signup_writer_drain_before_lock$;

LOCK TABLE auth_users IN ACCESS EXCLUSIVE MODE;
LOCK TABLE auth_identities IN ACCESS EXCLUSIVE MODE;
LOCK TABLE managed_accounts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE organization_membership_invitations IN ACCESS EXCLUSIVE MODE;
LOCK TABLE organization_memberships IN ACCESS EXCLUSIVE MODE;
LOCK TABLE workspaces IN ACCESS EXCLUSIVE MODE;
LOCK TABLE workspace_memberships IN ACCESS EXCLUSIVE MODE;

DO $named_signup_writer_drain_after_lock$
DECLARE
  configured_roles jsonb := current_setting(
    'opengeni.migration_application_roles', false
  )::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0348 named signup activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$named_signup_writer_drain_after_lock$;

CREATE TABLE self_service_organization_setup_receipts (
  auth_user_id text PRIMARY KEY REFERENCES auth_users(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  account_id uuid NOT NULL UNIQUE REFERENCES managed_accounts(id) ON DELETE RESTRICT,
  personal_workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE RESTRICT,
  organization_membership_id uuid NOT NULL UNIQUE
    REFERENCES organization_memberships(id) ON DELETE RESTRICT,
  organization_name text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT self_service_organization_setup_fingerprint_check CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT self_service_organization_setup_name_check CHECK (
    organization_name = btrim(organization_name)
    AND octet_length(convert_to(organization_name, 'UTF8')) BETWEEN 1 AND 120
  )
);
ALTER TABLE self_service_organization_setup_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE self_service_organization_setup_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_tenancy_lifecycle
  ON self_service_organization_setup_receipts
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');

CREATE FUNCTION complete_self_service_organization_setup(p_command jsonb)
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

  -- Serialize all setup attempts for this exact Better Auth identity. The
  -- verified-email invitation binder then takes its canonical email fence,
  -- ensuring a pre-existing invitation always wins over organization creation.
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

  -- A pre-0348 image could leave this exact Better Auth user a legacy
  -- `better-auth:user` fallback organization whose organization membership was
  -- never backfilled: migration 0290 only anchored subjects that already held
  -- workspace access. Refusing that shape dead-ends the human permanently -
  -- managed-access convergence no longer self-heals it, and this is a one-way
  -- cutover - so adopt the orphaned account instead of creating a second one.
  -- Adoption keeps the human's existing account identity (and any legacy
  -- workspace grants they already hold inside it) and needs no migration-time
  -- backfill over a FORCE-RLS table. It is only safe while that account carries
  -- NO organization membership at all: one that already has memberships
  -- describes a state this lifecycle must not reinterpret, and granting owner
  -- there would be a privilege event rather than a repair.
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

  -- Join the canonical organization -> workspace lock order before acquiring
  -- any workspace state. Never hold managed_accounts FOR UPDATE across this
  -- prefix: an adopted account can still have ordinary workspace writers, and
  -- migration 0299 fences exactly that deadlock, so the adoption rename is
  -- deferred until after the workspace prefix below.
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
    -- Only now, with every workspace row already acquired, is an organization
    -- row write safe. The one-shot signup name is this human's first and only
    -- chance to name the organization - they never had access to the orphaned
    -- account - so this is initial provisioning, not the managed-access
    -- convergence rename that the access refresh path must never perform.
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
  RETURN public_result;
END
$body$;

-- Preserve the API/SDK signature introduced by 0331 while forwarding every
-- rolling caller through the corrected one-time setup lifecycle above. The
-- legacy subject label is deliberately non-authoritative.
CREATE OR REPLACE FUNCTION create_managed_organization(
  p_subject_id text,
  p_subject_label text,
  p_name text,
  p_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  auth_user_id_value text := substring(p_subject_id from length('user:') + 1);
  requested_name text := nullif(pg_catalog.btrim(p_name), '');
  fingerprint_value text;
BEGIN
  IF p_subject_id IS NULL
    OR p_subject_id NOT LIKE 'user:%'
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR requested_name IS NULL
    OR pg_catalog.octet_length(pg_catalog.convert_to(requested_name, 'UTF8')) NOT BETWEEN 1 AND 120
    OR p_operation_id IS NULL
  THEN
    RAISE EXCEPTION 'managed organization creation input is invalid'
      USING ERRCODE = '22023';
  END IF;

  fingerprint_value := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'opengeni:self-service-organization:v1:' || p_subject_id || ':' ||
      pg_catalog.octet_length(pg_catalog.convert_to(requested_name, 'UTF8'))::text || ':' ||
      requested_name,
    'UTF8'
  )), 'hex');

  RETURN complete_self_service_organization_setup(pg_catalog.jsonb_build_object(
    'authUserId', auth_user_id_value,
    'actorSubjectId', p_subject_id,
    'organizationName', requested_name,
    'operationId', p_operation_id,
    'requestFingerprint', fingerprint_value
  ));
END
$body$;

CREATE TABLE organization_user_setup_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL,
  token_digest text NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  completion_operation_id uuid,
  completion_request_fingerprint text,
  completed_auth_user_id text REFERENCES auth_users(id) ON DELETE RESTRICT,
  completion_result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT organization_user_setup_intents_invitation_fk
    FOREIGN KEY (invitation_id, account_id)
    REFERENCES organization_membership_invitations(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT organization_user_setup_intents_invitation_uq UNIQUE (account_id, invitation_id),
  CONSTRAINT organization_user_setup_intents_token_uq UNIQUE (token_digest),
  CONSTRAINT organization_user_setup_intents_token_check CHECK (
    token_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT organization_user_setup_intents_status_check CHECK (
    status IN ('pending', 'completed')
  ),
  CONSTRAINT organization_user_setup_intents_completion_check CHECK (
    (status = 'pending'
      AND completion_operation_id IS NULL
      AND completion_request_fingerprint IS NULL
      AND completed_auth_user_id IS NULL
      AND completion_result IS NULL
      AND completed_at IS NULL)
    OR
    (status = 'completed'
      AND completion_operation_id IS NOT NULL
      AND completion_request_fingerprint IS NOT NULL
      AND completion_request_fingerprint ~ '^[0-9a-f]{64}$'
      AND completed_auth_user_id IS NOT NULL
      AND completion_result IS NOT NULL
      AND completed_at IS NOT NULL)
  )
);

ALTER TABLE organization_user_setup_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_user_setup_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_tenancy_lifecycle ON organization_user_setup_intents
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');

CREATE FUNCTION ensure_organization_user_setup_intent(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  invitation_id_value uuid := nullif(p_command ->> 'invitationId', '')::uuid;
  invitation organization_membership_invitations%ROWTYPE;
  actor organization_memberships%ROWTYPE;
  setup organization_user_setup_intents%ROWTYPE;
  digest_value text := p_command ->> 'tokenDigest';
  expires_at_value timestamptz := nullif(p_command ->> 'expiresAt', '')::timestamptz;
BEGIN
  IF account_id_value IS NULL
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
    OR actor_subject IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR invitation_id_value IS NULL
    OR digest_value !~ '^[0-9a-f]{64}$'
    OR expires_at_value IS NULL
  THEN
    RAISE EXCEPTION 'organization user setup authority is invalid' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-membership:' || account_id_value::text, 0)
  );
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = account_id_value FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = account_id_value
    AND membership.subject_id = actor_subject
  FOR UPDATE;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO invitation FROM organization_membership_invitations candidate
  WHERE candidate.account_id = account_id_value
    AND candidate.id = invitation_id_value
  FOR UPDATE;
  IF NOT FOUND
    OR invitation.created_by_membership_id IS DISTINCT FROM actor.id
    OR invitation.status <> 'pending'
    OR invitation.expires_at <= pg_catalog.clock_timestamp()
    OR expires_at_value IS DISTINCT FROM invitation.expires_at
  THEN
    RAISE EXCEPTION 'organization invitation is unavailable' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO setup FROM organization_user_setup_intents candidate
  WHERE candidate.account_id = account_id_value
    AND candidate.invitation_id = invitation_id_value
  FOR UPDATE;
  IF FOUND THEN
    IF setup.token_digest IS DISTINCT FROM digest_value
      OR setup.expires_at IS DISTINCT FROM expires_at_value
    THEN
      RAISE EXCEPTION 'organization user setup intent changed under retry'
        USING ERRCODE = '23505';
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', setup.status);
  END IF;

  INSERT INTO organization_user_setup_intents (
    account_id, invitation_id, token_digest, expires_at
  ) VALUES (
    account_id_value, invitation_id_value, digest_value, expires_at_value
  ) RETURNING * INTO setup;
  RETURN pg_catalog.jsonb_build_object('status', setup.status);
END
$body$;

CREATE FUNCTION preflight_organization_user_setup(p_token_digest text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  setup organization_user_setup_intents%ROWTYPE;
  invitation organization_membership_invitations%ROWTYPE;
  normalized_email text;
BEGIN
  -- This is deliberately a cheap, non-consuming eligibility read. The final
  -- lifecycle repeats every check under the canonical email/organization
  -- locks and remains the only authority that creates or consumes anything.
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN 'unavailable';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  SELECT * INTO setup FROM organization_user_setup_intents candidate
  WHERE candidate.token_digest = p_token_digest;
  IF NOT FOUND THEN
    RETURN 'unavailable';
  END IF;
  IF setup.status = 'completed' THEN
    RETURN 'completed';
  END IF;
  SELECT * INTO invitation FROM organization_membership_invitations candidate
  WHERE candidate.account_id = setup.account_id
    AND candidate.id = setup.invitation_id;
  IF NOT FOUND
    OR invitation.status <> 'pending'
    OR invitation.expires_at <= pg_catalog.clock_timestamp()
    OR setup.expires_at <= pg_catalog.clock_timestamp()
    OR invitation.expires_at IS DISTINCT FROM setup.expires_at
  THEN
    RETURN 'unavailable';
  END IF;
  normalized_email := lower(btrim(invitation.target_email));
  IF EXISTS (
    SELECT 1 FROM auth_users auth_user
    WHERE lower(btrim(auth_user.email)) = normalized_email
  ) THEN
    RETURN 'unavailable';
  END IF;
  RETURN 'pending';
END
$body$;

CREATE FUNCTION complete_organization_user_setup(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  digest_value text := p_command ->> 'tokenDigest';
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  fingerprint_value text := p_command ->> 'requestFingerprint';
  auth_user_id_value text := p_command ->> 'authUserId';
  display_name_value text := nullif(btrim(p_command ->> 'name'), '');
  password_hash_value text := p_command ->> 'passwordHash';
  setup organization_user_setup_intents%ROWTYPE;
  invitation organization_membership_invitations%ROWTYPE;
  normalized_email text;
  subject_id_value text;
  locked_account_id_value uuid;
  acceptance_result jsonb;
  public_result jsonb := pg_catalog.jsonb_build_object('status', 'complete');
BEGIN
  IF digest_value !~ '^[0-9a-f]{64}$'
    OR operation_id_value IS NULL
    OR fingerprint_value !~ '^[0-9a-f]{64}$'
    OR auth_user_id_value IS NULL
    OR octet_length(convert_to(auth_user_id_value, 'UTF8')) NOT BETWEEN 1 AND 1019
    OR display_name_value IS NULL
    OR octet_length(convert_to(display_name_value, 'UTF8')) NOT BETWEEN 1 AND 120
    OR password_hash_value IS NULL
    OR octet_length(convert_to(password_hash_value, 'UTF8')) NOT BETWEEN 32 AND 4096
  THEN
    RAISE EXCEPTION 'organization user setup input is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  SELECT * INTO setup FROM organization_user_setup_intents candidate
  WHERE candidate.token_digest = digest_value;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization user setup is unavailable' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO invitation FROM organization_membership_invitations candidate
  WHERE candidate.account_id = setup.account_id
    AND candidate.id = setup.invitation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization user setup is unavailable' USING ERRCODE = 'P0002';
  END IF;
  normalized_email := lower(btrim(invitation.target_email));

  -- Match invitation creation/binding lock order before taking any tenant row.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-invitation-email:' || normalized_email, 0)
  );
  -- Freeze the complete matching invitation set behind the email fence, then
  -- acquire every relevant organization lock in UUID order before touching the
  -- selected organization. This preserves the binder's canonical multi-org
  -- order even when two different recipients have invitations in the same two
  -- organizations but choose opposite setup links concurrently.
  FOR locked_account_id_value IN
    SELECT relevant.account_id
    FROM (
      SELECT setup.account_id
      UNION
      SELECT candidate.account_id
      FROM organization_membership_invitations candidate
      WHERE candidate.target_subject_id IS NULL
        AND candidate.target_email = normalized_email
        AND candidate.status = 'pending'
        AND candidate.expires_at > pg_catalog.clock_timestamp()
    ) relevant
    ORDER BY relevant.account_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'organization-membership:' || locked_account_id_value::text, 0
      )
    );
    PERFORM 1 FROM managed_accounts account
    WHERE account.id = locked_account_id_value FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'organization user setup is unavailable' USING ERRCODE = 'P0002';
    END IF;
  END LOOP;

  SELECT * INTO setup FROM organization_user_setup_intents candidate
  WHERE candidate.token_digest = digest_value
  FOR UPDATE;
  IF setup.status = 'completed' THEN
    IF setup.completion_operation_id IS DISTINCT FROM operation_id_value
      OR setup.completion_request_fingerprint IS DISTINCT FROM fingerprint_value
    THEN
      RAISE EXCEPTION 'organization user setup operation was reused'
        USING ERRCODE = '23505';
    END IF;
    RETURN setup.completion_result;
  END IF;

  SELECT * INTO invitation FROM organization_membership_invitations candidate
  WHERE candidate.account_id = setup.account_id
    AND candidate.id = setup.invitation_id
  FOR UPDATE;
  IF NOT FOUND
    OR invitation.status <> 'pending'
    OR invitation.expires_at <= pg_catalog.clock_timestamp()
    OR setup.expires_at <= pg_catalog.clock_timestamp()
    OR invitation.expires_at IS DISTINCT FROM setup.expires_at
  THEN
    RAISE EXCEPTION 'organization user setup is unavailable' USING ERRCODE = 'P0002';
  END IF;

  -- Existing users retain the ordinary verified-email invitation path. A setup
  -- bearer never changes an existing credential or takes over an identity.
  IF EXISTS (
    SELECT 1 FROM auth_users auth_user
    WHERE lower(btrim(auth_user.email)) = normalized_email
  ) THEN
    RAISE EXCEPTION 'organization user setup is unavailable' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO auth_users (id, name, email, email_verified)
  VALUES (auth_user_id_value, display_name_value, normalized_email, true);
  INSERT INTO auth_identities (
    id, user_id, account_id, provider_id, password
  ) VALUES (
    gen_random_uuid()::text, auth_user_id_value, auth_user_id_value,
    'credential', password_hash_value
  );

  subject_id_value := 'user:' || auth_user_id_value;
  PERFORM pg_catalog.set_config('opengeni.subject_id', subject_id_value, true);
  PERFORM pg_catalog.set_config('opengeni.account_id', setup.account_id::text, true);
  PERFORM pg_catalog.set_config('opengeni.workspace_id', '', true);
  PERFORM bind_pending_organization_invitations_for_verified_email(
    subject_id_value, normalized_email
  );

  SELECT * INTO invitation FROM organization_membership_invitations candidate
  WHERE candidate.account_id = setup.account_id
    AND candidate.id = setup.invitation_id
  FOR UPDATE;
  IF invitation.target_subject_id IS DISTINCT FROM subject_id_value
    OR invitation.status <> 'pending'
  THEN
    RAISE EXCEPTION 'organization user setup is unavailable' USING ERRCODE = 'P0002';
  END IF;

  acceptance_result := accept_organization_invitation_v2(
    pg_catalog.jsonb_build_object(
      'action', 'accept',
      'organizationId', setup.account_id,
      'actorSubjectId', subject_id_value,
      'operationId', operation_id_value,
      'invitationId', setup.invitation_id,
      'expectedRevision', invitation.revision
    )
  );
  IF acceptance_result -> 'membership' ->> 'subjectId' IS DISTINCT FROM subject_id_value THEN
    RAISE EXCEPTION 'organization user setup acceptance did not converge'
      USING ERRCODE = '55000';
  END IF;

  UPDATE organization_user_setup_intents SET
    status = 'completed',
    completion_operation_id = operation_id_value,
    completion_request_fingerprint = fingerprint_value,
    completed_auth_user_id = auth_user_id_value,
    completion_result = public_result,
    completed_at = pg_catalog.clock_timestamp(),
    updated_at = pg_catalog.clock_timestamp()
  WHERE id = setup.id;
  RETURN public_result;
END
$body$;

-- The incoming-invitation chooser must expose a human-readable organization
-- identity without turning the row-projection helper into an arbitrary account
-- name oracle. Enrich only the exact current subject's authorized page.
CREATE OR REPLACE FUNCTION list_self_organization_invitations(
  p_subject_id text,
  p_cursor_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  cursor_created_at timestamptz;
  result jsonb;
BEGIN
  IF p_subject_id IS NULL
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_subject_id NOT LIKE 'user:%'
    OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
  THEN
    RAISE EXCEPTION 'managed human subject authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  IF p_cursor_id IS NOT NULL THEN
    SELECT invitation.created_at INTO cursor_created_at
    FROM organization_membership_invitations invitation
    WHERE invitation.target_subject_id = p_subject_id
      AND invitation.id = p_cursor_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'organization invitation cursor not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  SELECT coalesce(
    pg_catalog.jsonb_agg(
      opengeni_private.organization_invitation_row_json(candidate.invitation)
        || pg_catalog.jsonb_build_object('organizationName', candidate.organization_name)
      ORDER BY candidate.created_at DESC, candidate.id DESC
    ), '[]'::jsonb
  ) INTO result
  FROM (
    SELECT invitation AS invitation, account.name AS organization_name,
      invitation.created_at, invitation.id
    FROM organization_membership_invitations invitation
    JOIN managed_accounts account ON account.id = invitation.account_id
    WHERE invitation.target_subject_id = p_subject_id
      AND (
        p_cursor_id IS NULL
        OR (invitation.created_at, invitation.id) < (cursor_created_at, p_cursor_id)
      )
    ORDER BY invitation.created_at DESC, invitation.id DESC
    LIMIT p_limit + 1
  ) candidate;
  RETURN result;
END
$body$;

DO $search_paths$
DECLARE data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.complete_self_service_organization_setup(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.ensure_organization_user_setup_intent(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.preflight_organization_user_setup(text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.complete_organization_user_setup(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.create_managed_organization(text,text,text,uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_self_organization_invitations(text,uuid,integer) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END
$search_paths$;

REVOKE ALL ON TABLE self_service_organization_setup_receipts FROM PUBLIC;
REVOKE ALL ON TABLE organization_user_setup_intents FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_self_service_organization_setup(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION ensure_organization_user_setup_intent(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION preflight_organization_user_setup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_organization_user_setup(jsonb) FROM PUBLIC;

DO $runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON TABLE self_service_organization_setup_receipts FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_setup_intents FROM opengeni_app;
    GRANT EXECUTE ON FUNCTION complete_self_service_organization_setup(jsonb) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION ensure_organization_user_setup_intent(jsonb) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION preflight_organization_user_setup(text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION complete_organization_user_setup(jsonb) TO opengeni_app;
  END IF;
END
$runtime_grants$;

COMMENT ON TABLE self_service_organization_setup_receipts IS
  'One completed organization setup per verified Better Auth user; stores idempotency evidence and the canonical personal-workspace result.';
COMMENT ON FUNCTION complete_self_service_organization_setup(jsonb) IS
  'Atomically creates one active organization owner membership and only its canonical personal workspace after ordinary sign-in.';
COMMENT ON FUNCTION create_managed_organization(text,text,text,uuid) IS
  'Compatibility entry point for the one-time Personal-only self-service organization setup lifecycle.';
COMMENT ON TABLE organization_user_setup_intents IS
  'Invitation-bound hashed one-time account setup authority; no plaintext bearer or password is stored.';
COMMENT ON FUNCTION preflight_organization_user_setup(text) IS
  'Performs a cheap non-consuming setup-bearer eligibility read before password hashing; final completion revalidates atomically.';
COMMENT ON FUNCTION complete_organization_user_setup(jsonb) IS
  'Consumes one email-delivered setup bearer and atomically creates the verified credential and invitation membership.';

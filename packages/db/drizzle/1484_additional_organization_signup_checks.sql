-- deployment-mode: rolling
-- Additional organizations get the same signup checks as a first one, and
-- inherit a review hold (docs/deployment.md, "Free compute bounds").
--
-- A person who already has an organization can create up to ten more
-- (create_additional_managed_organization, 0977). Those organizations skipped
-- every signup check: the network was not recorded, the per-network rate
-- limit (1354, 1471) did not apply, velocity never evaluated them, and a
-- person whose organization review held or denied simply started a fresh
-- one. The function now, with its body otherwise unchanged:
--
-- 1. applies the signup network rate limit (SQLSTATE OG429) from the keyed
--    network hashes the API passes in opengeni.signup_network_source, as the
--    setup-receipt trigger does for a first organization;
-- 2. records the network, the owner's setup time and session networks, and
--    lists the organizations to evaluate after commit in
--    opengeni.signup_network_evaluate_accounts;
-- 3. starts the new organization held (rule linked-owner-v1, through
--    set_promotion_decision, so it has history) when the person owns or
--    administers an organization whose decision is held or denied and that
--    does not pay. Each such hold is released on its own, like any other
--    detector hold.
--
-- Every new step fails open except the refusal, as in 1471. The Free catalog,
-- the limit of ten and invitations are unchanged.
--
-- Rolling: CREATE OR REPLACE of a known definer with the same signature, so
-- its owner and grants are kept and the previous release calls it unchanged.
-- An older API sets no network, so nothing is recorded or refused for it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE OR REPLACE FUNCTION create_additional_managed_organization(p_subject_id text, p_subject_label text, p_organization_name text, p_workspace_name text, p_operation_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  additional_organization_limit constant integer := 10;
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
  created_organization_count integer;
  public_result jsonb;
  -- 1484: signup network and linked review decisions.
  linked_held boolean := false;
  linked_account_id uuid;
  linked_account_ids uuid[];
  prior_account_scope text;
  prior_workspace_scope text;
  network_target text;
  network jsonb;
  address_hash_value text;
  prefix_hash_value text;
  network_settings jsonb;
  recent_count integer;
  refuse boolean := false;
  evaluate_ids text;
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

  -- 1484: a person who owns or administers an organization that review held
  -- or denied starts every new organization held too, unless that
  -- organization pays (a paid or Enterprise plan, a Stripe subscription, or
  -- bought credit), as the sandbox plan tier treats it. Plans and the credit
  -- ledger are visible only under their own account's row-level security, so
  -- the candidates are listed first and each is checked under its account;
  -- the caller's scope is restored after. A check that fails holds nothing
  -- (fail open) and rolls its scope change back.
  SELECT coalesce(pg_catalog.array_agg(DISTINCT membership.account_id), '{}')
    INTO linked_account_ids
    FROM organization_memberships membership
    JOIN promotion_decisions decision ON decision.account_id = membership.account_id
    WHERE membership.subject_id = p_subject_id
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
      AND decision.decision IN ('held', 'denied');
  prior_account_scope := pg_catalog.current_setting('opengeni.account_id', true);
  prior_workspace_scope := pg_catalog.current_setting('opengeni.workspace_id', true);
  FOREACH linked_account_id IN ARRAY linked_account_ids LOOP
    BEGIN
      PERFORM pg_catalog.set_config('opengeni.account_id', linked_account_id::text, true);
      PERFORM pg_catalog.set_config('opengeni.workspace_id', '', true);
      IF NOT EXISTS (
          SELECT 1 FROM organization_plans plan
          WHERE plan.account_id = linked_account_id
            AND (plan.stripe_subscription_id IS NOT NULL
              OR plan.plan_key = 'enterprise'
              OR (plan.plan_key <> 'free'
                AND plan.status IN ('active', 'trialing', 'past_due')))
        ) AND NOT EXISTS (
          SELECT 1 FROM credit_ledger_entries entry
          WHERE entry.account_id = linked_account_id
            AND entry.type = 'credit_topup'
            AND entry.amount_micros > 0
        ) THEN
        linked_held := true;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'additional organization linked review check skipped (%)', SQLSTATE;
    END;
    EXIT WHEN linked_held;
  END LOOP;
  PERFORM pg_catalog.set_config('opengeni.account_id', coalesce(prior_account_scope, ''), true);
  PERFORM pg_catalog.set_config('opengeni.workspace_id', coalesce(prior_workspace_scope, ''), true);

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

  -- Fresh operation ids must not turn one verified login into an unbounded
  -- tenant allocator. Serialize every create for the canonical subject, then
  -- count only organizations allocated through this lifecycle. Invitations do
  -- not consume the self-service allowance, and an exact committed retry above
  -- continues to replay after the allowance is full.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'additional-organization-creation-subject:' || p_subject_id, 0
  ));
  SELECT count(*)::integer INTO created_organization_count
  FROM additional_organization_creation_receipts receipt
  WHERE receipt.actor_subject_id = p_subject_id;
  IF created_organization_count >= additional_organization_limit THEN
    RAISE EXCEPTION 'additional organization limit reached'
      USING ERRCODE = '54000';
  END IF;

  -- 1484: the signup network rate limit (1354, 1471), as for a person's
  -- first organization. The API passes keyed hashes of the request network
  -- in opengeni.signup_network_source. Every step fails open except the
  -- refusal; no setting means nothing recorded and nothing refused.
  BEGIN
    network_target := session_tenancy_fence_target_schema()::regnamespace::text;
    network := nullif(pg_catalog.current_setting('opengeni.signup_network_source', true), '')::jsonb;
    address_hash_value := network->>'addressHash';
    prefix_hash_value := network->>'prefixHash';
    IF address_hash_value !~ '^[0-9a-f]{64}$' OR prefix_hash_value !~ '^[0-9a-f]{64}$' THEN
      address_hash_value := NULL;
    END IF;
    network_settings := opengeni_private.signup_network_velocity_settings(network_target);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'additional organization signup network skipped';
    address_hash_value := NULL;
  END;
  IF network_target IS NOT NULL AND address_hash_value IS NOT NULL THEN
    BEGIN
      IF (network_settings->>'rateLimitEnabled')::boolean THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
          'signup-network-rate:' || network_target || ':' || address_hash_value, 0));
        SELECT count(*)::integer INTO recent_count
        FROM opengeni_private.signup_network_sources source
        WHERE source.data_schema = network_target
          AND source.address_hash = address_hash_value
          AND source.set_up_at > pg_catalog.clock_timestamp() - interval '1 hour';
        refuse := recent_count >= (network_settings->>'rateLimitMax')::integer;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'additional organization signup network rate limit skipped';
      refuse := false;
    END;
    IF refuse THEN
      RAISE EXCEPTION 'too many new organizations from this network in the last hour'
        USING ERRCODE = 'OG429';
    END IF;
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

  -- 1484: record the network like a first organization's setup, list the
  -- organizations to evaluate after commit, and carry a linked hold.
  IF network_target IS NOT NULL AND address_hash_value IS NOT NULL THEN
    BEGIN
      INSERT INTO opengeni_private.signup_network_sources(data_schema, account_id,
        owner_auth_user_id, address_hash, prefix_hash)
      VALUES (network_target, account_row.id, auth_user_id_value, address_hash_value,
        prefix_hash_value)
      ON CONFLICT (data_schema, account_id) DO NOTHING;
      IF network_settings->>'mode' IN ('observe', 'enforce') THEN
        SELECT pg_catalog.string_agg(peer.account_id::text, ','
            ORDER BY peer.self DESC, peer.set_up_at DESC)
          INTO evaluate_ids FROM (
            SELECT source.account_id, source.set_up_at, source.account_id = account_row.id AS self
            FROM opengeni_private.signup_network_sources source
            WHERE source.data_schema = network_target
              AND source.address_hash = address_hash_value
              AND source.set_up_at >= pg_catalog.clock_timestamp()
                - pg_catalog.make_interval(hours => (network_settings->>'windowHours')::integer)
            ORDER BY source.account_id = account_row.id DESC, source.set_up_at DESC LIMIT 51
          ) peer;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'additional organization signup network was not recorded';
    END;
  END IF;
  IF network_target IS NOT NULL THEN
    BEGIN
      INSERT INTO opengeni_private.signup_network_owner_setups(data_schema, account_id)
        VALUES (network_target, account_row.id) ON CONFLICT (data_schema, account_id) DO NOTHING;
      PERFORM opengeni_private.record_signup_owner_session_networks(
        network_target, account_row.id, auth_user_id_value);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'additional organization owner networks were not recorded';
    END;
    IF coalesce(evaluate_ids, '') = '' AND (
      network_settings->>'signInNetworkMode' IN ('observe', 'enforce')
      OR network_settings->>'deniedNetworkMode' IN ('observe', 'enforce')
    ) THEN
      evaluate_ids := account_row.id::text;
    END IF;
    BEGIN
      PERFORM pg_catalog.set_config('opengeni.signup_network_evaluate_accounts',
        coalesce(evaluate_ids, ''), true);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'additional organization evaluation list was not set';
    END;
  END IF;
  IF linked_held THEN
    PERFORM opengeni_private.set_promotion_decision(account_row.id, 'held', 'linked-owner-v1',
      'linked-owner-v1',
      pg_catalog.jsonb_build_object('ruleId', 'linked-owner-v1',
        'reason', 'its owner owns or administers an organization review held or denied'),
      'service:promotion-detector', 0);
  END IF;

  PERFORM activate_session_tenancy_from_additional_organization(p_operation_id);
  RETURN public_result;
END
$$;

-- CREATE OR REPLACE keeps owner and grants. Restore the pinned search path.
DO $install$
DECLARE data_schema text := current_schema(); routine regprocedure;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = data_schema AND p.proname = 'create_additional_managed_organization'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
      routine, data_schema);
  END LOOP;
END $install$;

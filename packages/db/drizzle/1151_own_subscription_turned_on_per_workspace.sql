-- deployment-mode: rolling
-- A person's own Codex, Claude or SuperGrok subscription can be turned on for
-- their own turns in a shared workspace. "Turned on" is an active `always`
-- grant on the account's existing `subscription_connection` authority, for
-- that workspace, with action `subscription_connection.use` and context
-- `workspace_shared` (it covers both Only me and shared chats there). The
-- owner issues and revokes it through the existing owner-only grant
-- functions, so this migration only teaches them the new action.
--
-- Acceptance then freezes the existing restricted v2 entry
-- (`sharedSessionChoice` for this session and connection) for a turn whose
-- signed-in person turned their own account on here. An explicit per-chat
-- choice still wins. The placement and lease guards already accept that
-- entry in both chat kinds, so they are unchanged.
--
-- Rolling: signatures, owners and grants are unchanged. An older runtime that
-- does not send the runtime receipt gets the previous result (no entry in a
-- shared chat, the owner's pool entry in an Only me chat), never an error.
-- No grant exists until a person turns one on.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Later migrations name the install schema at run time; the baseline wrote it
-- as a placeholder.
DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION issue_self_user_resource_grant(p_account_id uuid, p_authority_id uuid, p_workspace_id uuid, p_resource_kind text, p_mode text, p_context text, p_session_id uuid DEFAULT NULL::uuid, p_expected_authority_epoch integer DEFAULT NULL::integer, p_workspace_shared_acknowledged boolean DEFAULT false) RETURNS TABLE(grant_id uuid, organization_id uuid, authority_generation bigint, target_workspace_id uuid, target_session_id uuid, action text, grant_mode text, grant_context text, authority_epoch integer, grant_generation bigint, grant_status text, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $$
#variable_conflict use_column
DECLARE
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  owner_membership_id uuid;
  target_epoch integer;
  target_visibility text;
  canonical_action text;
BEGIN
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true
  );
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
    OR caller_subject IS NULL
  THEN
    RAISE EXCEPTION 'user-resource grant scope mismatch' USING ERRCODE = '42501';
  END IF;
  canonical_action := CASE p_resource_kind
    WHEN 'document' THEN 'document.read'
    WHEN 'variable_set' THEN 'variable_set.use'
    WHEN 'rig' THEN 'rig.use'
    WHEN 'connected_machine' THEN 'connected_machine.use'
    WHEN 'subscription_connection' THEN 'subscription_connection.use'
    ELSE NULL
  END;
  IF p_resource_kind IS NULL OR canonical_action IS NULL
    OR p_mode IS NULL OR p_mode NOT IN ('session', 'always')
    OR p_context IS NULL OR p_context NOT IN ('user_private', 'workspace_shared')
    OR (p_mode = 'always' AND (p_session_id IS NOT NULL OR p_expected_authority_epoch IS NOT NULL))
    OR (p_mode = 'session' AND (p_session_id IS NULL OR p_expected_authority_epoch IS NULL))
    OR coalesce(p_expected_authority_epoch, 1) <= 0
  THEN
    RAISE EXCEPTION 'invalid user-resource grant request' USING ERRCODE = '22023';
  END IF;
  IF p_context = 'workspace_shared' AND p_workspace_shared_acknowledged IS NOT TRUE THEN
    RAISE EXCEPTION 'workspace_shared requires durable shared-output acknowledgement'
      USING ERRCODE = '42501';
  END IF;
  -- 0611: every organization is session-tenancy activated.

  SELECT membership.id INTO owner_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = caller_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner membership not found or access denied' USING ERRCODE = '42501';
  END IF;

  SELECT authority.generation INTO authority_generation
  FROM organization_user_resource_authorities authority
  WHERE authority.id = p_authority_id
    AND authority.account_id = p_account_id
    AND authority.organization_membership_id = owner_membership_id
    AND authority.resource_kind = p_resource_kind
    AND authority.status = 'active'
    AND authority.revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user-resource authority not found or access denied' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM workspaces workspace_value
  WHERE workspace_value.id = p_workspace_id AND workspace_value.account_id = p_account_id
  FOR SHARE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.id = owner_membership_id
      AND (
        membership.personal_workspace_id = p_workspace_id
        OR EXISTS (
          SELECT 1 FROM workspace_memberships workspace_membership
          WHERE workspace_membership.account_id = p_account_id
            AND workspace_membership.workspace_id = p_workspace_id
            AND workspace_membership.subject_id = caller_subject
        )
      )
  ) THEN
    RAISE EXCEPTION 'owner lacks current target-workspace access' USING ERRCODE = '42501';
  END IF;

  IF p_session_id IS NOT NULL THEN
    SELECT session_value.authority_epoch, session_value.visibility
      INTO target_epoch, target_visibility
    FROM sessions session_value
    WHERE session_value.id = p_session_id
      AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    IF NOT FOUND
      OR target_visibility IS DISTINCT FROM p_context
      OR target_epoch IS DISTINCT FROM p_expected_authority_epoch
    THEN
      RAISE EXCEPTION 'target session not found or access denied' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE organization_user_resource_grants grant_value
  SET status = 'expired', updated_at = clock_timestamp()
  WHERE grant_value.account_id = p_account_id
    AND grant_value.authority_id = p_authority_id
    AND grant_value.status = 'active'
    AND grant_value.expires_at IS NOT NULL
    AND grant_value.expires_at <= clock_timestamp();

  INSERT INTO organization_user_resource_grants (
    account_id, authority_id, owner_organization_membership_id, workspace_id,
    session_id, action, mode, context, authority_epoch, generation, status
  ) VALUES (
    p_account_id, p_authority_id, owner_membership_id, p_workspace_id,
    p_session_id, canonical_action, p_mode, p_context, target_epoch, 1, 'active'
  )
  ON CONFLICT (account_id, authority_id, workspace_id, action, mode, context,
    (coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(authority_epoch, 0))) WHERE status = 'active'
  DO UPDATE SET updated_at = organization_user_resource_grants.updated_at
  RETURNING id, workspace_id, session_id, organization_user_resource_grants.action,
    mode, context, organization_user_resource_grants.authority_epoch, generation,
    status, organization_user_resource_grants.expires_at
  INTO grant_id, target_workspace_id, target_session_id, action, grant_mode,
    grant_context, authority_epoch, grant_generation, grant_status, expires_at;
  organization_id := p_account_id;
  RETURN NEXT;
END
$$;
$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION list_self_user_resource_authorities(p_account_id uuid, p_workspace_id uuid, p_resource_kind text, p_after_authority_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50) RETURNS TABLE(authority_id uuid, organization_id uuid, resource_kind text, resource_id uuid, origin_workspace_id uuid, authority_generation bigint, authority_status text, grant_id uuid, target_workspace_id uuid, target_session_id uuid, action text, grant_mode text, grant_context text, authority_epoch integer, grant_generation bigint, grant_status text, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $$
#variable_conflict use_column
DECLARE
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  owner_membership_id uuid;
  cursor_created_at timestamptz;
  cursor_id uuid;
BEGIN
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true
  );
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
    OR caller_subject IS NULL
  THEN
    RAISE EXCEPTION 'user-resource authority scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_resource_kind IS NULL OR p_resource_kind NOT IN (
    'connection', 'document', 'variable_set', 'rig', 'connected_machine',
    'subscription_connection'
  ) OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 101 THEN
    RAISE EXCEPTION 'invalid user-resource authority page' USING ERRCODE = '22023';
  END IF;
  -- 0611: every organization is session-tenancy activated.

  SELECT membership.id INTO owner_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = caller_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner membership not found or access denied' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM workspaces workspace_value
  WHERE workspace_value.id = p_workspace_id
    AND workspace_value.account_id = p_account_id
    AND EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.id = owner_membership_id
        AND (
          membership.personal_workspace_id = p_workspace_id
          OR EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_account_id
              AND workspace_membership.workspace_id = p_workspace_id
              AND workspace_membership.subject_id = caller_subject
          )
        )
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner lacks current route-workspace access' USING ERRCODE = '42501';
  END IF;

  IF p_after_authority_id IS NOT NULL THEN
    SELECT authority.created_at, authority.id
      INTO cursor_created_at, cursor_id
    FROM organization_user_resource_authorities authority
    WHERE authority.id = p_after_authority_id
      AND authority.account_id = p_account_id
      AND authority.organization_membership_id = owner_membership_id
      AND authority.resource_kind = p_resource_kind;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid user-resource authority cursor' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN QUERY
  WITH authority_page AS MATERIALIZED (
    SELECT authority.*
    FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = owner_membership_id
      AND authority.resource_kind = p_resource_kind
      AND (
        p_after_authority_id IS NULL
        OR (authority.created_at, authority.id) > (cursor_created_at, cursor_id)
      )
    ORDER BY authority.created_at, authority.id
    LIMIT p_limit
  )
  SELECT authority.id, authority.account_id, authority.resource_kind,
    authority.resource_id, authority.origin_workspace_id, authority.generation,
    authority.status, grant_value.id, grant_value.workspace_id,
    grant_value.session_id, grant_value.action, grant_value.mode,
    grant_value.context, grant_value.authority_epoch, grant_value.generation,
    CASE
      WHEN grant_value.status = 'active'
        AND grant_value.expires_at IS NOT NULL
        AND grant_value.expires_at <= clock_timestamp()
      THEN 'expired'
      ELSE grant_value.status
    END,
    grant_value.expires_at
  FROM authority_page authority
  LEFT JOIN organization_user_resource_grants grant_value
    ON grant_value.account_id = authority.account_id
   AND grant_value.authority_id = authority.id
   AND grant_value.owner_organization_membership_id = owner_membership_id
   AND grant_value.workspace_id = p_workspace_id
   AND grant_value.action = CASE authority.resource_kind
     WHEN 'connection' THEN 'connection.use'
     WHEN 'document' THEN 'document.read'
     WHEN 'variable_set' THEN 'variable_set.use'
     WHEN 'rig' THEN 'rig.use'
     WHEN 'connected_machine' THEN 'connected_machine.use'
     WHEN 'subscription_connection' THEN 'subscription_connection.use'
     ELSE NULL
   END
  ORDER BY authority.created_at, authority.id, grant_value.created_at, grant_value.id;
END
$$;
$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.subscription_core_acceptance_authority_v2(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_accepting_subject_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $$
    DECLARE
      request_subject text := nullif(current_setting('opengeni.subject_id', true), '');
      owner_subject text;
      owner_membership uuid;
      creator_kind text;
      creator_subject text;
      private_session boolean;
      shared_workspace boolean;
      explicit_personal boolean := false;
      membership_ok boolean := false;
      minted_lifecycle boolean := false;
      prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
      generations bigint[];
      restricted_entry jsonb;
      empty_v2 constant jsonb := '{"version":2,"personal":[]}'::jsonb;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_session_id IS NULL
      THEN RETURN NULL; END IF;

      IF NOT EXISTS (
        SELECT 1 FROM subscription_provider_cutovers cutover
        JOIN opengeni_private.subscription_core_providers registry ON registry.provider = cutover.provider
        WHERE cutover.account_id = p_account_id AND cutover.provider = p_provider
          AND cutover.enabled
      ) THEN RETURN NULL; END IF;

      IF p_accepting_subject_id IS NULL OR length(btrim(p_accepting_subject_id)) = 0 THEN
        RETURN empty_v2;
      END IF;

      SELECT session.owner_subject_id, session.owner_organization_membership_id,
        session.created_by_kind, session.created_by_subject_id,
        session.visibility = 'user_private'
        INTO owner_subject, owner_membership, creator_kind, creator_subject, private_session
      FROM sessions session
      WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
        AND session.id = p_session_id
        AND session_reference_visible(p_account_id, p_workspace_id, p_session_id);
      IF NOT FOUND OR owner_subject IS NULL OR owner_membership IS NULL
      THEN RETURN empty_v2; END IF;
      shared_workspace := get_workspace_kind(p_account_id, p_workspace_id) = 'shared';

      -- In a shared workspace, a signed-in person's own account is reachable
      -- only through a restricted entry for this session and one connection:
      -- their explicit choice in a shared chat, or else the account they
      -- turned on for their own turns in this workspace. In an Only me chat an
      -- explicit choice of one of their own accounts keeps the owner entry
      -- below, which already serves it.
      IF shared_workspace
        AND p_accepting_subject_id LIKE 'user:%%'
        AND request_subject IS NOT DISTINCT FROM p_accepting_subject_id
        AND (private_session IS FALSE OR owner_subject = p_accepting_subject_id)
        AND coalesce(opengeni_private.subscription_provider_cutover_committed(p_provider), false)
        AND coalesce((subscription_effective_settings(p_account_id, p_workspace_id)
          #>> '{values,personalConnectionsAllowed}')::boolean, false)
      THEN
        PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
          'organization_membership_lifecycle', true);
        IF private_session IS FALSE THEN
          SELECT jsonb_build_object('provider', p_provider,
            'ownerMembershipId', membership.id::text,
            'authorityGeneration', connection.authority_generation,
            'sharedSessionChoice', jsonb_build_object('sessionId', p_session_id::text,
              'connectionId', connection.id::text)) INTO restricted_entry
          FROM subscription_session_bindings binding
          JOIN subscription_connections connection ON connection.account_id = binding.account_id
            AND connection.id = binding.connection_id AND connection.provider = binding.provider
          JOIN organization_memberships membership ON membership.account_id = connection.account_id
            AND membership.id = connection.owner_organization_membership_id
            AND membership.subject_id = p_accepting_subject_id
            AND membership.status = 'active' AND membership.revoked_at IS NULL
          JOIN organization_user_resource_authorities authority ON authority.id = connection.authority_id
            AND authority.account_id = connection.account_id AND authority.organization_membership_id = membership.id
            AND authority.resource_kind = 'subscription_connection' AND authority.resource_id = connection.id
            AND authority.generation = connection.authority_generation
            AND authority.status = 'active' AND authority.revoked_at IS NULL
          WHERE binding.account_id = p_account_id AND binding.workspace_id = p_workspace_id
            AND binding.session_id = p_session_id AND binding.provider = p_provider AND binding.choice = 'explicit'
            AND connection.ownership = 'personal' AND connection.owner_subject_id = p_accepting_subject_id
            AND connection.kind = opengeni_private.subscription_core_connection_kind(p_provider)
            AND connection.status IN ('active', 'error')
            AND EXISTS (SELECT 1 FROM workspace_memberships participant
              WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
                AND participant.subject_id = p_accepting_subject_id)
            AND EXISTS (SELECT 1 FROM organization_memberships session_owner
              WHERE session_owner.account_id = p_account_id AND session_owner.id = owner_membership
                AND session_owner.subject_id = owner_subject
                AND session_owner.status = 'active' AND session_owner.revoked_at IS NULL);
        ELSE
          SELECT EXISTS (
            SELECT 1 FROM subscription_session_bindings binding
            JOIN subscription_connections bound ON bound.account_id = binding.account_id
              AND bound.id = binding.connection_id AND bound.provider = binding.provider
            WHERE binding.account_id = p_account_id AND binding.workspace_id = p_workspace_id
              AND binding.session_id = p_session_id AND binding.provider = p_provider
              AND binding.choice = 'explicit' AND bound.ownership = 'personal'
          ) INTO explicit_personal;
        END IF;

        -- The account this person turned on for their own turns here. Only a
        -- runtime that sends the receipt below can read the entry, so an older
        -- runtime keeps its previous result instead of failing the turn.
        IF restricted_entry IS NULL AND NOT explicit_personal
          AND current_setting('opengeni.shared_personal_choice_v1', true) = '1'
        THEN
          SELECT jsonb_build_object('provider', p_provider,
            'ownerMembershipId', membership.id::text,
            'authorityGeneration', connection.authority_generation,
            'sharedSessionChoice', jsonb_build_object('sessionId', p_session_id::text,
              'connectionId', connection.id::text)) INTO restricted_entry
          FROM subscription_connections connection
          JOIN organization_memberships membership ON membership.account_id = connection.account_id
            AND membership.id = connection.owner_organization_membership_id
            AND membership.subject_id = p_accepting_subject_id
            AND membership.status = 'active' AND membership.revoked_at IS NULL
          JOIN organization_user_resource_authorities authority ON authority.id = connection.authority_id
            AND authority.account_id = connection.account_id AND authority.organization_membership_id = membership.id
            AND authority.resource_kind = 'subscription_connection' AND authority.resource_id = connection.id
            AND authority.generation = connection.authority_generation
            AND authority.status = 'active' AND authority.revoked_at IS NULL
          JOIN organization_user_resource_grants grant_value ON grant_value.account_id = connection.account_id
            AND grant_value.authority_id = authority.id
            AND grant_value.owner_organization_membership_id = membership.id
            AND grant_value.workspace_id = p_workspace_id
            AND grant_value.action = 'subscription_connection.use'
            AND grant_value.mode = 'always' AND grant_value.context = 'workspace_shared'
            AND grant_value.status = 'active' AND grant_value.revoked_at IS NULL
            AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
          WHERE connection.account_id = p_account_id AND connection.provider = p_provider
            AND connection.ownership = 'personal' AND connection.owner_subject_id = p_accepting_subject_id
            AND connection.kind = opengeni_private.subscription_core_connection_kind(p_provider)
            AND connection.status IN ('active', 'error')
            AND EXISTS (SELECT 1 FROM workspace_memberships participant
              WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
                AND participant.subject_id = p_accepting_subject_id)
            AND EXISTS (SELECT 1 FROM organization_memberships session_owner
              WHERE session_owner.account_id = p_account_id AND session_owner.id = owner_membership
                AND session_owner.subject_id = owner_subject
                AND session_owner.status = 'active' AND session_owner.revoked_at IS NULL)
          ORDER BY (connection.status = 'active') DESC, grant_value.created_at, connection.id
          LIMIT 1;
        END IF;
        PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
          coalesce(prior_lifecycle, ''), true);
      END IF;

      IF private_session IS FALSE AND shared_workspace THEN
        IF restricted_entry IS NULL THEN RETURN empty_v2; END IF;
        -- An old writer must not emit an authority its readers cannot parse.
        -- This is the transaction-local runtime protocol receipt, not a
        -- workspace feature switch or permission selected by the caller.
        IF current_setting('opengeni.shared_personal_choice_v1', true) IS DISTINCT FROM '1' THEN
          RAISE EXCEPTION 'shared personal choice requires an OpenGeni 0736-compatible runtime'
            USING ERRCODE = '55000';
        END IF;
        RETURN jsonb_build_object('version', 2, 'personal', jsonb_build_array(restricted_entry));
      END IF;
      IF restricted_entry IS NOT NULL THEN
        RETURN jsonb_build_object('version', 2, 'personal', jsonb_build_array(restricted_entry));
      END IF;

      IF owner_subject IS DISTINCT FROM p_accepting_subject_id THEN RETURN empty_v2; END IF;

      IF request_subject IS NOT NULL THEN
        IF request_subject IS DISTINCT FROM p_accepting_subject_id THEN RETURN empty_v2; END IF;
      ELSIF creator_kind IS DISTINCT FROM 'subject' OR creator_subject IS DISTINCT FROM owner_subject THEN
        RETURN empty_v2;
      END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'lifecycle', p_account_id)
      ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id) DO NOTHING
      RETURNING true INTO minted_lifecycle;
      minted_lifecycle := coalesce(minted_lifecycle, false);

      SELECT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = owner_membership AND membership.account_id = p_account_id
          AND membership.subject_id = owner_subject
          AND membership.status = 'active' AND membership.revoked_at IS NULL
          AND (private_session OR membership.personal_workspace_id = p_workspace_id)
      ) INTO membership_ok;

      IF membership_ok THEN
        PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
          'organization_membership_lifecycle', true);
        SELECT coalesce(array_agg(DISTINCT authority.generation ORDER BY authority.generation), '{}')
          INTO generations
        FROM subscription_connections connection
        JOIN organization_user_resource_authorities authority
          ON authority.id = connection.authority_id
          AND authority.account_id = connection.account_id
          AND authority.resource_kind = 'subscription_connection'
          AND authority.resource_id = connection.id
        WHERE connection.account_id = p_account_id
          AND connection.provider = p_provider AND connection.kind = opengeni_private.subscription_core_connection_kind(p_provider)
          AND connection.ownership = 'personal'
          AND connection.owner_organization_membership_id = owner_membership
          AND connection.owner_subject_id = owner_subject
          AND connection.status IN ('active', 'error')
          AND connection.authority_generation = authority.generation
          AND authority.organization_membership_id = owner_membership
          AND authority.status = 'active' AND authority.revoked_at IS NULL;
        PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
          coalesce(prior_lifecycle, ''), true);
      END IF;

      IF minted_lifecycle THEN
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'lifecycle' AND capability.account_id = p_account_id;
      END IF;

      IF NOT membership_ok OR cardinality(generations) <> 1 THEN RETURN empty_v2; END IF;
      RETURN jsonb_build_object(
        'version', 2,
        'personal', jsonb_build_array(jsonb_build_object(
          'provider', p_provider,
          'ownerMembershipId', owner_membership::text,
          'authorityGeneration', generations[1]
        ))
      );
    END
    $$;
$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.guard_subscription_connection_reference() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $$
DECLARE
  session_owner text;
  session_owner_membership uuid;
  turn_human text;
  target subscription_connections%%ROWTYPE;
  visible boolean;
  personal_authorized boolean := false;
  ownerless_session boolean := false;
BEGIN
  IF NEW.connection_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR NEW.workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    OR NOT session_reference_visible(NEW.account_id, NEW.workspace_id, NEW.session_id)
  THEN
    RAISE EXCEPTION 'subscription connection target is outside the visible session'
      USING ERRCODE = '42501';
  END IF;
  SELECT session.owner_subject_id, session.owner_organization_membership_id
    INTO session_owner, session_owner_membership
  FROM sessions session
  WHERE session.account_id = NEW.account_id AND session.workspace_id = NEW.workspace_id
    AND session.id = NEW.session_id;
  IF NOT FOUND OR (session_owner IS NULL) <> (session_owner_membership IS NULL) THEN
    RAISE EXCEPTION 'subscription session owner authority is unavailable or malformed'
      USING ERRCODE = '42501';
  END IF;
  ownerless_session := session_owner IS NULL;

  IF TG_TABLE_NAME = 'subscription_leases' THEN
    SELECT turn.initiating_human_subject_id INTO turn_human
    FROM session_turns turn
    WHERE turn.account_id = NEW.account_id AND turn.workspace_id = NEW.workspace_id
      AND turn.session_id = NEW.session_id AND turn.id = NEW.turn_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'subscription lease turn is not in the referenced session'
        USING ERRCODE = '42501';
    END IF;
    IF ownerless_session THEN
      IF NOT opengeni_private.authorize_subscription_ownerless_session_access(
        NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id
      ) THEN
        RAISE EXCEPTION 'ownerless subscription lease turn is not authorized for this session'
          USING ERRCODE = '42501';
      END IF;
    ELSIF turn_human IS NULL THEN
      IF NOT opengeni_private.authorize_subscription_service_session_access(
        NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id, session_owner
      ) THEN
        RAISE EXCEPTION 'non-human subscription lease turn is not authorized for this session'
          USING ERRCODE = '42501';
      END IF;
      turn_human := session_owner;
    ELSIF NOT opengeni_private.authorize_subscription_session_access(
      NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id, session_owner, turn_human
    ) THEN
      RAISE EXCEPTION 'subscription lease turn is not authorized for this session'
        USING ERRCODE = '42501';
    END IF;
    IF NOT ownerless_session THEN
      personal_authorized := opengeni_private.authorize_subscription_personal_access(
        NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id, NEW.connection_id,
        NEW.provider, session_owner, turn_human
      );
    END IF;
  ELSE
    -- Bindings have no turn id, so there is no exact ownerless turn to verify.
    -- Keep ownerless binding writes fail-closed until that contract is explicit.
    IF ownerless_session THEN
      RAISE EXCEPTION 'ownerless subscription bindings require an exact accepted turn'
        USING ERRCODE = '42501';
    END IF;
    turn_human := nullif(current_setting('opengeni.initiating_human_subject_id', true), '');
    IF turn_human IS NULL THEN
      RAISE EXCEPTION 'subscription binding requires an initiating human'
        USING ERRCODE = '42501';
    END IF;
    INSERT INTO opengeni_private.subscription_runtime_capabilities (
      backend_pid, transaction_id, capability_kind, account_id, workspace_id,
      session_id, connection_id, provider, session_owner_subject_id, turn_human_subject_id
    ) VALUES (
      pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'binding_access',
      NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.connection_id, NEW.provider,
      session_owner, turn_human
    )
    ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
    DO UPDATE SET workspace_id = EXCLUDED.workspace_id, session_id = EXCLUDED.session_id,
      provider = EXCLUDED.provider,
      session_owner_subject_id = EXCLUDED.session_owner_subject_id,
      turn_human_subject_id = EXCLUDED.turn_human_subject_id;
    PERFORM pg_catalog.set_config('opengeni.session_owner_subject_id', session_owner, true);
    PERFORM pg_catalog.set_config('opengeni.turn_human_subject_id', turn_human, true);
  END IF;

  SELECT connection.* INTO target
  FROM subscription_connections connection
  WHERE connection.account_id = NEW.account_id AND connection.id = NEW.connection_id
    AND connection.provider = NEW.provider AND connection.status = 'active';
  IF NOT FOUND OR NOT opengeni_private.subscription_connection_visible(
    NEW.account_id, NEW.workspace_id, target.id, target.ownership, target.scope_kind,
    target.owner_organization_membership_id, target.owner_subject_id, target.provider
  ) THEN
    RAISE EXCEPTION 'subscription connection is not in the session eligible pool'
      USING ERRCODE = '42501';
  END IF;
  IF ownerless_session AND (target.ownership <> 'shared'
    OR target.scope_kind NOT IN ('organization', 'workspaces')) THEN
    RAISE EXCEPTION 'ownerless subscription sessions require organization- or workspace-scoped shared connections'
      USING ERRCODE = '42501';
  END IF;
  IF target.ownership = 'personal' AND TG_TABLE_NAME = 'subscription_leases'
    AND (ownerless_session OR NOT personal_authorized OR NOT coalesce((subscription_effective_settings(
      NEW.account_id, NEW.workspace_id
    ) #>> '{values,personalConnectionsAllowed}')::boolean, false)) THEN
    RAISE EXCEPTION 'personal subscription lease lacks current settings or frozen user authority'
      USING ERRCODE = '42501';
  END IF;
  IF target.ownership = 'personal' AND TG_TABLE_NAME = 'subscription_session_bindings' THEN
    SELECT EXISTS (
      SELECT 1 FROM sessions session
      JOIN organization_memberships membership ON membership.account_id = session.account_id
        AND membership.id = target.owner_organization_membership_id
        AND membership.subject_id = turn_human
      JOIN organization_user_resource_authorities authority
        ON authority.id = target.authority_id AND authority.account_id = target.account_id
        AND authority.organization_membership_id = membership.id
        AND authority.resource_kind = target.authority_resource_kind
        AND authority.resource_id = target.id
        AND authority.generation = target.authority_generation
        AND authority.status = 'active' AND authority.revoked_at IS NULL
      WHERE session.account_id = NEW.account_id AND session.workspace_id = NEW.workspace_id
        AND session.id = NEW.session_id AND target.owner_subject_id = turn_human
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND (
          (session.owner_subject_id = turn_human
            AND (session.visibility = 'user_private' OR membership.personal_workspace_id = NEW.workspace_id))
          OR (session.visibility = 'workspace_shared'
            AND turn_human LIKE 'user:%%'
            AND EXISTS (SELECT 1 FROM workspace_memberships participant
              WHERE participant.account_id = NEW.account_id AND participant.workspace_id = NEW.workspace_id
                AND participant.subject_id = turn_human)
            AND ((NEW.choice = 'explicit'
                AND nullif(current_setting('opengeni.subject_id', true), '') = turn_human)
              OR EXISTS (SELECT 1 FROM opengeni_private.subscription_runtime_capabilities accepted
                WHERE accepted.backend_pid = pg_catalog.pg_backend_pid()
                  AND accepted.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
                  AND accepted.capability_kind = 'personal_access'
                  AND accepted.account_id = NEW.account_id AND accepted.workspace_id = NEW.workspace_id
                  AND accepted.session_id = NEW.session_id AND accepted.turn_id IS NOT NULL
                  AND accepted.connection_id = target.id AND accepted.provider = target.provider
                  AND accepted.session_owner_subject_id = session_owner
                  AND accepted.turn_human_subject_id = turn_human
                  -- An automatic binding needs the placed turn to have frozen
                  -- this exact account for this session: the person's own
                  -- account turned on in this workspace (D-53).
                  AND (NEW.choice = 'explicit' OR EXISTS (
                    SELECT 1 FROM session_turns turn,
                      jsonb_array_elements(CASE
                        WHEN jsonb_typeof(turn.subscription_authority->'personal') = 'array'
                        THEN turn.subscription_authority->'personal' ELSE '[]'::jsonb
                      END) entry
                    WHERE turn.account_id = accepted.account_id
                      AND turn.workspace_id = accepted.workspace_id
                      AND turn.session_id = accepted.session_id AND turn.id = accepted.turn_id
                      AND turn.initiating_human_subject_id = turn_human
                      AND entry->>'provider' = target.provider
                      AND entry->'sharedSessionChoice'->>'sessionId' = NEW.session_id::text
                      AND entry->'sharedSessionChoice'->>'connectionId' = target.id::text)))))
        )
    ) INTO visible;
    IF NOT visible OR NOT coalesce((subscription_effective_settings(
      NEW.account_id, NEW.workspace_id
    ) #>> '{values,personalConnectionsAllowed}')::boolean, false) THEN
      RAISE EXCEPTION 'personal subscription connection is not eligible for this session'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
$create$, data_schema);
END
$install$;

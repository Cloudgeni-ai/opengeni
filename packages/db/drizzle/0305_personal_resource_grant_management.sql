-- deployment-mode: rolling
-- Harden owner-managed personal-resource grants behind the activated session-
-- tenancy product boundary. Old lifecycle signatures are revoked from the
-- runtime role so rolling old callers fail closed rather than retain ambient
-- cross-workspace inventory or caller-selected action authority.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- This table is FORCE-RLS. Production migrations run as its NOSUPERUSER,
-- NOBYPASSRLS owner without tenant GUCs, so the owner must be made visible for
-- this exact transactional backfill window. Ordinary roles remain policy-bound.
ALTER TABLE "organization_user_resource_grants" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_resource_authorities" NO FORCE ROW LEVEL SECURITY;

-- Sparse upgrade fixtures may predate the action-contract trigger. When it is
-- present, retain its exact enabled mode across this transactional maintenance
-- window instead of assuming the ordinary-origin state.
DO $migration$
DECLARE
  prior_trigger_state text;
BEGIN
  SELECT trigger_value.tgenabled::text
  INTO prior_trigger_state
  FROM pg_catalog.pg_trigger trigger_value
  WHERE trigger_value.tgrelid = 'organization_user_resource_grants'::regclass
    AND trigger_value.tgname = 'organization_user_resource_grants_action_contract'
    AND NOT trigger_value.tgisinternal;

  PERFORM pg_catalog.set_config(
    'opengeni.migration_0305_action_contract_trigger_state',
    coalesce(prior_trigger_state, 'missing'),
    true
  );
  IF prior_trigger_state IS NOT NULL AND prior_trigger_state <> 'D' THEN
    ALTER TABLE "organization_user_resource_grants"
      DISABLE TRIGGER organization_user_resource_grants_action_contract;
  END IF;
END
$migration$;

UPDATE "organization_user_resource_grants"
SET status = 'expired', updated_at = clock_timestamp()
WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= clock_timestamp();

-- Old generic issue callers could author an arbitrary action. Preserve those
-- rows as history, but settle every still-active mismatch so it can never be
-- admitted as authority under a different resource kind.
UPDATE "organization_user_resource_grants" grant_value
SET status = 'revoked', revoked_at = coalesce(grant_value.revoked_at, clock_timestamp()),
    generation = grant_value.generation + 1, updated_at = clock_timestamp()
FROM "organization_user_resource_authorities" authority
WHERE authority.id = grant_value.authority_id
  AND authority.account_id = grant_value.account_id
  AND grant_value.status = 'active'
  AND grant_value.action IS DISTINCT FROM CASE authority.resource_kind
    WHEN 'connection' THEN 'connection.use'
    WHEN 'document' THEN 'document.read'
    WHEN 'variable_set' THEN 'variable_set.use'
    WHEN 'rig' THEN 'rig.use'
    WHEN 'connected_machine' THEN 'connected_machine.use'
    ELSE NULL
  END;

ALTER TABLE "organization_user_resource_grants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_resource_authorities" FORCE ROW LEVEL SECURITY;
DO $migration$
DECLARE
  prior_trigger_state text := pg_catalog.current_setting(
    'opengeni.migration_0305_action_contract_trigger_state', true
  );
BEGIN
  IF prior_trigger_state = 'O' THEN
    ALTER TABLE "organization_user_resource_grants"
      ENABLE TRIGGER organization_user_resource_grants_action_contract;
  ELSIF prior_trigger_state = 'D' THEN
    ALTER TABLE "organization_user_resource_grants"
      DISABLE TRIGGER organization_user_resource_grants_action_contract;
  ELSIF prior_trigger_state = 'R' THEN
    ALTER TABLE "organization_user_resource_grants"
      ENABLE REPLICA TRIGGER organization_user_resource_grants_action_contract;
  ELSIF prior_trigger_state = 'A' THEN
    ALTER TABLE "organization_user_resource_grants"
      ENABLE ALWAYS TRIGGER organization_user_resource_grants_action_contract;
  ELSIF prior_trigger_state IS DISTINCT FROM 'missing' THEN
    RAISE EXCEPTION 'invalid saved action-contract trigger state'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Runtime management remains lifecycle-only under FORCE RLS. The application
-- role still has zero table privileges; these policy branches are reachable
-- only inside the constrained SECURITY DEFINER routines below.
ALTER POLICY organization_tenancy_lifecycle ON "organization_memberships"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN (
      'managed_human_provisioning',
      'session_visibility_activation',
      'organization_membership_lifecycle',
      'personal_resource_grant_management'
    ))
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN (
      'managed_human_provisioning',
      'session_visibility_activation',
      'organization_membership_lifecycle',
      'personal_resource_grant_management'
    ));
ALTER POLICY organization_tenancy_lifecycle ON "organization_user_resource_authorities"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN (
      'managed_human_provisioning',
      'organization_membership_lifecycle',
      'personal_resource_grant_management'
    ))
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN (
      'managed_human_provisioning',
      'organization_membership_lifecycle',
      'personal_resource_grant_management'
    ));
ALTER POLICY organization_tenancy_lifecycle ON "organization_user_resource_grants"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN (
      'managed_human_provisioning',
      'session_visibility_activation',
      'organization_membership_lifecycle',
      'personal_resource_grant_management'
    ))
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN (
      'managed_human_provisioning',
      'session_visibility_activation',
      'organization_membership_lifecycle',
      'personal_resource_grant_management'
    ));

CREATE OR REPLACE FUNCTION list_self_user_resource_authorities(
  p_account_id uuid,
  p_workspace_id uuid,
  p_resource_kind text,
  p_after_authority_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS TABLE (
  authority_id uuid, organization_id uuid, resource_kind text, resource_id uuid,
  origin_workspace_id uuid, authority_generation bigint, authority_status text,
  grant_id uuid, target_workspace_id uuid, target_session_id uuid, action text,
  grant_mode text, grant_context text, authority_epoch integer,
  grant_generation bigint, grant_status text, expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
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
    'connection', 'document', 'variable_set', 'rig', 'connected_machine'
  ) OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 101 THEN
    RAISE EXCEPTION 'invalid user-resource authority page' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM session_tenancy_activations activation
    WHERE activation.account_id = p_account_id AND activation.activation_version = 1
  ) THEN
    RAISE EXCEPTION 'session tenancy product is not activated' USING ERRCODE = '42501';
  END IF;

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
     ELSE NULL
   END
  ORDER BY authority.created_at, authority.id, grant_value.created_at, grant_value.id;
END
$body$;

CREATE OR REPLACE FUNCTION issue_self_user_resource_grant(
  p_account_id uuid,
  p_authority_id uuid,
  p_workspace_id uuid,
  p_resource_kind text,
  p_mode text,
  p_context text,
  p_session_id uuid DEFAULT NULL,
  p_expected_authority_epoch integer DEFAULT NULL,
  p_workspace_shared_acknowledged boolean DEFAULT false
) RETURNS TABLE (
  grant_id uuid, organization_id uuid, authority_generation bigint,
  target_workspace_id uuid, target_session_id uuid, action text,
  grant_mode text, grant_context text, authority_epoch integer,
  grant_generation bigint, grant_status text, expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
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
    WHEN 'connection' THEN 'connection.use'
    WHEN 'document' THEN 'document.read'
    WHEN 'variable_set' THEN 'variable_set.use'
    WHEN 'rig' THEN 'rig.use'
    WHEN 'connected_machine' THEN 'connected_machine.use'
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
  IF NOT EXISTS (
    SELECT 1 FROM session_tenancy_activations activation
    WHERE activation.account_id = p_account_id AND activation.activation_version = 1
  ) THEN
    RAISE EXCEPTION 'session tenancy product is not activated' USING ERRCODE = '42501';
  END IF;

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
$body$;

CREATE OR REPLACE FUNCTION revoke_self_user_resource_grant(
  p_account_id uuid,
  p_workspace_id uuid,
  p_grant_id uuid
) RETURNS TABLE (
  grant_id uuid, grant_generation bigint, grant_status text, revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
#variable_conflict use_column
DECLARE
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  owner_membership_id uuid;
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
    RAISE EXCEPTION 'user-resource revoke scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM session_tenancy_activations activation
    WHERE activation.account_id = p_account_id AND activation.activation_version = 1
  ) THEN
    RAISE EXCEPTION 'session tenancy product is not activated' USING ERRCODE = '42501';
  END IF;
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

  UPDATE organization_user_resource_grants grant_value
  SET status = 'revoked', revoked_at = clock_timestamp(),
      generation = grant_value.generation + 1, updated_at = clock_timestamp()
  FROM organization_user_resource_authorities authority
  WHERE grant_value.id = p_grant_id
    AND grant_value.account_id = p_account_id
    AND grant_value.workspace_id = p_workspace_id
    AND authority.id = grant_value.authority_id
    AND authority.account_id = grant_value.account_id
    AND authority.organization_membership_id = owner_membership_id
    AND grant_value.owner_organization_membership_id = owner_membership_id
    AND grant_value.status <> 'revoked'
  RETURNING grant_value.id, grant_value.generation, grant_value.status, grant_value.revoked_at
  INTO grant_id, grant_generation, grant_status, revoked_at;
  IF FOUND THEN RETURN NEXT; RETURN; END IF;

  SELECT grant_value.id, grant_value.generation, grant_value.status, grant_value.revoked_at
    INTO grant_id, grant_generation, grant_status, revoked_at
  FROM organization_user_resource_grants grant_value
  JOIN organization_user_resource_authorities authority
    ON authority.id = grant_value.authority_id AND authority.account_id = grant_value.account_id
  WHERE grant_value.id = p_grant_id
    AND grant_value.account_id = p_account_id
    AND grant_value.workspace_id = p_workspace_id
    AND authority.organization_membership_id = owner_membership_id
    AND grant_value.owner_organization_membership_id = owner_membership_id
    AND grant_value.status = 'revoked';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'self-owned user-resource grant not found' USING ERRCODE = '42501';
  END IF;
  RETURN NEXT;
END
$body$;

-- `SET search_path FROM CURRENT` captures the target schema during function
-- creation. Replace that broad migration path with the exact immutable runtime
-- path before this transaction can commit.
DO $harden_runtime_search_paths$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.list_self_user_resource_authorities(uuid, uuid, text, uuid, integer) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.issue_self_user_resource_grant(uuid, uuid, uuid, text, text, text, uuid, integer, boolean) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.revoke_self_user_resource_grant(uuid, uuid, uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END
$harden_runtime_search_paths$;

REVOKE ALL ON FUNCTION list_self_user_resource_authorities(uuid, uuid, text, uuid, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION issue_self_user_resource_grant(
  uuid, uuid, uuid, text, text, text, uuid, integer, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_self_user_resource_grant(uuid, uuid, uuid) FROM PUBLIC;

DO $runtime_grants$
DECLARE
  legacy_signature text;
  legacy_function regprocedure;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    FOREACH legacy_signature IN ARRAY ARRAY[
      'list_self_user_resource_authorities(uuid)',
      'issue_self_user_resource_grant(uuid,uuid,uuid,text,text,text,uuid,boolean)',
      'revoke_self_user_resource_grant(uuid,uuid)',
      'list_self_connection_authorities(uuid)',
      'issue_self_connection_use_grant(uuid,uuid,uuid,text,text,uuid,boolean)',
      'revoke_self_connection_use_grant(uuid,uuid)'
    ]
    LOOP
      legacy_function := pg_catalog.to_regprocedure(
        pg_catalog.format('%I.%s', pg_catalog.current_schema(), legacy_signature)
      );
      IF legacy_function IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM opengeni_app', legacy_function
        );
      END IF;
    END LOOP;

    GRANT EXECUTE ON FUNCTION
      list_self_user_resource_authorities(uuid, uuid, text, uuid, integer)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION issue_self_user_resource_grant(
      uuid, uuid, uuid, text, text, text, uuid, integer, boolean
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION revoke_self_user_resource_grant(uuid, uuid, uuid)
      TO opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_authorities FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_grants FROM opengeni_app;
  END IF;
END
$runtime_grants$;

COMMENT ON FUNCTION list_self_user_resource_authorities(uuid, uuid, text, uuid, integer) IS
  'Bounded owner-only personal-resource page filtered to one kind and route workspace.';
COMMENT ON FUNCTION issue_self_user_resource_grant(
  uuid, uuid, uuid, text, text, text, uuid, integer, boolean
) IS 'Issues server-action-derived session/always grants after exact owner and tenancy fences.';
COMMENT ON FUNCTION revoke_self_user_resource_grant(uuid, uuid, uuid) IS
  'Idempotently revokes an exact owner grant only through its route workspace.';

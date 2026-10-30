-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: reads only personal login authorities and workspace memberships, a few rows per person
-- A person's own login (a personal, subject-scoped connection such as their
-- Gmail or Linear) works for the messages they send themselves in their
-- Personal workspace and in each shared workspace where it is turned on
-- (D-54). "Turned on" is an active `always` grant on the login's existing
-- `connection` authority, for that workspace, with action `connection.use`
-- and context `workspace_shared`, exactly like an own subscription (D-53).
--
-- This migration:
-- 1. teaches the owner-only grant issuer the `connection` kind, so a person
--    can turn their own login on or off in a workspace;
-- 2. turns a new login on in the shared workspace it was added from, whatever
--    path added it, so things start usable where they are added;
-- 3. keeps every place an existing login already works: each shared
--    workspace its owner belongs to.
--
-- Rolling: signatures, owners and grants are unchanged. An older runtime does
-- not read these grants and keeps routing every own login as before.
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
    WHEN 'connection' THEN 'connection.use'
    WHEN 'document' THEN 'document.read'
    WHEN 'variable_set' THEN 'variable_set.use'
    WHEN 'rig' THEN 'rig.use'
    WHEN 'connected_machine' THEN 'connected_machine.use'
    WHEN 'subscription_connection' THEN 'subscription_connection.use'
    ELSE NULL
  END;
  IF p_resource_kind IS NULL OR canonical_action IS NULL
    OR p_mode IS NULL OR p_mode NOT IN ('session', 'always')
    -- An own login is turned on per workspace, never per chat (D-54).
    OR (p_resource_kind = 'connection' AND p_mode <> 'always')
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
CREATE OR REPLACE FUNCTION opengeni_private.turn_on_own_login_where_added() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $$
DECLARE
  previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  -- The owner role reads memberships and writes grants under FORCE ROW LEVEL
  -- SECURITY only inside this lifecycle.
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true
  );
  -- A Personal workspace needs no grant: every own login works there.
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.id = NEW.owner_organization_membership_id
      AND membership.account_id = NEW.account_id
      AND membership.personal_workspace_id = NEW.workspace_id
  ) THEN
    INSERT INTO organization_user_resource_grants (
      account_id, authority_id, owner_organization_membership_id, workspace_id,
      session_id, action, mode, context, authority_epoch, generation, status
    ) VALUES (
      NEW.account_id, NEW.authority_id, NEW.owner_organization_membership_id, NEW.workspace_id,
      NULL, 'connection.use', 'always', 'workspace_shared', NULL, 1, 'active'
    )
    ON CONFLICT DO NOTHING;
  END IF;
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RAISE;
END
$$;
$create$, data_schema);
END
$install$;

REVOKE ALL ON FUNCTION opengeni_private.turn_on_own_login_where_added() FROM PUBLIC;

DROP TRIGGER IF EXISTS connections_turn_on_own_login_where_added ON connections;
CREATE TRIGGER connections_turn_on_own_login_where_added
  AFTER INSERT ON connections
  FOR EACH ROW
  WHEN (
    NEW.authority_scope = 'user'
    AND NEW.authority_id IS NOT NULL
    AND NEW.owner_organization_membership_id IS NOT NULL
  )
  EXECUTE FUNCTION opengeni_private.turn_on_own_login_where_added();

-- Nothing that works today stops working: until now an own login worked in
-- every shared workspace its owner belongs to, so it starts turned on in each
-- of them. The owner turns it off where they don't want it ("Stop using it
-- here" in a shared chat, or the login's row in the workspace's connector).
-- Never their Personal workspace, which needs no grant.
--
-- The migration principal sees no rows under FORCE ROW LEVEL SECURITY, so the
-- read and written tables are relaxed for the owner only, inside this file's
-- single transaction.
ALTER TABLE "organization_memberships" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_resource_authorities" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_resource_grants" NO FORCE ROW LEVEL SECURITY;

INSERT INTO organization_user_resource_grants (
  account_id, authority_id, owner_organization_membership_id, workspace_id,
  session_id, action, mode, context, authority_epoch, generation, status
)
SELECT authority.account_id, authority.id, membership.id, workspace_membership.workspace_id,
  NULL, 'connection.use', 'always', 'workspace_shared', NULL, 1, 'active'
FROM organization_user_resource_authorities authority
JOIN organization_memberships membership
  ON membership.id = authority.organization_membership_id
 AND membership.account_id = authority.account_id
 AND membership.status = 'active' AND membership.revoked_at IS NULL
JOIN workspace_memberships workspace_membership
  ON workspace_membership.account_id = authority.account_id
 AND workspace_membership.subject_id = membership.subject_id
WHERE authority.resource_kind = 'connection'
  AND authority.status = 'active' AND authority.revoked_at IS NULL
  AND membership.personal_workspace_id IS DISTINCT FROM workspace_membership.workspace_id
ON CONFLICT DO NOTHING;

ALTER TABLE "organization_user_resource_grants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_resource_authorities" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;

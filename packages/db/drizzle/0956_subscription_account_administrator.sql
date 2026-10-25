-- deployment-mode: rolling
-- Subscription connections are administered by an organization administrator
-- or by the managing workspace's administrator. The database recognised an
-- organization administrator only through an organization_memberships row
-- with role owner or admin. Account administration also comes from sources
-- that have no such row: a deployment's configured access key, an
-- organization API key with account:admin and a signed delegation carrying
-- account:admin. The API already treats all of them as account
-- administrators, so they passed the route checks and were then refused by the
-- subscription writers and row policies (connect, reconnect, edit, remove).
--
-- The API asserts this authority the same way account-admin document commands
-- do (0339): it passes its request-local account:admin stamp, which the
-- database checks against the transaction's own account and subject. Here
-- the check records a transaction capability, like every other subscription
-- runtime capability, and subscription_organization_admin() honours it:
--
-- 1. Capability kind 'account_administrator': one row per transaction,
--    account and subject. The constraints are replaced NOT VALID; 0957
--    validates them. Every existing row satisfies the new definitions.
-- 2. grant_subscription_account_administrator(stamp): SECURITY DEFINER,
--    executable by the application roles only. It refuses unless the stamp
--    names account:admin for exactly the current opengeni.account_id and
--    opengeni.subject_id. A membership administrator needs no row. A session
--    setting alone never grants anything: the row is keyed by backend and
--    transaction, written only by this routine, and the app role has no table
--    privileges.
-- 3. subscription_organization_admin() also accepts that capability. It
--    reads it without assigning a transaction ID (0847).
-- 4. disconnect_subscription_core_connection(): the shared-connection branch
--    no longer requires a "user:" subject. Its shared authority is
--    subscription_organization_admin() or the managing workspace's
--    administrator, both decided from durable rows; a personal connection
--    still matches only its owning person.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE opengeni_private.subscription_runtime_capabilities
  DROP CONSTRAINT subscription_runtime_capabilities_kind_chk,
  ADD CONSTRAINT subscription_runtime_capabilities_kind_chk
    CHECK (capability_kind IN ('personal_access', 'session_access', 'binding_access', 'lifecycle',
      'designation_management', 'codex_refresh_authorized', 'codex_refresh_write',
      'codex_apps_refresh_authorized', 'codex_connection_refresh_authorized',
      'codex_connection_owner', 'codex_reset_credit_fence',
      'refresh_authorized', 'refresh_write', 'connection_refresh_authorized',
      'connection_owner', 'account_administrator')) NOT VALID;
ALTER TABLE opengeni_private.subscription_runtime_capabilities
  DROP CONSTRAINT subscription_runtime_capabilities_provider_chk,
  ADD CONSTRAINT subscription_runtime_capabilities_provider_chk CHECK (
    (capability_kind = 'personal_access' AND provider IN ('codex','claude','xai')
      AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NOT NULL)
    OR (capability_kind = 'session_access' AND provider IS NULL
      AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND ((session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NOT NULL)
        OR (session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)))
    OR (capability_kind = 'binding_access' AND provider IN ('codex','claude','xai')
      AND session_id IS NOT NULL AND turn_id IS NULL
      AND session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NOT NULL)
    OR (capability_kind = 'lifecycle' AND provider IS NULL AND session_id IS NULL
      AND turn_id IS NULL AND session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)
    OR (capability_kind = 'designation_management' AND provider IS NULL AND session_id IS NULL
      AND turn_id IS NULL AND session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL
      AND workspace_id IS NOT NULL)
    OR (capability_kind IN ('codex_refresh_authorized', 'codex_refresh_write')
      AND provider = 'codex' AND workspace_id IS NOT NULL
      AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND ((session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NOT NULL)
        OR (session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)))
    OR (capability_kind IN ('codex_apps_refresh_authorized', 'codex_connection_refresh_authorized',
        'codex_refresh_write')
      AND provider = 'codex' AND workspace_id IS NOT NULL
      AND session_id IS NULL AND turn_id IS NULL
      AND session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)
    OR (capability_kind IN ('codex_connection_owner', 'codex_reset_credit_fence')
      AND provider = 'codex' AND session_id IS NULL AND turn_id IS NULL
      AND session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NULL)
    OR (capability_kind IN ('refresh_authorized', 'refresh_write')
      AND provider IS NOT NULL AND provider ~ '^[a-z][a-z0-9_]{1,31}$' AND workspace_id IS NOT NULL
      AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND ((session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NOT NULL)
        OR (session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)))
    OR (capability_kind IN ('connection_refresh_authorized', 'refresh_write')
      AND provider IS NOT NULL AND provider ~ '^[a-z][a-z0-9_]{1,31}$' AND workspace_id IS NOT NULL
      AND session_id IS NULL AND turn_id IS NULL
      AND session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)
    OR (capability_kind = 'connection_owner'
      AND provider IS NOT NULL AND provider ~ '^[a-z][a-z0-9_]{1,31}$' AND session_id IS NULL AND turn_id IS NULL
      AND session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NULL)
    OR (capability_kind = 'account_administrator'
      AND provider IS NULL AND workspace_id IS NULL AND session_id IS NULL AND turn_id IS NULL
      AND connection_id = '00000000-0000-0000-0000-000000000000'::uuid
      AND session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NULL)
  ) NOT VALID;

DO $install$
DECLARE
  data_schema text := current_schema();
  definition text;
  anchor constant text := 'opengeni_subscription_internal.subscription_core_writer_context(';
BEGIN
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_private.grant_subscription_account_administrator(p_authorization jsonb)
    RETURNS boolean
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      uuid_pattern constant text :=
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
      context_account text := nullif(pg_catalog.current_setting('opengeni.account_id', true), '');
      context_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
      account uuid;
    BEGIN
      IF context_account IS NULL OR context_account !~ uuid_pattern OR context_subject IS NULL
        OR p_authorization IS NULL OR pg_catalog.jsonb_typeof(p_authorization) <> 'object'
        OR coalesce(p_authorization ->> 'permission', '') <> 'account:admin'
        OR coalesce(p_authorization ->> 'authorizationId', '') !~ uuid_pattern
        OR coalesce(p_authorization ->> 'accountId', '') !~ uuid_pattern
        OR (p_authorization ->> 'accountId')::uuid <> context_account::uuid
        OR (p_authorization ->> 'actorSubjectId') IS DISTINCT FROM context_subject
      THEN
        RAISE EXCEPTION 'subscription administration requires exact account authority'
          USING ERRCODE = '42501';
      END IF;
      account := context_account::uuid;
      -- A membership administrator is already recognised from durable rows.
      IF EXISTS (SELECT 1 FROM organization_memberships membership
        WHERE membership.account_id = account AND membership.subject_id = context_subject
          AND membership.status = 'active' AND membership.revoked_at IS NULL
          AND membership.role IN ('owner', 'admin'))
      THEN
        RETURN false;
      END IF;
      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, session_owner_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'account_administrator',
        account, context_subject
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO UPDATE SET session_owner_subject_id = EXCLUDED.session_owner_subject_id;
      RETURN true;
    END
    $body$
  $definition$, data_schema);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.subscription_organization_admin(p_account_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,%1$I,pg_temp AS $body$
      SELECT coalesce(p_account_id::text = nullif(current_setting('opengeni.account_id',true),'')
        AND nullif(current_setting('opengeni.subject_id',true),'') IS NOT NULL
        AND (EXISTS (SELECT 1 FROM %1$I.organization_memberships membership
            WHERE membership.account_id=p_account_id
              AND membership.subject_id=nullif(current_setting('opengeni.subject_id',true),'')
              AND membership.status='active' AND membership.revoked_at IS NULL
              AND membership.role IN ('owner','admin'))
          OR EXISTS (SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
            WHERE capability.backend_pid=pg_catalog.pg_backend_pid()
              AND capability.transaction_id=pg_catalog.pg_current_xact_id_if_assigned()
              AND capability.capability_kind='account_administrator'
              AND capability.account_id=p_account_id
              AND capability.connection_id='00000000-0000-0000-0000-000000000000'::uuid
              AND capability.session_owner_subject_id
                =nullif(current_setting('opengeni.subject_id',true),''))),false)
    $body$;
  $definition$, data_schema);
  -- CREATE OR REPLACE preserves the function owner and exact EXECUTE grants.

  -- The writer context without the person-only subject rule. Callers keep
  -- their own authority checks; this only binds the call to the transaction's
  -- account, workspace and subject and to an enabled provider cutover.
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_subscription_internal.subscription_core_administration_context(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      SELECT p_account_id IS NOT NULL
        AND p_subject_id IS NOT NULL AND p_subject_id <> ''
        AND p_account_id IS NOT DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        AND p_workspace_id IS NOT DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        AND p_subject_id IS NOT DISTINCT FROM nullif(current_setting('opengeni.subject_id', true), '')
        AND EXISTS (SELECT 1 FROM subscription_provider_cutovers cutover
        JOIN opengeni_private.subscription_core_providers registry ON registry.provider = cutover.provider
          WHERE cutover.account_id = p_account_id AND cutover.provider = p_provider
            AND cutover.enabled)
    $body$
  $definition$, data_schema);

  definition := pg_catalog.pg_get_functiondef(
    'opengeni_private.disconnect_subscription_core_connection(text,uuid,uuid,text,uuid)'::regprocedure);
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor)
    OR strpos(definition, 'IF target.ownership = ''shared'' THEN') = 0
    OR strpos(definition, 'target.owner_subject_id IS DISTINCT FROM p_subject_id') = 0
  THEN
    RAISE EXCEPTION 'unexpected subscription disconnect definition' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor,
    'opengeni_subscription_internal.subscription_core_administration_context(');
END
$install$;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_core_administration_context(
  text, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.grant_subscription_account_administrator(jsonb) FROM PUBLIC;

DO $application_grants$
DECLARE
  data_schema text := current_schema();
  role_name text;
BEGIN
  -- The established application grantees (0900), never capability-only roles.
  FOR role_name IN
    SELECT DISTINCT r.rolname FROM pg_catalog.pg_roles r
    WHERE r.rolname = 'opengeni_app'
      OR r.rolname IN (
        SELECT configured.value FROM pg_catalog.jsonb_array_elements_text(
          coalesce(nullif(pg_catalog.current_setting('opengeni.migration_application_roles',true),''),'[]')::jsonb
        ) configured(value)
      )
      OR r.oid IN (
        SELECT acl.grantee FROM pg_catalog.pg_proc helper
        CROSS JOIN LATERAL pg_catalog.aclexplode(helper.proacl) acl
        WHERE helper.oid = pg_catalog.format(
          '%I.session_private_actor_visible(uuid,uuid,uuid,text)',data_schema
        )::regprocedure
        AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> helper.proowner
      )
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.grant_subscription_account_administrator(jsonb) TO %I',
      role_name);
  END LOOP;
END
$application_grants$;

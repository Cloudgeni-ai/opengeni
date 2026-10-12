-- deployment-mode: rolling
-- The owner's live usage read of their own personal connection (design
-- docs/design/subscription-core-2026-10-07.md, 5.3 "Administered usage reads").
-- A personal connection is invisible outside an exact accepted turn: the
-- 0707 credential seam refuses it in a workspace context, and its owner sees
-- it only through the 0707 owner reader, which returns no credential. A
-- usage refresh by the owner in their own Personal workspace needs the
-- credential, its refresh under the per-connection lock, and the quota
-- write; these three owner-only routines provide exactly that and nothing
-- else.
--
-- Every routine admits only: the writer context of the 0707 owner routines
-- (the transaction's account, workspace and subject settings, a `user:`
-- subject, an enabled cutover of a registered provider); the owner's exact
-- active membership whose Personal workspace is the given workspace (never
-- a shared workspace, never another member, never an ownerless session,
-- which has no subject); a personal connection of the provider's registered
-- kind that this membership owns, not disconnected; and its current
-- authority generation (an active, unrevoked authority of the same
-- membership at the connection's generation). The routines hold the 0707
-- `connection_owner` capability only while they run and drop it before
-- returning.
--
-- 1. `read_subscription_core_owned_connection_credential`: the connection's
--    status, refresh generation, credential (only while active), provider
--    facts and stored quota with its revision.
-- 2. `begin_subscription_core_owned_connection_refresh`: takes the
--    per-connection refresh lock, rechecks, and mints the 0707
--    `connection_refresh_authorized` capability for this exact workspace and
--    connection, which the existing 0707 persist and fail routines consume
--    (unchanged); returns the generation and credential to rotate.
-- 3. `record_subscription_core_owned_connection_quota`: writes one quota
--    observation, fenced on the connection's refresh generation and on the
--    stored quota revision the caller merged from.
--
-- Rolling: three new routines; no table, policy, lock or existing routine
-- changes. Older binaries never call them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $owned_connection_usage$
DECLARE
  data_schema text := current_schema();
  -- The owner check shared by the three routines. It sets `target` and
  -- `owned`; the caller has already checked the writer context.
  owned_check constant text := $owned$
      PERFORM opengeni_subscription_internal.grant_subscription_core_owner_capability(
        p_provider, 'connection_owner', p_account_id, p_workspace_id, p_subject_id,
        '00000000-0000-0000-0000-000000000000'::uuid);
      SELECT connection.* INTO target
      FROM subscription_connections connection
      JOIN organization_memberships membership
        ON membership.account_id = connection.account_id
       AND membership.id = connection.owner_organization_membership_id
      JOIN organization_user_resource_authorities authority
        ON authority.account_id = connection.account_id
       AND authority.id = connection.authority_id
       AND authority.resource_kind = 'subscription_connection'
       AND authority.resource_id = connection.id
       AND authority.organization_membership_id = membership.id
       AND authority.generation = connection.authority_generation
       AND authority.status = 'active' AND authority.revoked_at IS NULL
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = p_provider
        AND connection.kind = opengeni_private.subscription_core_connection_kind(p_provider)
        AND connection.ownership = 'personal' AND connection.disconnected_at IS NULL
        AND connection.owner_subject_id = p_subject_id
        AND membership.subject_id = p_subject_id
        AND membership.personal_workspace_id = p_workspace_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL;
      owned := FOUND;
$owned$;
  writer_context constant text := $context$
      IF p_workspace_id IS NULL OR p_connection_id IS NULL
        OR NOT opengeni_subscription_internal.subscription_core_writer_context(
          p_provider, p_account_id, p_workspace_id, p_subject_id)
$context$;
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.read_subscription_core_owned_connection_credential(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid)
    RETURNS TABLE(status text, refresh_generation bigint, credential_encrypted text, expires_at timestamp with time zone, last_refresh_at timestamp with time zone, provider_account_id text, plan_type text, provider_state jsonb, quota jsonb, quota_revision bigint, quota_observed_refresh_generation bigint, quota_updated_at timestamp with time zone)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      target subscription_connections%%ROWTYPE;
      owned boolean := false;
    BEGIN
      %2$s
      THEN RETURN; END IF;
      %3$s
      IF owned THEN
        status := target.status;
        refresh_generation := target.refresh_generation;
        credential_encrypted := CASE WHEN target.status = 'active'
          THEN target.credential_encrypted END;
        expires_at := target.expires_at;
        last_refresh_at := target.last_refresh_at;
        provider_account_id := target.provider_account_id;
        plan_type := target.plan_type;
        provider_state := coalesce(target.provider_state, '{}'::jsonb);
        SELECT stored.quota, stored.revision::bigint, stored.observed_refresh_generation,
          stored.updated_at
        INTO quota, quota_revision, quota_observed_refresh_generation, quota_updated_at
        FROM subscription_connection_quota stored
        WHERE stored.account_id = p_account_id AND stored.connection_id = target.id;
      END IF;
      PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(
        p_provider, p_account_id);
      IF owned THEN RETURN NEXT; END IF;
    END
    $body$
  $ddl$, data_schema, writer_context, owned_check);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.begin_subscription_core_owned_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid)
    RETURNS TABLE(refresh_generation bigint, credential_encrypted text, expires_at timestamp with time zone)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      target subscription_connections%%ROWTYPE;
      owned boolean := false;
      minted boolean := false;
    BEGIN
      %2$s
      THEN RETURN; END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('subscription-refresh:' || p_connection_id::text, 0)
      );
      %3$s
      IF owned AND target.status = 'active' AND target.credential_encrypted IS NOT NULL THEN
        INSERT INTO opengeni_private.subscription_runtime_capabilities (
          backend_pid, transaction_id, capability_kind, account_id, workspace_id,
          connection_id, provider
        ) VALUES (
          pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(),
          'connection_refresh_authorized', p_account_id, p_workspace_id, target.id, p_provider
        ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
          DO NOTHING
        RETURNING true INTO minted;
      END IF;
      PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(
        p_provider, p_account_id);
      IF minted IS DISTINCT FROM true THEN RETURN; END IF;
      refresh_generation := target.refresh_generation;
      credential_encrypted := target.credential_encrypted;
      expires_at := target.expires_at;
      RETURN NEXT;
    END
    $body$
  $ddl$, data_schema, writer_context, owned_check);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.record_subscription_core_owned_connection_quota(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid, p_refresh_generation bigint, p_expected_revision bigint, p_quota jsonb, p_observed_at timestamp with time zone)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      target subscription_connections%%ROWTYPE;
      owned boolean := false;
      current_revision bigint;
      recorded boolean := false;
    BEGIN
      %2$s
        OR p_refresh_generation IS NULL OR p_refresh_generation < 1
        OR p_quota IS NULL OR pg_catalog.jsonb_typeof(p_quota) IS DISTINCT FROM 'object'
        OR p_observed_at IS NULL
      THEN RETURN false; END IF;
      %3$s
      IF owned AND target.refresh_generation = p_refresh_generation THEN
        SELECT stored.revision::bigint INTO current_revision
        FROM subscription_connection_quota stored
        WHERE stored.account_id = p_account_id AND stored.connection_id = target.id
        FOR UPDATE;
        IF current_revision IS NOT DISTINCT FROM p_expected_revision THEN
          INSERT INTO subscription_connection_quota AS stored (
            account_id, connection_id, quota, observed_refresh_generation, revision, updated_at
          ) VALUES (
            p_account_id, target.id, p_quota, p_refresh_generation, 1, p_observed_at
          )
          ON CONFLICT (connection_id) DO UPDATE
            SET quota = EXCLUDED.quota,
                observed_refresh_generation = EXCLUDED.observed_refresh_generation,
                revision = stored.revision + 1,
                updated_at = EXCLUDED.updated_at
            WHERE stored.account_id = EXCLUDED.account_id
              AND stored.revision = p_expected_revision;
          recorded := FOUND;
        END IF;
      END IF;
      PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(
        p_provider, p_account_id);
      RETURN recorded;
    END
    $body$
  $ddl$, data_schema, writer_context, owned_check);
END
$owned_connection_usage$;

-- PUBLIC loses the default EXECUTE; every configured application role gets
-- it (0713's and 0728's pattern), so the previous release's readiness, which
-- rejects an opengeni_private routine the runtime role cannot execute,
-- passes before provision-roles runs.
DO $owned_connection_usage_grants$
DECLARE
  application_role text;
  routine_signature text;
BEGIN
  FOREACH routine_signature IN ARRAY ARRAY[
    'read_subscription_core_owned_connection_credential(text,uuid,uuid,text,uuid)',
    'begin_subscription_core_owned_connection_refresh(text,uuid,uuid,text,uuid)',
    'record_subscription_core_owned_connection_quota(text,uuid,uuid,text,uuid,bigint,bigint,jsonb,timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%s FROM PUBLIC', routine_signature);
    FOR application_role IN
      SELECT role_value.rolname
      FROM pg_catalog.jsonb_array_elements_text(
        coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
      ) configured(value)
      JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
      UNION SELECT 'opengeni_app'
        WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.%s TO %I',
        routine_signature, application_role);
    END LOOP;
  END LOOP;
END
$owned_connection_usage_grants$;

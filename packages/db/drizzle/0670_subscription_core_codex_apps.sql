-- deployment-mode: rolling
-- M3 PR 2b: the Codex Apps designation on the shared subscription core.
-- Everything here is inert while no Codex cutover row is enabled: every
-- routine returns nothing (or false) unless the account's Codex cutover is
-- enabled, and the capability kinds added below are minted only by these
-- routines. Claude and xAI are untouched. No data moves.
--
-- Apps credentials load by their designation, never through placement
-- (design 6.3). A designation (subscription_apps_designations, written under
-- its existing administrator/delegated-manager policy) names one shared
-- Codex connection for one workspace. At run time the workspace's grant is
-- the only caller context: there is no session, turn or chat lease.
--
-- 1. subscription_codex_apps_designation_target (internal; not granted here,
--    though role provisioning grants every opengeni_private routine, so it
--    exposes no more than read_subscription_codex_apps_credential) returns the designated connection only while the designation still
--    names it, the connection is a shared Codex subscription connection, and
--    it is still in scope for the workspace (organization scope, an exact
--    workspace assignment, or a people assignment whose active member belongs
--    to the workspace, as the designation write policy requires).
-- 2. resolve_subscription_codex_apps_designation returns the designated
--    connection id and health, never credential material (catalog overlays,
--    worker claim and the tool gateway).
-- 3. read_subscription_codex_apps_credential returns the credential of the
--    exact designated, active connection.
-- 4. begin/persist/fail_subscription_codex_apps_refresh are the Codex refresh
--    seam for Apps: begin takes the same per-connection advisory key as chat
--    refresh ('subscription-refresh:<connection id>'), so Apps and chat
--    refreshes of one connection serialize; persist writes only under the
--    refresh-generation compare-and-swap; fail marks needs_relogin under the
--    same compare-and-swap. They mirror the chat seam (0664/0665) with the
--    designation in place of the turn lease.

SET LOCAL lock_timeout = '5s';

ALTER TABLE opengeni_private.subscription_runtime_capabilities
  DROP CONSTRAINT subscription_runtime_capabilities_kind_chk,
  ADD CONSTRAINT subscription_runtime_capabilities_kind_chk
    CHECK (capability_kind IN (
      'personal_access', 'session_access', 'binding_access', 'lifecycle',
      'designation_management', 'codex_refresh_authorized', 'codex_refresh_write',
      'codex_apps_refresh_authorized'
    )),
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
    OR (capability_kind IN ('codex_refresh_authorized', 'codex_refresh_write') AND provider = 'codex'
      AND workspace_id IS NOT NULL AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND ((session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NOT NULL)
        OR (session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)))
    -- Apps refresh is workspace-scoped: no session, turn or person.
    OR (capability_kind IN ('codex_apps_refresh_authorized', 'codex_refresh_write')
      AND provider = 'codex' AND workspace_id IS NOT NULL
      AND session_id IS NULL AND turn_id IS NULL
      AND session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)
  );

DO $codex_apps_designation_target$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_codex_apps_designation_target(
      p_account_id uuid, p_workspace_id uuid
    ) RETURNS SETOF %1$I.subscription_connections
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      designated uuid;
      target subscription_connections%%ROWTYPE;
      in_scope boolean := false;
    BEGIN
      IF p_account_id IS NULL OR p_workspace_id IS NULL
        OR p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      THEN RETURN; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM subscription_provider_cutovers cutover
        WHERE cutover.account_id = p_account_id AND cutover.provider = 'codex'
          AND cutover.enabled
      ) THEN RETURN; END IF;

      SELECT designation.connection_id INTO designated
      FROM subscription_apps_designations designation
      WHERE designation.account_id = p_account_id
        AND designation.workspace_id = p_workspace_id;
      IF designated IS NULL THEN RETURN; END IF;

      -- The designation write policy already proved scope when it was
      -- written; this exposes exactly that row to this function's reads and
      -- is removed before returning.
      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id, connection_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(),
        'designation_management', p_account_id, p_workspace_id, designated
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING;

      SELECT connection.* INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = designated
        AND connection.provider = 'codex' AND connection.kind = 'subscription'
        AND connection.ownership = 'shared';
      IF FOUND THEN
        in_scope := target.scope_kind = 'organization'
          OR (target.scope_kind = 'workspaces' AND EXISTS (
            SELECT 1 FROM subscription_connection_workspaces assignment
            WHERE assignment.account_id = target.account_id
              AND assignment.connection_id = target.id
              AND assignment.workspace_id = p_workspace_id
          ))
          OR (target.scope_kind = 'people' AND EXISTS (
            SELECT 1 FROM subscription_connection_people assignment
            JOIN organization_memberships membership
              ON membership.id = assignment.organization_membership_id
              AND membership.account_id = assignment.account_id
            WHERE assignment.account_id = target.account_id
              AND assignment.connection_id = target.id
              AND membership.status = 'active' AND membership.revoked_at IS NULL
              AND (membership.personal_workspace_id = p_workspace_id OR EXISTS (
                SELECT 1 FROM workspace_memberships workspace_membership
                WHERE workspace_membership.account_id = p_account_id
                  AND workspace_membership.workspace_id = p_workspace_id
                  AND workspace_membership.subject_id = membership.subject_id
              ))
          ));
      END IF;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'designation_management'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.connection_id = designated;
      IF NOT in_scope THEN RETURN; END IF;
      -- Never more than read_subscription_codex_apps_credential exposes:
      -- credential material only for a usable connection.
      IF target.status IS DISTINCT FROM 'active' THEN
        target.credential_encrypted := NULL;
      END IF;
      RETURN NEXT target;
    END
    $body$
  $ddl$, data_schema);
END
$codex_apps_designation_target$;

DO $codex_apps_resolve$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.resolve_subscription_codex_apps_designation(
      p_account_id uuid, p_workspace_id uuid
    ) RETURNS TABLE (connection_id uuid, status text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      RETURN QUERY
        SELECT target.id, target.status
        FROM opengeni_private.subscription_codex_apps_designation_target(
          p_account_id, p_workspace_id
        ) target;
    END
    $body$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.read_subscription_codex_apps_credential(
      p_account_id uuid, p_workspace_id uuid, p_connection_id uuid
    ) RETURNS TABLE (
      status text, refresh_generation bigint, credential_encrypted text,
      expires_at timestamptz, last_refresh_at timestamptz,
      provider_account_id text, plan_type text, is_fedramp boolean
    )
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE target subscription_connections%%ROWTYPE;
    BEGIN
      IF p_connection_id IS NULL THEN RETURN; END IF;
      SELECT * INTO target
      FROM opengeni_private.subscription_codex_apps_designation_target(
        p_account_id, p_workspace_id
      );
      IF NOT FOUND OR target.id IS DISTINCT FROM p_connection_id THEN RETURN; END IF;
      status := target.status;
      refresh_generation := target.refresh_generation;
      -- Credential material only for a usable connection.
      credential_encrypted := CASE WHEN target.status = 'active'
        THEN target.credential_encrypted END;
      expires_at := target.expires_at;
      last_refresh_at := target.last_refresh_at;
      provider_account_id := target.provider_account_id;
      plan_type := target.plan_type;
      is_fedramp := coalesce((target.provider_state->>'isFedramp')::boolean, false);
      RETURN NEXT;
    END
    $body$
  $ddl$, data_schema);
END
$codex_apps_resolve$;

DO $codex_apps_refresh$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.begin_subscription_codex_apps_refresh(
      p_account_id uuid, p_workspace_id uuid, p_connection_id uuid
    ) RETURNS TABLE (
      refresh_generation bigint, credential_encrypted text, expires_at timestamptz
    )
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      target subscription_connections%%ROWTYPE;
      minted boolean := false;
    BEGIN
      IF p_connection_id IS NULL
        OR p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      THEN RETURN; END IF;
      -- The same key as chat refresh: one provider refresh per connection.
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('subscription-refresh:' || p_connection_id::text, 0)
      );
      SELECT * INTO target
      FROM opengeni_private.subscription_codex_apps_designation_target(
        p_account_id, p_workspace_id
      );
      IF NOT FOUND OR target.id IS DISTINCT FROM p_connection_id
        OR target.status IS DISTINCT FROM 'active'
      THEN RETURN; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        connection_id, provider
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(),
        'codex_apps_refresh_authorized', p_account_id, p_workspace_id, p_connection_id, 'codex'
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO minted;
      -- One refresh per connection per transaction.
      IF minted IS DISTINCT FROM true THEN RETURN; END IF;

      refresh_generation := target.refresh_generation;
      credential_encrypted := target.credential_encrypted;
      expires_at := target.expires_at;
      RETURN NEXT;
    END
    $body$
  $ddl$, data_schema);

  -- Persist and fail consume the one-shot authorization begin minted and
  -- write through the existing one-statement codex_refresh_write capability
  -- (0664's refresh read/update policies) under the generation
  -- compare-and-swap only. As for chat, persistence deliberately does not
  -- repeat the designation check: the provider already rotated the token.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.persist_subscription_codex_apps_refresh(
      p_account_id uuid, p_workspace_id uuid, p_connection_id uuid,
      p_expected_refresh_generation bigint, p_credential_encrypted text,
      p_expires_at timestamptz, p_last_refresh_at timestamptz
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    SET lock_timeout = 0
    AS $body$
    DECLARE
      write_minted boolean := false;
      refresh_persisted boolean := false;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_connection_id IS NULL
        OR p_expected_refresh_generation IS NULL OR p_expected_refresh_generation < 1
        OR p_credential_encrypted IS NULL
        OR p_credential_encrypted !~ '^v[12]:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
        OR p_last_refresh_at IS NULL
      THEN RETURN false; END IF;
      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'codex_apps_refresh_authorized'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.connection_id = p_connection_id
        AND capability.provider = 'codex';
      IF NOT FOUND THEN RETURN false; END IF;
      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        connection_id, provider
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'codex_refresh_write',
        p_account_id, p_workspace_id, p_connection_id, 'codex'
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO write_minted;
      IF write_minted IS DISTINCT FROM true THEN RETURN false; END IF;

      UPDATE subscription_connections
      SET credential_encrypted = p_credential_encrypted,
          credential_format = split_part(p_credential_encrypted, ':', 1),
          expires_at = p_expires_at,
          last_refresh_at = p_last_refresh_at,
          refresh_generation = subscription_connections.refresh_generation + 1,
          updated_at = pg_catalog.clock_timestamp()
      WHERE account_id = p_account_id AND id = p_connection_id
        AND provider = 'codex' AND kind = 'subscription'
        AND subscription_connections.refresh_generation = p_expected_refresh_generation;
      refresh_persisted := FOUND;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'codex_refresh_write'
        AND capability.account_id = p_account_id
        AND capability.connection_id = p_connection_id;
      RETURN refresh_persisted;
    END
    $body$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.fail_subscription_codex_apps_refresh(
      p_account_id uuid, p_workspace_id uuid, p_connection_id uuid,
      p_expected_refresh_generation bigint, p_last_error text
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      write_minted boolean := false;
      marked boolean := false;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_connection_id IS NULL
        OR p_expected_refresh_generation IS NULL OR p_expected_refresh_generation < 1
      THEN RETURN false; END IF;
      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'codex_apps_refresh_authorized'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.connection_id = p_connection_id
        AND capability.provider = 'codex';
      IF NOT FOUND THEN RETURN false; END IF;
      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        connection_id, provider
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'codex_refresh_write',
        p_account_id, p_workspace_id, p_connection_id, 'codex'
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO write_minted;
      IF write_minted IS DISTINCT FROM true THEN RETURN false; END IF;

      UPDATE subscription_connections
      SET status = 'needs_relogin',
          last_error = left(coalesce(nullif(btrim(p_last_error), ''), 'Codex sign-in expired'), 512),
          version = version + 1,
          updated_at = pg_catalog.clock_timestamp()
      WHERE account_id = p_account_id AND id = p_connection_id
        AND provider = 'codex' AND kind = 'subscription' AND status = 'active'
        AND subscription_connections.refresh_generation = p_expected_refresh_generation;
      marked := FOUND;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'codex_refresh_write'
        AND capability.account_id = p_account_id
        AND capability.connection_id = p_connection_id;
      RETURN marked;
    END
    $body$
  $ddl$, data_schema);
END
$codex_apps_refresh$;

REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_apps_designation_target(uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.resolve_subscription_codex_apps_designation(uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.read_subscription_codex_apps_credential(uuid, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.begin_subscription_codex_apps_refresh(uuid, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.persist_subscription_codex_apps_refresh(
  uuid, uuid, uuid, bigint, text, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.fail_subscription_codex_apps_refresh(
  uuid, uuid, uuid, bigint, text
) FROM PUBLIC;

-- The internal target helper is not granted here; the routines above call it
-- as its owner.
DO $grant_codex_apps$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.resolve_subscription_codex_apps_designation(
      uuid, uuid
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.read_subscription_codex_apps_credential(
      uuid, uuid, uuid
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.begin_subscription_codex_apps_refresh(
      uuid, uuid, uuid
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.persist_subscription_codex_apps_refresh(
      uuid, uuid, uuid, bigint, text, timestamptz, timestamptz
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.fail_subscription_codex_apps_refresh(
      uuid, uuid, uuid, bigint, text
    ) TO opengeni_app;
  END IF;
END
$grant_codex_apps$;

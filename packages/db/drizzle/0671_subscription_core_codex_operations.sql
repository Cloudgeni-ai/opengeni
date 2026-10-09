-- deployment-mode: rolling
-- M3 PR 2c: the connection-level Codex credential seam for operations outside
-- chat (image, realtime, transcription) and for usage refresh and reset
-- credits. Everything here is inert while no Codex cutover row is enabled:
-- every routine returns nothing (or false) unless the account's Codex
-- cutover is enabled, and the capability kind added below is minted only by
-- these routines. Claude and xAI are untouched. No data moves.
--
-- 1. subscription_codex_connection_target (internal; not granted here,
--    though role provisioning grants every opengeni_private routine, so it
--    exposes no more than read_subscription_codex_connection_credential)
--    returns one Codex subscription connection for one workspace context:
--    * with an operation id, only while the caller's exact live
--      subscription_operation_leases row (operation, attempt, holder,
--      generation, connection) exists. A turn-bound operation (image) sees
--      the connection through the caller's row-level visibility for that
--      exact accepted turn, including a personal connection only under the
--      turn's frozen authority; a session-bound (realtime) or sessionless
--      (transcription) operation is limited to shared organization- or
--      workspace-scoped connections in the workspace's scope.
--    * without an operation id (usage refresh, reset credits), only a shared
--      organization- or workspace-scoped connection in the workspace's scope.
-- 2. read_subscription_codex_connection_credential returns its credential
--    (ciphertext only while active) and the refresh generation.
-- 3. begin/persist/fail_subscription_codex_connection_refresh are the Codex
--    refresh seam for these operations. begin takes the same per-connection
--    advisory key as chat and Apps refresh ('subscription-refresh:<id>'), so
--    every refresh of one connection serializes; persist writes only under
--    the refresh-generation compare-and-swap through the existing
--    one-statement codex_refresh_write capability; fail marks needs_relogin
--    under the same compare-and-swap. As for chat and Apps, persistence does
--    not repeat the authorization: the provider already rotated the token.
-- 4. guard_subscription_operation_lease_reference also admits a realtime
--    operation for an ownerless session (no turn, no initiating human), which
--    the existing shared-only check limits to organization- or
--    workspace-scoped shared connections. Every other branch is unchanged.

SET LOCAL lock_timeout = '5s';

ALTER TABLE opengeni_private.subscription_runtime_capabilities
  DROP CONSTRAINT subscription_runtime_capabilities_kind_chk,
  ADD CONSTRAINT subscription_runtime_capabilities_kind_chk
    CHECK (capability_kind IN (
      'personal_access', 'session_access', 'binding_access', 'lifecycle',
      'designation_management', 'codex_refresh_authorized', 'codex_refresh_write',
      'codex_apps_refresh_authorized', 'codex_connection_refresh_authorized'
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
    -- Apps and connection-level refresh are workspace-scoped: no session,
    -- turn or person on the capability itself.
    OR (capability_kind IN (
        'codex_apps_refresh_authorized', 'codex_connection_refresh_authorized',
        'codex_refresh_write'
      )
      AND provider = 'codex' AND workspace_id IS NOT NULL
      AND session_id IS NULL AND turn_id IS NULL
      AND session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)
  );

DO $codex_connection_target$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_codex_connection_target(
      p_account_id uuid, p_workspace_id uuid, p_connection_id uuid,
      p_operation_id uuid, p_attempt_id uuid, p_holder_id text, p_generation bigint
    ) RETURNS SETOF %1$I.subscription_connections
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      operation_lease subscription_operation_leases%%ROWTYPE;
      target subscription_connections%%ROWTYPE;
      turn_bound boolean := false;
    BEGIN
      IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_connection_id IS NULL
        OR p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      THEN RETURN; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM subscription_provider_cutovers cutover
        WHERE cutover.account_id = p_account_id AND cutover.provider = 'codex'
          AND cutover.enabled
      ) THEN RETURN; END IF;

      IF p_operation_id IS NOT NULL THEN
        -- The exact live operation lease, read under the caller's own
        -- row-level security (session visibility included).
        SELECT lease.* INTO operation_lease
        FROM subscription_operation_leases lease
        WHERE lease.account_id = p_account_id AND lease.workspace_id = p_workspace_id
          AND lease.operation_id = p_operation_id
          AND lease.attempt_id IS NOT DISTINCT FROM p_attempt_id
          AND lease.holder_id IS NOT DISTINCT FROM p_holder_id
          AND lease.generation IS NOT DISTINCT FROM p_generation
          AND lease.provider = 'codex' AND lease.connection_id = p_connection_id
          AND lease.leased_until > pg_catalog.clock_timestamp();
        IF NOT FOUND THEN RETURN; END IF;
        turn_bound := operation_lease.turn_id IS NOT NULL;
      ELSIF p_attempt_id IS NOT NULL OR p_holder_id IS NOT NULL OR p_generation IS NOT NULL THEN
        RETURN;
      END IF;

      SELECT connection.* INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = 'codex' AND connection.kind = 'subscription';
      IF NOT FOUND THEN RETURN; END IF;
      -- Outside an exact accepted turn only shared organization- or
      -- workspace-scoped capacity in this workspace's scope is usable: no
      -- caller, creator or viewer authority reaches a personal or
      -- people-scoped connection.
      IF NOT turn_bound AND (
        target.ownership IS DISTINCT FROM 'shared'
        OR NOT (target.scope_kind = 'organization'
          OR (target.scope_kind = 'workspaces' AND EXISTS (
            SELECT 1 FROM subscription_connection_workspaces assignment
            WHERE assignment.account_id = target.account_id
              AND assignment.connection_id = target.id
              AND assignment.workspace_id = p_workspace_id
          )))
      ) THEN RETURN; END IF;
      IF target.status IS DISTINCT FROM 'active' THEN
        target.credential_encrypted := NULL;
      END IF;
      RETURN NEXT target;
    END
    $body$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.read_subscription_codex_connection_credential(
      p_account_id uuid, p_workspace_id uuid, p_connection_id uuid,
      p_operation_id uuid, p_attempt_id uuid, p_holder_id text, p_generation bigint
    ) RETURNS TABLE (
      status text, ownership text, refresh_generation bigint, credential_encrypted text,
      expires_at timestamptz, last_refresh_at timestamptz,
      provider_account_id text, plan_type text, is_fedramp boolean
    )
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE target subscription_connections%%ROWTYPE;
    BEGIN
      SELECT * INTO target
      FROM opengeni_private.subscription_codex_connection_target(
        p_account_id, p_workspace_id, p_connection_id,
        p_operation_id, p_attempt_id, p_holder_id, p_generation
      );
      IF NOT FOUND THEN RETURN; END IF;
      status := target.status;
      ownership := target.ownership;
      refresh_generation := target.refresh_generation;
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
$codex_connection_target$;

DO $codex_connection_refresh$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.begin_subscription_codex_connection_refresh(
      p_account_id uuid, p_workspace_id uuid, p_connection_id uuid,
      p_operation_id uuid, p_attempt_id uuid, p_holder_id text, p_generation bigint
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
      -- The same key as chat and Apps refresh: one provider refresh per connection.
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('subscription-refresh:' || p_connection_id::text, 0)
      );
      SELECT * INTO target
      FROM opengeni_private.subscription_codex_connection_target(
        p_account_id, p_workspace_id, p_connection_id,
        p_operation_id, p_attempt_id, p_holder_id, p_generation
      );
      IF NOT FOUND OR target.status IS DISTINCT FROM 'active' THEN RETURN; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        connection_id, provider
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(),
        'codex_connection_refresh_authorized', p_account_id, p_workspace_id, p_connection_id, 'codex'
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

  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.persist_subscription_codex_connection_refresh(
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
        AND capability.capability_kind = 'codex_connection_refresh_authorized'
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
    CREATE FUNCTION opengeni_private.fail_subscription_codex_connection_refresh(
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
        AND capability.capability_kind = 'codex_connection_refresh_authorized'
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
$codex_connection_refresh$;

-- 0667's guard, with one added branch: a realtime operation of an ownerless
-- session (no turn, no initiating human). Shared-only placement below still
-- applies to it, exactly as to an ownerless turn.
DO $ownerless_realtime_operation_lease_guard$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.guard_subscription_operation_lease_reference()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      target subscription_connections%%ROWTYPE;
      session_owner text;
      session_owner_membership uuid;
      turn_human text;
      personal_authorized boolean := false;
      ownerless_session boolean := false;
    BEGIN
      IF NEW.account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR NEW.workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      THEN
        RAISE EXCEPTION 'subscription operation lease is outside the scoped account or workspace'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.session_id IS NULL THEN
        IF NEW.operation_kind <> 'transcription'
          OR nullif(current_setting('opengeni.subject_id', true), '') IS NULL
          OR nullif(current_setting('opengeni.initiating_human_subject_id', true), '') IS NULL
        THEN
          RAISE EXCEPTION 'sessionless subscription operation requires explicit transcription authority'
            USING ERRCODE = '42501';
        END IF;
      ELSE
        IF NOT session_reference_visible(NEW.account_id, NEW.workspace_id, NEW.session_id) THEN
          RAISE EXCEPTION 'subscription operation session is not visible'
            USING ERRCODE = '42501';
        END IF;
        SELECT session.owner_subject_id, session.owner_organization_membership_id
          INTO session_owner, session_owner_membership
        FROM sessions session
        WHERE session.account_id = NEW.account_id AND session.workspace_id = NEW.workspace_id
          AND session.id = NEW.session_id;
        IF NOT FOUND OR (session_owner IS NULL) <> (session_owner_membership IS NULL) THEN
          RAISE EXCEPTION 'subscription operation session owner authority is unavailable or malformed'
            USING ERRCODE = '42501';
        END IF;
        ownerless_session := session_owner IS NULL;

        IF NEW.turn_id IS NOT NULL THEN
          SELECT turn.initiating_human_subject_id INTO turn_human
          FROM session_turns turn
          WHERE turn.account_id = NEW.account_id AND turn.workspace_id = NEW.workspace_id
            AND turn.session_id = NEW.session_id AND turn.id = NEW.turn_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'subscription operation turn is not in the referenced session'
              USING ERRCODE = '42501';
          END IF;
          IF ownerless_session THEN
            IF turn_human IS NOT NULL OR NOT opengeni_private.authorize_subscription_ownerless_session_access(
              NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id
            ) THEN
              RAISE EXCEPTION 'ownerless subscription operation turn is not authorized for this session'
                USING ERRCODE = '42501';
            END IF;
          ELSIF turn_human IS NULL THEN
            IF NOT opengeni_private.authorize_subscription_service_session_access(
              NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id, session_owner
            ) THEN
              RAISE EXCEPTION 'non-human subscription operation is not authorized for this session'
                USING ERRCODE = '42501';
            END IF;
            turn_human := session_owner;
          ELSIF NOT opengeni_private.authorize_subscription_session_access(
            NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id, session_owner, turn_human
          ) THEN
            RAISE EXCEPTION 'subscription operation turn is not authorized for this session'
              USING ERRCODE = '42501';
          END IF;
        ELSIF ownerless_session THEN
          -- An ownerless session has no owner context to carry; only its
          -- realtime operation exists, and no person stands behind it.
          IF NEW.operation_kind <> 'realtime'
            OR nullif(current_setting('opengeni.initiating_human_subject_id', true), '') IS NOT NULL
          THEN
            RAISE EXCEPTION 'ownerless session-bound subscription operation is not authorized'
              USING ERRCODE = '42501';
          END IF;
        ELSE
          turn_human := nullif(current_setting('opengeni.initiating_human_subject_id', true), '');
          IF turn_human IS NULL OR turn_human IS DISTINCT FROM session_owner THEN
            RAISE EXCEPTION 'session-bound subscription operation requires its accepted owner context'
              USING ERRCODE = '42501';
          END IF;
        END IF;
      END IF;

      IF NEW.session_id IS NOT NULL AND NEW.turn_id IS NOT NULL AND NOT ownerless_session THEN
        personal_authorized := opengeni_private.authorize_subscription_personal_access(
          NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id, NEW.connection_id,
          NEW.provider, session_owner, turn_human
        );
      END IF;

      SELECT connection.* INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = NEW.account_id AND connection.id = NEW.connection_id
        AND connection.provider = NEW.provider AND connection.status = 'active';
      IF NOT FOUND OR NOT opengeni_private.subscription_connection_visible(
        NEW.account_id, NEW.workspace_id, target.id, target.ownership, target.scope_kind,
        target.owner_organization_membership_id, target.owner_subject_id, target.provider
      ) THEN
        RAISE EXCEPTION 'subscription operation connection is not in the authorized pool'
          USING ERRCODE = '42501';
      END IF;
      IF ownerless_session AND (target.ownership <> 'shared'
        OR target.scope_kind NOT IN ('organization', 'workspaces')) THEN
        RAISE EXCEPTION 'ownerless subscription operations require organization- or workspace-scoped shared connections'
          USING ERRCODE = '42501';
      END IF;
      IF target.ownership = 'personal' THEN
        IF NEW.session_id IS NULL OR NEW.turn_id IS NULL OR NOT personal_authorized
          OR NOT coalesce((subscription_effective_settings(
            NEW.account_id, NEW.workspace_id
          ) #>> '{values,personalConnectionsAllowed}')::boolean, false)
        THEN
          RAISE EXCEPTION 'personal subscription operation lacks frozen owner authority or current settings'
            USING ERRCODE = '42501';
        END IF;
      END IF;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
END
$ownerless_realtime_operation_lease_guard$;

REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_connection_target(
  uuid, uuid, uuid, uuid, uuid, text, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.read_subscription_codex_connection_credential(
  uuid, uuid, uuid, uuid, uuid, text, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.begin_subscription_codex_connection_refresh(
  uuid, uuid, uuid, uuid, uuid, text, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.persist_subscription_codex_connection_refresh(
  uuid, uuid, uuid, bigint, text, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.fail_subscription_codex_connection_refresh(
  uuid, uuid, uuid, bigint, text
) FROM PUBLIC;

-- The internal target helper is not granted here; the routines above call it
-- as its owner.
DO $grant_codex_connection$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.read_subscription_codex_connection_credential(
      uuid, uuid, uuid, uuid, uuid, text, bigint
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.begin_subscription_codex_connection_refresh(
      uuid, uuid, uuid, uuid, uuid, text, bigint
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.persist_subscription_codex_connection_refresh(
      uuid, uuid, uuid, bigint, text, timestamptz, timestamptz
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.fail_subscription_codex_connection_refresh(
      uuid, uuid, uuid, bigint, text
    ) TO opengeni_app;
  END IF;
END
$grant_codex_connection$;

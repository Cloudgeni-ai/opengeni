-- deployment-mode: rolling
-- Provider-neutral subscription-core routines (design
-- docs/design/subscription-core-2026-10-07.md, "M4: one runtime, per-provider
-- adapters"). The shared runtime takes the provider as data; every routine
-- below is the exact equivalent of the provider-named routine noted next to
-- it, with the provider passed as `p_provider` instead of a literal.
--
-- Rolling: nothing existing changes meaning. The provider-named routines,
-- capability kinds and policies stay byte-for-byte as they are for binaries
-- that still call them; a later retirement migration (after no such binary
-- can run) drops them. Both families take the same per-connection refresh
-- key ('subscription-refresh:<id>'), the same personal-authority and connect
-- keys, and the same row locks, in the same order, so old and new binaries
-- serialize against each other exactly as two old binaries do.
--
-- 1. opengeni_private.subscription_core_providers: the providers whose
--    runtime runs on the shared core, and the per-provider data the shared
--    routines need (whether the provider has extra credits, and which
--    settings column holds its primary connection until settings are keyed
--    by provider). Owner-only; a provider without a row is refused by every
--    routine below (fail closed). Seeded with the one provider on the core.
-- 2. Provider-neutral capability kinds (`refresh_authorized`,
--    `refresh_write`, `connection_refresh_authorized`, `connection_owner`),
--    each bound to the provider it was minted for, and owner-only policies
--    that admit them for the row's own provider. They mirror the existing
--    provider-named kinds and policies one for one.
-- 3. The routines: the turn refresh seam (begin, persist, persist with
--    plan, fail), connection health (quarantine, recover), v2 accepted
--    authority (session, scheduled task, task revision), the connection
--    credential seam for operations (target, read, begin, persist, fail),
--    and the personal writers (connect, disconnect, manage, list) with their
--    owner-only internals (writer context, capability grant and drop).
--    Bodies are the live definitions (after every later patch) with the
--    provider literal replaced by `p_provider`, these exceptions:
--    - the default relogin and refusal texts are provider-free (the runtime
--      passes the provider's own text, so stored values are unchanged);
--    - each routine additionally requires a registry row for `p_provider`;
--    - the owner-capability drop removes only the neutral owner capability
--      of this provider (the reset-credit fence is a provider-specific
--      capability these writers never mint);
--    - `manage ... 'primary'` writes the registry's primary column and
--      `'extra_credits'` requires the registry's extra-credits flag.
-- 4. The shared disconnect-admission trigger admits by registry membership
--    instead of a provider literal; with the one registered provider this is
--    the same rows and the same checks.
-- 5. The registry is append-only (a removed or renamed provider would make
--    the shared admission trigger skip that provider's rows while old
--    binaries still call its provider-named routines), and every registered
--    primary column is checked on each registry write.
-- 6. The two SECURITY DEFINER subscription guard triggers resolve their
--    unqualified tables with pg_temp last, so a session's temporary tables
--    cannot shadow the connection, turn or lease rows they check (a defect
--    in migration 0691, which captured the migration session's path).
SET LOCAL lock_timeout = '5s';

-- 1. The provider registry.
CREATE TABLE opengeni_private.subscription_core_providers (
  provider text PRIMARY KEY CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  extra_credits boolean NOT NULL DEFAULT false,
  primary_setting_column text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A provider's primary column is its own: no row can point at another
  -- provider's column.
  CONSTRAINT subscription_core_providers_primary_column_chk
    CHECK (primary_setting_column = provider || '_primary_connection_id')
);
REVOKE ALL ON TABLE opengeni_private.subscription_core_providers FROM PUBLIC;
DO $registry_guard$
DECLARE data_schema text := current_schema();
BEGIN
  -- Append-only, and every registered primary column must be a real
  -- subscription_settings uuid column.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.guard_subscription_provider_registry()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE')
        OR (TG_OP = 'UPDATE' AND NEW.provider IS DISTINCT FROM OLD.provider) THEN
        RAISE EXCEPTION 'subscription core providers are append-only' USING ERRCODE = '55000';
      END IF;
      IF NEW.primary_setting_column IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute attribute
        WHERE attribute.attrelid = %2$L::regclass
          AND attribute.attname = NEW.primary_setting_column
          AND attribute.atttypid = 'uuid'::regtype AND NOT attribute.attisdropped
      ) THEN
        RAISE EXCEPTION 'subscription_settings primary column is missing' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema, format('%I.subscription_settings', data_schema));
END
$registry_guard$;
REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_provider_registry() FROM PUBLIC;
CREATE TRIGGER subscription_core_providers_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON opengeni_private.subscription_core_providers
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_provider_registry();
CREATE TRIGGER subscription_core_providers_no_truncate
  BEFORE TRUNCATE ON opengeni_private.subscription_core_providers
  FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.guard_subscription_provider_registry();
INSERT INTO opengeni_private.subscription_core_providers (provider, extra_credits, primary_setting_column)
VALUES ('codex', true, 'codex_primary_connection_id');

-- 2. Neutral capability kinds, bound to their provider.
ALTER TABLE opengeni_private.subscription_runtime_capabilities
  DROP CONSTRAINT subscription_runtime_capabilities_kind_chk,
  ADD CONSTRAINT subscription_runtime_capabilities_kind_chk
    CHECK (capability_kind IN ('personal_access', 'session_access', 'binding_access', 'lifecycle',
      'designation_management', 'codex_refresh_authorized', 'codex_refresh_write',
      'codex_apps_refresh_authorized', 'codex_connection_refresh_authorized',
      'codex_connection_owner', 'codex_reset_credit_fence',
      'refresh_authorized', 'refresh_write', 'connection_refresh_authorized',
      'connection_owner'));
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
  );

-- 3. The routines.
DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_subscription_internal.subscription_core_writer_context(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      SELECT p_account_id IS NOT NULL
        AND p_subject_id IS NOT NULL AND p_subject_id LIKE 'user:_%%'
        AND p_account_id IS NOT DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        AND p_workspace_id IS NOT DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        AND p_subject_id IS NOT DISTINCT FROM nullif(current_setting('opengeni.subject_id', true), '')
        AND EXISTS (SELECT 1 FROM subscription_provider_cutovers cutover
        JOIN opengeni_private.subscription_core_providers registry ON registry.provider = cutover.provider
          WHERE cutover.account_id = p_account_id AND cutover.provider = p_provider
            AND cutover.enabled)
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_subscription_internal.grant_subscription_core_owner_capability(p_provider text, p_kind text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid)
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    BEGIN
      -- The capability key omits the provider; a second provider's grant on
      -- the same key is refused rather than silently sharing the first row.
      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id, connection_id,
        provider, session_owner_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), p_kind, p_account_id,
        p_workspace_id, p_connection_id, p_provider, p_subject_id
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO UPDATE SET workspace_id = EXCLUDED.workspace_id,
          session_owner_subject_id = EXCLUDED.session_owner_subject_id
        WHERE subscription_runtime_capabilities.provider = EXCLUDED.provider;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'subscription capability is held for another provider' USING ERRCODE = '42501';
      END IF;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider text, p_account_id uuid)
    RETURNS void
    LANGUAGE sql
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'connection_owner' AND capability.provider = p_provider
        AND capability.account_id = p_account_id
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_core_owner_capability_held(p_provider text, p_account_id uuid, p_kinds text[], p_subject_id text, p_connection_id uuid, p_any_connection boolean)
    RETURNS boolean
    LANGUAGE sql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
      SELECT EXISTS (SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = ANY(p_kinds)
          AND capability.account_id = p_account_id
          AND (p_provider IS NULL OR capability.provider = p_provider)
          AND (p_subject_id IS NULL OR capability.session_owner_subject_id = p_subject_id)
          AND (p_connection_id IS NULL OR capability.connection_id = p_connection_id
            OR (p_any_connection
              AND capability.connection_id = '00000000-0000-0000-0000-000000000000'::uuid)))
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_core_owner_membership_held(p_account_id uuid, p_membership_id uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
      SELECT EXISTS (SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
        JOIN organization_memberships membership
          ON membership.account_id = capability.account_id
         AND membership.subject_id = capability.session_owner_subject_id
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'connection_owner'
          AND capability.account_id = p_account_id
          AND membership.id = p_membership_id)
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_core_refresh_write_allowed(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, opengeni_private, pg_temp
    AS $body$
  SELECT EXISTS (
    SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability.capability_kind = 'refresh_write'
      AND capability.account_id = p_account_id
      AND capability.workspace_id = p_workspace_id
      AND capability.connection_id = p_connection_id
      AND capability.provider = p_provider
  )
$body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_subscription_internal.subscription_core_connection_target(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_operation_id uuid, p_attempt_id uuid, p_holder_id text, p_generation bigint)
    RETURNS SETOF subscription_connections
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      operation_lease subscription_operation_leases%%ROWTYPE;
      target subscription_connections%%ROWTYPE;
      turn_bound boolean := false;
      session_owner text;
    BEGIN
      IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_connection_id IS NULL
        OR p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      THEN RETURN; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM subscription_provider_cutovers cutover
        JOIN opengeni_private.subscription_core_providers registry ON registry.provider = cutover.provider
        WHERE cutover.account_id = p_account_id AND cutover.provider = p_provider
          AND cutover.enabled
      ) THEN RETURN; END IF;

      IF p_operation_id IS NOT NULL THEN
        SELECT lease.* INTO operation_lease
        FROM subscription_operation_leases lease
        WHERE lease.account_id = p_account_id AND lease.workspace_id = p_workspace_id
          AND lease.operation_id = p_operation_id
          AND lease.attempt_id IS NOT DISTINCT FROM p_attempt_id
          AND lease.holder_id IS NOT DISTINCT FROM p_holder_id
          AND lease.generation IS NOT DISTINCT FROM p_generation
          AND lease.provider = p_provider AND lease.connection_id = p_connection_id
          AND lease.leased_until > pg_catalog.clock_timestamp();
        IF NOT FOUND THEN RETURN; END IF;
        IF operation_lease.session_id IS NOT NULL AND NOT session_reference_visible(
          p_account_id, p_workspace_id, operation_lease.session_id
        ) THEN RETURN; END IF;
        turn_bound := operation_lease.turn_id IS NOT NULL;
        IF turn_bound THEN
          SELECT session.owner_subject_id INTO session_owner
          FROM sessions session
          JOIN session_turns turn ON turn.account_id = session.account_id
            AND turn.workspace_id = session.workspace_id AND turn.session_id = session.id
          WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
            AND session.id = operation_lease.session_id AND turn.id = operation_lease.turn_id
            AND turn.status = 'running'
            AND turn.active_attempt_id = operation_lease.attempt_id
            AND turn.execution_generation = operation_lease.generation;
          IF NOT FOUND OR NOT EXISTS (
            SELECT 1 FROM subscription_leases chat
            WHERE chat.account_id = p_account_id AND chat.workspace_id = p_workspace_id
              AND chat.session_id = operation_lease.session_id
              AND chat.turn_id = operation_lease.turn_id
              AND chat.provider = p_provider AND chat.connection_id = p_connection_id
              AND chat.leased_until > pg_catalog.clock_timestamp()
          ) THEN RETURN; END IF;
        END IF;
      ELSIF p_attempt_id IS NOT NULL OR p_holder_id IS NOT NULL OR p_generation IS NOT NULL THEN
        RETURN;
      END IF;

      SELECT connection.* INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = p_provider AND connection.kind = 'subscription';
      IF NOT FOUND THEN RETURN; END IF;
      IF turn_bound THEN
        IF NOT opengeni_private.subscription_connection_visible(
          p_account_id, p_workspace_id, target.id, target.ownership, target.scope_kind,
          target.owner_organization_membership_id, target.owner_subject_id, target.provider
        ) THEN RETURN; END IF;
        IF session_owner IS NULL AND (target.ownership IS DISTINCT FROM 'shared'
          OR target.scope_kind NOT IN ('organization', 'workspaces'))
        THEN RETURN; END IF;
        IF target.ownership = 'personal' AND NOT (
          EXISTS (
            SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
            WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
              AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
              AND capability.capability_kind = 'personal_access'
              AND capability.account_id = p_account_id
              AND capability.connection_id = target.id
              AND capability.session_id = operation_lease.session_id
              AND capability.turn_id = operation_lease.turn_id
          )
          AND coalesce((subscription_effective_settings(
            p_account_id, p_workspace_id
          ) #>> '{values,personalConnectionsAllowed}')::boolean, false)
        ) THEN RETURN; END IF;
      END IF;
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
    CREATE FUNCTION opengeni_private.begin_subscription_core_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_session_owner_subject_id text, p_turn_human_subject_id text, p_connection_id uuid, p_holder_id text, p_lease_generation bigint)
    RETURNS TABLE(refresh_generation bigint, credential_encrypted text, expires_at timestamp with time zone)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      session_owner text;
      turn_human text;
      capability_owner text;
      capability_human text;
      target subscription_connections%%ROWTYPE;
      authorized boolean := false;
      personal_authorized boolean := false;
      ownerless_session boolean := false;
      had_personal_access boolean := false;
      minted boolean := false;
      lease_current boolean := false;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_connection_id IS NULL OR p_session_id IS NULL OR p_turn_id IS NULL
        OR p_lease_generation IS NULL OR p_lease_generation < 1
        OR p_holder_id IS NULL OR length(btrim(p_holder_id)) NOT BETWEEN 1 AND 256
        OR NOT EXISTS (SELECT 1 FROM opengeni_private.subscription_core_providers registry
          WHERE registry.provider = p_provider)
      THEN RETURN; END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('subscription-refresh:' || p_connection_id::text, 0)
      );

      SELECT session.owner_subject_id, turn.initiating_human_subject_id
        INTO session_owner, turn_human
      FROM sessions session
      JOIN session_turns turn ON turn.account_id = session.account_id
        AND turn.workspace_id = session.workspace_id AND turn.session_id = session.id
      WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
        AND session.id = p_session_id AND turn.id = p_turn_id;
      IF NOT FOUND OR session_owner IS DISTINCT FROM p_session_owner_subject_id
        OR turn_human IS DISTINCT FROM p_turn_human_subject_id
      THEN RETURN; END IF;
      ownerless_session := session_owner IS NULL;

      IF session_owner IS NULL THEN
        authorized := opengeni_private.authorize_subscription_ownerless_session_access(
            p_account_id, p_workspace_id, p_session_id, p_turn_id
          );
      ELSIF turn_human IS NULL THEN
        authorized := opengeni_private.authorize_subscription_service_session_access(
          p_account_id, p_workspace_id, p_session_id, p_turn_id, session_owner
        );
      ELSE
        authorized := opengeni_private.authorize_subscription_session_access(
          p_account_id, p_workspace_id, p_session_id, p_turn_id, session_owner, turn_human
        );
      END IF;
      IF NOT authorized THEN RETURN; END IF;
      IF ownerless_session THEN
        capability_owner := NULL;
        capability_human := NULL;
      ELSE
        capability_owner := session_owner;
        capability_human := coalesce(turn_human, session_owner);
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM subscription_leases lease
        WHERE lease.account_id = p_account_id AND lease.workspace_id = p_workspace_id
          AND lease.session_id = p_session_id AND lease.turn_id = p_turn_id
          AND lease.provider = p_provider AND lease.connection_id = p_connection_id
          AND lease.holder_id = p_holder_id AND lease.generation = p_lease_generation
          AND lease.leased_until > pg_catalog.clock_timestamp()
      ) INTO lease_current;
      IF NOT lease_current THEN RETURN; END IF;

      IF NOT ownerless_session AND turn_human IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
          WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
            AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
            AND capability.capability_kind = 'personal_access'
            AND capability.account_id = p_account_id
            AND capability.connection_id = p_connection_id
        ) INTO had_personal_access;
        IF had_personal_access THEN
          SELECT EXISTS (
            SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
            WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
              AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
              AND capability.capability_kind = 'personal_access'
              AND capability.account_id = p_account_id
              AND capability.connection_id = p_connection_id
              AND capability.workspace_id = p_workspace_id
              AND capability.session_id = p_session_id
              AND capability.turn_id = p_turn_id
              AND capability.provider = p_provider
              AND capability.session_owner_subject_id = session_owner
              AND capability.turn_human_subject_id = turn_human
          ) INTO personal_authorized;
        ELSE
          personal_authorized := opengeni_private.authorize_subscription_personal_access(
            p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id,
            p_provider, session_owner, turn_human
          );
        END IF;
      END IF;

      SELECT connection.* INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = p_provider AND connection.kind = 'subscription'
        AND connection.status = 'active';
      authorized := FOUND
        AND NOT (ownerless_session AND (
          target.ownership IS DISTINCT FROM 'shared'
          OR (
            target.scope_kind IS DISTINCT FROM 'organization'
            AND target.scope_kind IS DISTINCT FROM 'workspaces'
          )
        ))
        AND NOT (target.ownership = 'personal' AND NOT personal_authorized)
        AND NOT (target.ownership = 'personal' AND NOT coalesce((subscription_effective_settings(
          p_account_id, p_workspace_id
        ) #>> '{values,personalConnectionsAllowed}')::boolean, false))
        AND opengeni_private.subscription_connection_visible(
          p_account_id, p_workspace_id, target.id, target.ownership, target.scope_kind,
          target.owner_organization_membership_id, target.owner_subject_id, target.provider
        );

      IF NOT had_personal_access THEN
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'personal_access'
          AND capability.account_id = p_account_id
          AND capability.connection_id = p_connection_id;
      END IF;
      IF NOT coalesce(authorized, false) THEN RETURN; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        session_id, turn_id, connection_id, provider,
        session_owner_subject_id, turn_human_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'refresh_authorized',
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id, p_provider,
        capability_owner, capability_human
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO minted;
      IF minted IS DISTINCT FROM true THEN RETURN; END IF;

      refresh_generation := target.refresh_generation;
      credential_encrypted := target.credential_encrypted;
      expires_at := target.expires_at;
      RETURN NEXT;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.persist_subscription_core_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_credential_encrypted text, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    SET lock_timeout = '0'
    AS $body$
    DECLARE
      capability_owner text;
      capability_human text;
      write_minted boolean := false;
      refresh_persisted boolean := false;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_connection_id IS NULL OR p_session_id IS NULL OR p_turn_id IS NULL
        OR p_expected_refresh_generation IS NULL OR p_expected_refresh_generation < 1
        OR p_credential_encrypted IS NULL
        OR p_credential_encrypted !~ '^v[12]:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
        OR p_last_refresh_at IS NULL
      THEN RETURN false; END IF;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'refresh_authorized'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.session_id = p_session_id
        AND capability.turn_id = p_turn_id
        AND capability.connection_id = p_connection_id
        AND capability.provider = p_provider
      RETURNING capability.session_owner_subject_id, capability.turn_human_subject_id
        INTO capability_owner, capability_human;
      IF NOT FOUND THEN RETURN false; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        session_id, turn_id, connection_id, provider,
        session_owner_subject_id, turn_human_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'refresh_write',
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id, p_provider,
        capability_owner, capability_human
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
        AND provider = p_provider AND kind = 'subscription'
        AND subscription_connections.refresh_generation = p_expected_refresh_generation;
      refresh_persisted := FOUND;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'refresh_write'
        AND capability.account_id = p_account_id
        AND capability.connection_id = p_connection_id;
      RETURN refresh_persisted;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.persist_subscription_core_refresh_with_plan(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_credential_encrypted text, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone, p_plan_type text)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    SET lock_timeout = '0'
    AS $body$
    DECLARE
      capability_owner text;
      capability_human text;
      write_minted boolean := false;
      refresh_persisted boolean := false;
      plan_value text := nullif(btrim(coalesce(p_plan_type, '')), '');
      previous_plan text;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_connection_id IS NULL OR p_session_id IS NULL OR p_turn_id IS NULL
        OR p_expected_refresh_generation IS NULL OR p_expected_refresh_generation < 1
        OR p_credential_encrypted IS NULL
        OR p_credential_encrypted !~ '^v[12]:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
        OR p_last_refresh_at IS NULL
        OR (plan_value IS NOT NULL AND (length(plan_value) > 64 OR plan_value !~ '^[A-Za-z0-9_.-]+$'))
      THEN RETURN false; END IF;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'refresh_authorized'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.session_id = p_session_id
        AND capability.turn_id = p_turn_id
        AND capability.connection_id = p_connection_id
        AND capability.provider = p_provider
      RETURNING capability.session_owner_subject_id, capability.turn_human_subject_id
        INTO capability_owner, capability_human;
      IF NOT FOUND THEN RETURN false; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        session_id, turn_id, connection_id, provider,
        session_owner_subject_id, turn_human_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'refresh_write',
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id, p_provider,
        capability_owner, capability_human
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO write_minted;
      IF write_minted IS DISTINCT FROM true THEN RETURN false; END IF;

      SELECT connection.plan_type INTO previous_plan
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = p_provider;

      UPDATE subscription_connections
      SET credential_encrypted = p_credential_encrypted,
          credential_format = split_part(p_credential_encrypted, ':', 1),
          expires_at = p_expires_at,
          last_refresh_at = p_last_refresh_at,
          plan_type = coalesce(plan_value, subscription_connections.plan_type),
          refresh_generation = subscription_connections.refresh_generation + 1,
          updated_at = pg_catalog.clock_timestamp()
      WHERE account_id = p_account_id AND id = p_connection_id
        AND provider = p_provider AND kind = 'subscription'
        AND subscription_connections.refresh_generation = p_expected_refresh_generation;
      refresh_persisted := FOUND;

      IF refresh_persisted AND plan_value IS NOT NULL AND previous_plan IS NOT NULL
        AND plan_value IS DISTINCT FROM previous_plan
      THEN
        UPDATE subscription_connection_quota quota
        SET quota = pg_catalog.jsonb_set(quota.quota, '{modelCooldowns}', '{}'::jsonb),
            revision = quota.revision + 1
        WHERE quota.account_id = p_account_id AND quota.connection_id = p_connection_id
          AND pg_catalog.jsonb_typeof(quota.quota->'modelCooldowns') = 'object'
          AND quota.quota->'modelCooldowns' <> '{}'::jsonb;
      END IF;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'refresh_write'
        AND capability.account_id = p_account_id
        AND capability.connection_id = p_connection_id;
      RETURN refresh_persisted;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.fail_subscription_core_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_last_error text)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      capability_owner text;
      capability_human text;
      write_minted boolean := false;
      marked boolean := false;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_connection_id IS NULL OR p_session_id IS NULL OR p_turn_id IS NULL
        OR p_expected_refresh_generation IS NULL OR p_expected_refresh_generation < 1
      THEN RETURN false; END IF;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'refresh_authorized'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.session_id = p_session_id
        AND capability.turn_id = p_turn_id
        AND capability.connection_id = p_connection_id
        AND capability.provider = p_provider
      RETURNING capability.session_owner_subject_id, capability.turn_human_subject_id
        INTO capability_owner, capability_human;
      IF NOT FOUND THEN RETURN false; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        session_id, turn_id, connection_id, provider,
        session_owner_subject_id, turn_human_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'refresh_write',
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id, p_provider,
        capability_owner, capability_human
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO write_minted;
      IF write_minted IS DISTINCT FROM true THEN RETURN false; END IF;

      UPDATE subscription_connections
      SET status = 'needs_relogin',
          last_error = left(coalesce(nullif(btrim(p_last_error), ''), 'Sign-in expired'), 512),
          version = version + 1,
          updated_at = pg_catalog.clock_timestamp()
      WHERE account_id = p_account_id AND id = p_connection_id
        AND provider = p_provider AND kind = 'subscription' AND status = 'active'
        AND subscription_connections.refresh_generation = p_expected_refresh_generation;
      marked := FOUND;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'refresh_write'
        AND capability.account_id = p_account_id
        AND capability.connection_id = p_connection_id;
      RETURN marked;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.quarantine_subscription_core_connection(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_holder_id text, p_lease_generation bigint, p_expected_refresh_generation bigint, p_status text, p_last_error text, p_retry_at timestamp with time zone)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      capability_owner text;
      capability_human text;
      write_minted boolean := false;
      marked boolean := false;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_connection_id IS NULL OR p_session_id IS NULL OR p_turn_id IS NULL
        OR p_holder_id IS NULL OR length(btrim(p_holder_id)) NOT BETWEEN 1 AND 256
        OR p_lease_generation IS NULL OR p_lease_generation < 1
        OR p_expected_refresh_generation IS NULL OR p_expected_refresh_generation < 1
        OR p_status IS NULL OR p_status NOT IN ('needs_relogin', 'error')
        OR (p_status = 'needs_relogin' AND p_retry_at IS NOT NULL)
        OR (p_status = 'error' AND (p_retry_at IS NULL
          OR p_retry_at <= pg_catalog.clock_timestamp()
          OR p_retry_at > pg_catalog.clock_timestamp() + interval '1 day'))
      THEN RETURN false; END IF;

      IF NOT EXISTS (
        SELECT 1 FROM subscription_provider_cutovers cutover
        JOIN opengeni_private.subscription_core_providers registry ON registry.provider = cutover.provider
        WHERE cutover.account_id = p_account_id AND cutover.provider = p_provider
          AND cutover.enabled
      ) THEN RETURN false; END IF;

      SELECT capability.session_owner_subject_id, capability.turn_human_subject_id
        INTO capability_owner, capability_human
      FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'session_access'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.session_id = p_session_id
        AND capability.turn_id = p_turn_id;
      IF NOT FOUND THEN RETURN false; END IF;

      IF NOT EXISTS (
        SELECT 1 FROM subscription_leases lease
        WHERE lease.account_id = p_account_id AND lease.workspace_id = p_workspace_id
          AND lease.session_id = p_session_id AND lease.turn_id = p_turn_id
          AND lease.provider = p_provider AND lease.connection_id = p_connection_id
          AND lease.holder_id = p_holder_id AND lease.generation = p_lease_generation
          AND lease.leased_until > pg_catalog.clock_timestamp()
      ) THEN RETURN false; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        session_id, turn_id, connection_id, provider,
        session_owner_subject_id, turn_human_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'refresh_write',
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id, p_provider,
        capability_owner, capability_human
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO write_minted;
      IF write_minted IS DISTINCT FROM true THEN RETURN false; END IF;

      UPDATE subscription_connections
      SET status = p_status,
          last_error = left(coalesce(nullif(btrim(p_last_error), ''), 'Account refused the request'), 512),
          health_retry_at = p_retry_at,
          version = version + 1,
          updated_at = pg_catalog.clock_timestamp()
      WHERE account_id = p_account_id AND id = p_connection_id
        AND provider = p_provider AND kind = 'subscription' AND status = 'active'
        AND subscription_connections.refresh_generation = p_expected_refresh_generation;
      marked := FOUND;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'refresh_write'
        AND capability.account_id = p_account_id
        AND capability.connection_id = p_connection_id;
      RETURN marked;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.recover_subscription_core_connection_health(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid)
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      capability_owner text;
      capability_human text;
      target uuid;
      recovered integer := 0;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_session_id IS NULL OR p_turn_id IS NULL
      THEN RETURN 0; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM subscription_provider_cutovers cutover
        JOIN opengeni_private.subscription_core_providers registry ON registry.provider = cutover.provider
        WHERE cutover.account_id = p_account_id AND cutover.provider = p_provider
          AND cutover.enabled
      ) THEN RETURN 0; END IF;
      SELECT capability.session_owner_subject_id, capability.turn_human_subject_id
        INTO capability_owner, capability_human
      FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'session_access'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.session_id = p_session_id
        AND capability.turn_id = p_turn_id;
      IF NOT FOUND THEN RETURN 0; END IF;

      FOR target IN
        SELECT connection.id FROM subscription_connections connection
        WHERE connection.account_id = p_account_id AND connection.provider = p_provider
          AND connection.kind = 'subscription' AND connection.status = 'error'
          AND connection.health_retry_at IS NOT NULL
          AND connection.health_retry_at <= pg_catalog.clock_timestamp()
          AND CASE
            WHEN connection.ownership = 'personal' THEN
              capability_owner IS NOT NULL
              AND capability_human IS NOT DISTINCT FROM capability_owner
              AND connection.owner_subject_id = capability_owner
              AND EXISTS (
                SELECT 1 FROM organization_memberships membership
                WHERE membership.id = connection.owner_organization_membership_id
                  AND membership.account_id = p_account_id
                  AND membership.subject_id = capability_owner
                  AND membership.status = 'active' AND membership.revoked_at IS NULL
              )
              AND EXISTS (
                SELECT 1 FROM session_turns turn,
                  jsonb_array_elements(CASE
                    WHEN jsonb_typeof(turn.subscription_authority->'personal') = 'array'
                    THEN turn.subscription_authority->'personal' ELSE '[]'::jsonb
                  END) entry
                WHERE turn.account_id = p_account_id AND turn.workspace_id = p_workspace_id
                  AND turn.session_id = p_session_id AND turn.id = p_turn_id
                  AND turn.initiating_human_subject_id = capability_owner
                  AND turn.subscription_authority->>'version' = '2'
                  AND entry->>'provider' = p_provider
                  AND entry->>'ownerMembershipId' = connection.owner_organization_membership_id::text
                  AND entry->>'authorityGeneration' = connection.authority_generation::text
              )
            WHEN connection.ownership = 'shared' THEN
              opengeni_private.subscription_connection_visible(
                p_account_id, p_workspace_id, connection.id, connection.ownership,
                connection.scope_kind, connection.owner_organization_membership_id,
                connection.owner_subject_id, connection.provider
              )
            ELSE false
          END
        ORDER BY connection.id
      LOOP
        INSERT INTO opengeni_private.subscription_runtime_capabilities (
          backend_pid, transaction_id, capability_kind, account_id, workspace_id,
          session_id, turn_id, connection_id, provider,
          session_owner_subject_id, turn_human_subject_id
        ) VALUES (
          pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'refresh_write',
          p_account_id, p_workspace_id, p_session_id, p_turn_id, target, p_provider,
          capability_owner, capability_human
        ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
          DO NOTHING;
        UPDATE subscription_connections
        SET status = 'active', last_error = NULL, health_retry_at = NULL,
            version = version + 1, updated_at = pg_catalog.clock_timestamp()
        WHERE account_id = p_account_id AND id = target AND provider = p_provider
          AND status = 'error' AND health_retry_at IS NOT NULL
          AND health_retry_at <= pg_catalog.clock_timestamp();
        IF FOUND THEN recovered := recovered + 1; END IF;
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'refresh_write'
          AND capability.account_id = p_account_id
          AND capability.connection_id = target;
      END LOOP;
      RETURN recovered;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_core_acceptance_authority_v2(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_accepting_subject_id text)
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      request_subject text := nullif(current_setting('opengeni.subject_id', true), '');
      owner_subject text;
      owner_membership uuid;
      creator_kind text;
      creator_subject text;
      private_session boolean;
      membership_ok boolean := false;
      minted_lifecycle boolean := false;
      generations bigint[];
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
        OR owner_subject IS DISTINCT FROM p_accepting_subject_id
      THEN RETURN empty_v2; END IF;

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
        SELECT coalesce(array_agg(DISTINCT authority.generation ORDER BY authority.generation), '{}')
          INTO generations
        FROM subscription_connections connection
        JOIN organization_user_resource_authorities authority
          ON authority.id = connection.authority_id
          AND authority.account_id = connection.account_id
          AND authority.resource_kind = 'subscription_connection'
          AND authority.resource_id = connection.id
        WHERE connection.account_id = p_account_id
          AND connection.provider = p_provider AND connection.kind = 'subscription'
          AND connection.ownership = 'personal'
          AND connection.owner_organization_membership_id = owner_membership
          AND connection.owner_subject_id = owner_subject
          AND connection.status IN ('active', 'error')
          AND connection.authority_generation = authority.generation
          AND authority.organization_membership_id = owner_membership
          AND authority.status = 'active' AND authority.revoked_at IS NULL;
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
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_core_task_authority_v2(p_provider text, p_account_id uuid, p_workspace_id uuid, p_reusable_session_id uuid, p_accepting_subject_id text)
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      request_subject text := nullif(current_setting('opengeni.subject_id', true), '');
      owner_membership uuid;
      minted_lifecycle boolean := false;
      generations bigint[];
      empty_v2 constant jsonb := '{"version":2,"personal":[]}'::jsonb;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      THEN RETURN NULL; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM subscription_provider_cutovers cutover
        JOIN opengeni_private.subscription_core_providers registry ON registry.provider = cutover.provider
        WHERE cutover.account_id = p_account_id AND cutover.provider = p_provider
          AND cutover.enabled
      ) THEN RETURN NULL; END IF;
      IF p_reusable_session_id IS NOT NULL THEN
        RETURN coalesce(opengeni_private.subscription_core_acceptance_authority_v2(
          p_provider, p_account_id, p_workspace_id, p_reusable_session_id, p_accepting_subject_id), empty_v2);
      END IF;
      IF p_accepting_subject_id IS NULL OR length(btrim(p_accepting_subject_id)) = 0
        OR request_subject IS DISTINCT FROM p_accepting_subject_id
      THEN RETURN empty_v2; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'lifecycle', p_account_id)
      ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id) DO NOTHING
      RETURNING true INTO minted_lifecycle;
      minted_lifecycle := coalesce(minted_lifecycle, false);

      SELECT membership.id INTO owner_membership
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id AND membership.subject_id = p_accepting_subject_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND membership.personal_workspace_id = p_workspace_id;
      IF owner_membership IS NOT NULL THEN
        SELECT coalesce(array_agg(DISTINCT authority.generation ORDER BY authority.generation), '{}')
          INTO generations
        FROM subscription_connections connection
        JOIN organization_user_resource_authorities authority
          ON authority.id = connection.authority_id
          AND authority.account_id = connection.account_id
          AND authority.resource_kind = 'subscription_connection'
          AND authority.resource_id = connection.id
        WHERE connection.account_id = p_account_id
          AND connection.provider = p_provider AND connection.kind = 'subscription'
          AND connection.ownership = 'personal'
          AND connection.owner_organization_membership_id = owner_membership
          AND connection.owner_subject_id = p_accepting_subject_id
          AND connection.status IN ('active', 'error')
          AND connection.authority_generation = authority.generation
          AND authority.organization_membership_id = owner_membership
          AND authority.status = 'active' AND authority.revoked_at IS NULL;
      END IF;
      IF minted_lifecycle THEN
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'lifecycle' AND capability.account_id = p_account_id;
      END IF;
      IF owner_membership IS NULL OR cardinality(generations) <> 1 THEN RETURN empty_v2; END IF;
      RETURN jsonb_build_object(
        'version', 2,
        'personal', jsonb_build_array(jsonb_build_object(
          'provider', p_provider,
          'ownerMembershipId', owner_membership::text,
          'authorityGeneration', generations[1]
        ))
      );
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_core_revision_authority_v2(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_revision bigint)
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      THEN RETURN NULL; END IF;
      RETURN (SELECT revision.subscription_authority
        FROM scheduled_task_revision_authorities revision
        WHERE revision.account_id = p_account_id AND revision.workspace_id = p_workspace_id
          AND revision.task_id = p_task_id AND revision.task_authority_revision = p_revision);
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.read_subscription_core_connection_credential(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_operation_id uuid, p_attempt_id uuid, p_holder_id text, p_generation bigint)
    RETURNS TABLE(status text, ownership text, refresh_generation bigint, credential_encrypted text, expires_at timestamp with time zone, last_refresh_at timestamp with time zone, provider_account_id text, plan_type text, provider_state jsonb)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE target subscription_connections%%ROWTYPE;
    BEGIN
      SELECT * INTO target
      FROM opengeni_subscription_internal.subscription_core_connection_target(
        p_provider, p_account_id, p_workspace_id, p_connection_id,
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
      -- Provider-owned facts stay opaque here; only the provider's adapter
      -- interprets them (the provider-named routine decoded one flag).
      provider_state := coalesce(target.provider_state, '{}'::jsonb);
      RETURN NEXT;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.begin_subscription_core_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_operation_id uuid, p_attempt_id uuid, p_holder_id text, p_generation bigint)
    RETURNS TABLE(refresh_generation bigint, credential_encrypted text, expires_at timestamp with time zone)
    LANGUAGE plpgsql
    SECURITY DEFINER
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
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('subscription-refresh:' || p_connection_id::text, 0)
      );
      SELECT * INTO target
      FROM opengeni_subscription_internal.subscription_core_connection_target(
        p_provider, p_account_id, p_workspace_id, p_connection_id,
        p_operation_id, p_attempt_id, p_holder_id, p_generation
      );
      IF NOT FOUND OR target.status IS DISTINCT FROM 'active' THEN RETURN; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        connection_id, provider
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(),
        'connection_refresh_authorized', p_account_id, p_workspace_id, p_connection_id, p_provider
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO minted;
      IF minted IS DISTINCT FROM true THEN RETURN; END IF;

      refresh_generation := target.refresh_generation;
      credential_encrypted := target.credential_encrypted;
      expires_at := target.expires_at;
      RETURN NEXT;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.persist_subscription_core_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_credential_encrypted text, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    SET lock_timeout = '0'
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
        AND capability.capability_kind = 'connection_refresh_authorized'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.connection_id = p_connection_id
        AND capability.provider = p_provider;
      IF NOT FOUND THEN RETURN false; END IF;
      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        connection_id, provider
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'refresh_write',
        p_account_id, p_workspace_id, p_connection_id, p_provider
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
        AND provider = p_provider AND kind = 'subscription'
        AND subscription_connections.refresh_generation = p_expected_refresh_generation;
      refresh_persisted := FOUND;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'refresh_write'
        AND capability.account_id = p_account_id
        AND capability.connection_id = p_connection_id;
      RETURN refresh_persisted;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.fail_subscription_core_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_last_error text)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
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
        AND capability.capability_kind = 'connection_refresh_authorized'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.connection_id = p_connection_id
        AND capability.provider = p_provider;
      IF NOT FOUND THEN RETURN false; END IF;
      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        connection_id, provider
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'refresh_write',
        p_account_id, p_workspace_id, p_connection_id, p_provider
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO write_minted;
      IF write_minted IS DISTINCT FROM true THEN RETURN false; END IF;

      UPDATE subscription_connections
      SET status = 'needs_relogin',
          last_error = left(coalesce(nullif(btrim(p_last_error), ''), 'Sign-in expired'), 512),
          version = version + 1,
          updated_at = pg_catalog.clock_timestamp()
      WHERE account_id = p_account_id AND id = p_connection_id
        AND provider = p_provider AND kind = 'subscription' AND status = 'active'
        AND subscription_connections.refresh_generation = p_expected_refresh_generation;
      marked := FOUND;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'refresh_write'
        AND capability.account_id = p_account_id
        AND capability.connection_id = p_connection_id;
      RETURN marked;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.connect_subscription_core_personal(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_credential_encrypted text, p_provider_account_id text, p_provider_subject_id text, p_plan_type text, p_provider_state jsonb, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone, p_account_email text, p_label text, p_connected_by_subject_id text)
    RETURNS TABLE(outcome text, connection_id uuid, is_new boolean)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      owner_membership uuid;
      existing_id uuid;
      new_id uuid;
      authority uuid;
      authority_gen bigint;
      personal_allowed boolean;
    BEGIN
      IF NOT opengeni_subscription_internal.subscription_core_writer_context(
          p_provider, p_account_id, p_workspace_id, p_subject_id)
        OR p_credential_encrypted IS NULL OR length(p_credential_encrypted) = 0
        OR (p_provider_state IS NOT NULL AND jsonb_typeof(p_provider_state) <> 'object')
      THEN
        outcome := 'refused'; RETURN NEXT; RETURN;
      END IF;
      PERFORM opengeni_subscription_internal.grant_subscription_core_owner_capability(
        p_provider, 'connection_owner', p_account_id, p_workspace_id, p_subject_id,
        '00000000-0000-0000-0000-000000000000'::uuid);
      SELECT membership.id INTO owner_membership
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id AND membership.subject_id = p_subject_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND membership.personal_workspace_id = p_workspace_id;
      IF owner_membership IS NULL THEN
        PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
        outcome := 'not_personal_workspace'; RETURN NEXT; RETURN;
      END IF;
      personal_allowed := coalesce((subscription_effective_settings(p_account_id, p_workspace_id)
        #>> '{values,personalConnectionsAllowed}')::boolean, false);
      IF NOT personal_allowed THEN
        PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
        outcome := 'personal_connections_disabled'; RETURN NEXT; RETURN;
      END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'subscription-personal-authority:' || p_account_id::text || ':' || owner_membership::text, 0));
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'subscription-connect:' || p_account_id::text || ':' || p_provider || ':' || owner_membership::text
          || ':' || coalesce(p_provider_account_id, ''), 0));
      IF p_provider_account_id IS NULL OR p_provider_subject_id IS NULL
        OR p_provider_subject_id LIKE 'legacy:%%'
        OR EXISTS (SELECT 1 FROM subscription_connections connection
          WHERE connection.account_id = p_account_id AND connection.provider = p_provider
            AND connection.kind = 'subscription' AND connection.ownership = 'personal'
            AND connection.owner_organization_membership_id = owner_membership
            AND connection.provider_account_id = p_provider_account_id
            AND (connection.provider_subject_id IS NULL OR connection.provider_subject_id LIKE 'legacy:%%'))
      THEN
        PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
        outcome := 'identity_unverified'; RETURN NEXT; RETURN;
      END IF;
      IF p_provider_account_id IS NOT NULL THEN
        SELECT connection.id INTO existing_id
        FROM subscription_connections connection
        WHERE connection.account_id = p_account_id AND connection.provider = p_provider
          AND connection.kind = 'subscription' AND connection.ownership = 'personal'
          AND connection.owner_organization_membership_id = owner_membership
          AND connection.provider_account_id = p_provider_account_id
          AND connection.provider_subject_id = p_provider_subject_id;
      END IF;
      IF existing_id IS NOT NULL THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
          'subscription-refresh:' || existing_id::text, 0));
        PERFORM 1 FROM subscription_connections connection
        WHERE connection.account_id = p_account_id AND connection.id = existing_id
        FOR UPDATE;
        UPDATE subscription_connections connection SET
          credential_encrypted = p_credential_encrypted, credential_format = 'v1',
          expires_at = p_expires_at, last_refresh_at = p_last_refresh_at,
          refresh_generation = connection.refresh_generation + 1,
          version = connection.version + 1, status = 'active', last_error = NULL,
          plan_type = coalesce(p_plan_type, connection.plan_type),
          provider_state = connection.provider_state || coalesce(p_provider_state, '{}'::jsonb),
          account_email = coalesce(p_account_email, connection.account_email),
          label = coalesce(connection.label, p_label),
          connected_by_subject_id = p_connected_by_subject_id, updated_at = clock_timestamp()
        WHERE connection.account_id = p_account_id AND connection.id = existing_id;
        PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
        outcome := 'connected'; connection_id := existing_id; is_new := false;
        RETURN NEXT; RETURN;
      END IF;
      SELECT max(resource.generation) INTO authority_gen
      FROM subscription_connections connection
      JOIN organization_user_resource_authorities resource
        ON resource.account_id = connection.account_id AND resource.id = connection.authority_id
       AND resource.status = 'active' AND resource.revoked_at IS NULL
      WHERE connection.account_id = p_account_id AND connection.provider = p_provider
        AND connection.ownership = 'personal'
        AND connection.owner_organization_membership_id = owner_membership;
      IF authority_gen IS NULL THEN
        SELECT coalesce(max(resource.generation), 0) + 1 INTO authority_gen
        FROM organization_user_resource_authorities resource
        WHERE resource.account_id = p_account_id
          AND resource.organization_membership_id = owner_membership
          AND resource.resource_kind = 'subscription_connection';
      END IF;
      new_id := gen_random_uuid();
      INSERT INTO organization_user_resource_authorities (
        account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      ) VALUES (
        p_account_id, owner_membership, 'subscription_connection', new_id, p_workspace_id,
        authority_gen, 'active'
      ) RETURNING id INTO authority;
      INSERT INTO subscription_connections (
        id, account_id, provider, kind, provider_account_id, provider_subject_id, account_email, label, plan_type,
        credential_encrypted, credential_format, expires_at, last_refresh_at, status,
        ownership, owner_organization_membership_id, owner_subject_id, authority_id,
        authority_resource_kind, authority_generation, connected_by_subject_id, scope_kind,
        allow_personal_workspaces, managed_by_workspace_id, provider_state
      ) VALUES (
        new_id, p_account_id, p_provider, 'subscription', p_provider_account_id, p_provider_subject_id, p_account_email,
        p_label, p_plan_type, p_credential_encrypted, 'v1', p_expires_at, p_last_refresh_at,
        'active', 'personal', owner_membership, p_subject_id, authority,
        'subscription_connection', authority_gen, p_connected_by_subject_id, 'people', true, NULL,
        coalesce(p_provider_state, '{}'::jsonb)
      );
      PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
      outcome := 'connected'; connection_id := new_id; is_new := true;
      RETURN NEXT;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.disconnect_subscription_core_connection(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid)
    RETURNS text
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      target subscription_connections%%ROWTYPE;
      owner_personal_workspace uuid;
    BEGIN
      IF NOT opengeni_subscription_internal.subscription_core_writer_context(
          p_provider, p_account_id, p_workspace_id, p_subject_id) OR p_connection_id IS NULL THEN
        RETURN 'refused';
      END IF;
      PERFORM opengeni_subscription_internal.grant_subscription_core_owner_capability(
        p_provider, 'connection_owner', p_account_id, p_workspace_id, p_subject_id, p_connection_id);
      SELECT connection.* INTO target FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = p_provider AND connection.kind = 'subscription';
      IF NOT FOUND THEN
        PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
        RETURN 'not_found';
      END IF;
      IF target.ownership = 'shared' THEN
        IF NOT opengeni_private.subscription_organization_admin(p_account_id) THEN
          PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
          RETURN 'forbidden';
        END IF;
      ELSE
        SELECT membership.personal_workspace_id INTO owner_personal_workspace
        FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.id = target.owner_organization_membership_id
          AND membership.subject_id = p_subject_id;
        IF target.owner_subject_id IS DISTINCT FROM p_subject_id
          OR owner_personal_workspace IS DISTINCT FROM p_workspace_id THEN
          PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
          RETURN 'not_found';
        END IF;
      END IF;
      IF target.ownership = 'personal' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
          'subscription-personal-authority:' || p_account_id::text || ':' ||
          target.owner_organization_membership_id::text, 0));
      END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'subscription-refresh:' || p_connection_id::text, 0));
      PERFORM 1 FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
      FOR UPDATE;
      UPDATE subscription_connections connection SET
        disconnected_at = coalesce(connection.disconnected_at, clock_timestamp()),
        status = 'disabled', credential_encrypted = '', provider_account_id = NULL,
        allocator_enabled = false, expires_at = NULL, last_error = NULL,
        updated_at = clock_timestamp()
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.disconnected_at IS NULL;
      DELETE FROM subscription_apps_designations designation
      WHERE designation.account_id = p_account_id AND designation.connection_id = p_connection_id;
      IF target.ownership = 'personal' THEN
        UPDATE organization_user_resource_authorities resource
        SET status = 'revoked', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE resource.account_id = p_account_id AND resource.id = target.authority_id
          AND resource.resource_id = p_connection_id AND resource.status <> 'revoked';
      END IF;
      PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
      RETURN 'removed';
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.manage_subscription_core_personal(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid, p_action text, p_label text, p_enabled boolean, p_expected_version integer)
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE target subscription_connections%%ROWTYPE; result jsonb; mode text;
      registry opengeni_private.subscription_core_providers%%ROWTYPE;
    BEGIN
      IF NOT opengeni_subscription_internal.subscription_core_writer_context(p_provider, p_account_id, p_workspace_id, p_subject_id)
        OR p_action NOT IN ('resolve', 'rename', 'allocator', 'primary', 'extra_credits') OR p_connection_id IS NULL
      THEN RETURN NULL; END IF;
      SELECT provider_row.* INTO registry FROM opengeni_private.subscription_core_providers provider_row
      WHERE provider_row.provider = p_provider;
      IF NOT FOUND OR (p_action = 'extra_credits' AND NOT registry.extra_credits)
        OR (p_action = 'primary' AND registry.primary_setting_column IS NULL)
      THEN RETURN NULL; END IF;
      PERFORM opengeni_subscription_internal.grant_subscription_core_owner_capability(
        p_provider, 'connection_owner', p_account_id, p_workspace_id, p_subject_id,
        '00000000-0000-0000-0000-000000000000'::uuid);
      SELECT coalesce((SELECT alias.connection_id FROM subscription_connection_aliases alias
        WHERE alias.account_id = p_account_id AND alias.provider = p_provider
          AND alias.alias_connection_id = p_connection_id), p_connection_id) INTO p_connection_id;
      SELECT connection.* INTO target FROM subscription_connections connection
      JOIN organization_memberships membership
        ON membership.account_id = connection.account_id AND membership.id = connection.owner_organization_membership_id
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = p_provider AND connection.ownership = 'personal'
        AND connection.owner_subject_id = p_subject_id AND membership.subject_id = p_subject_id
        AND membership.personal_workspace_id = p_workspace_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL;
      IF NOT FOUND THEN
        PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
        RETURN NULL;
      END IF;
      result := jsonb_build_object('id', target.id, 'kind', 'unchanged');
      IF p_action <> 'resolve' THEN
        SELECT * INTO target FROM subscription_connections WHERE id = target.id FOR UPDATE;
        IF NOT FOUND OR target.disconnected_at IS NOT NULL THEN
          PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
          RETURN NULL;
        END IF;
      END IF;
      IF p_action = 'rename' THEN
        UPDATE subscription_connections SET label = nullif(left(btrim(p_label), 200), ''),
          version = version + 1, updated_at = clock_timestamp() WHERE id = target.id;
      ELSIF p_action = 'allocator' THEN
        IF p_enabled IS NULL OR p_expected_version IS NULL THEN
          PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
          RETURN NULL;
        END IF;
        IF target.allocator_enabled IS DISTINCT FROM p_enabled THEN
          IF target.allocator_version <> p_expected_version THEN
            result := result || '{"kind":"conflict"}'::jsonb;
          ELSE
            UPDATE subscription_connections SET allocator_enabled = p_enabled,
              allocator_version = allocator_version + 1, updated_at = clock_timestamp()
            WHERE id = target.id RETURNING * INTO target;
            result := result || '{"kind":"updated"}'::jsonb;
          END IF;
        END IF;
        result := result || jsonb_build_object('allocatorEnabled', target.allocator_enabled,
          'allocatorVersion', target.allocator_version, 'allocatorUpdatedAt', target.updated_at);
      ELSIF p_action = 'extra_credits' THEN
        IF p_enabled IS NULL OR p_expected_version IS NULL THEN
          PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
          RETURN NULL;
        END IF;
        IF target.extra_credits_enabled IS DISTINCT FROM p_enabled THEN
          IF target.extra_credits_version <> p_expected_version THEN
            result := result || '{"kind":"conflict"}'::jsonb;
          ELSE
            UPDATE subscription_connections SET extra_credits_enabled = p_enabled,
              extra_credits_version = extra_credits_version + 1,
              extra_credits_updated_by_subject_id = p_subject_id,
              extra_credits_updated_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE id = target.id RETURNING * INTO target;
            result := result || '{"kind":"updated"}'::jsonb;
          END IF;
        END IF;
        result := result || jsonb_build_object('extraCreditsEnabled', target.extra_credits_enabled,
          'extraCreditsVersion', target.extra_credits_version,
          'extraCreditsUpdatedAt', target.extra_credits_updated_at);
      ELSIF p_action = 'primary' THEN
        mode := coalesce(subscription_effective_settings(p_account_id, p_workspace_id)
          #>> ARRAY['values', 'rotation', p_provider, 'mode'], 'spread');
        -- The provider's primary column comes from its registry row (owner
        -- data, format-checked) until settings are keyed by provider.
        EXECUTE pg_catalog.format(
          'INSERT INTO subscription_settings (account_id, workspace_id, rotation, %%1$I,
             updated_by_subject_id) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (account_id, workspace_id) DO UPDATE SET
             rotation = coalesce(subscription_settings.rotation, ''{}''::jsonb) || EXCLUDED.rotation,
             %%1$I = EXCLUDED.%%1$I,
             updated_by_subject_id = $5, version = subscription_settings.version + 1,
             updated_at = clock_timestamp()', registry.primary_setting_column)
        USING p_account_id, p_workspace_id,
          jsonb_build_object(p_provider, jsonb_build_object('mode', mode)), target.id, p_subject_id;
      END IF;
      PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
      RETURN result;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_core_personal_connections(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text)
    RETURNS TABLE(id uuid, label text, account_email text, plan_type text, provider_account_id text, status text, last_error text, allocator_enabled boolean, allocator_version integer, allowed_model_ids text[], connected_by_subject_id text, expires_at timestamp with time zone, last_refresh_at timestamp with time zone, provider_state jsonb, updated_at timestamp with time zone, quota jsonb, quota_revision bigint, quota_observed_refresh_generation bigint, quota_updated_at timestamp with time zone, extra_credits_enabled boolean, extra_credits_version integer, extra_credits_updated_at timestamp with time zone)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF NOT opengeni_subscription_internal.subscription_core_writer_context(
          p_provider, p_account_id, p_workspace_id, p_subject_id) THEN
        RETURN;
      END IF;
      PERFORM opengeni_subscription_internal.grant_subscription_core_owner_capability(
        p_provider, 'connection_owner', p_account_id, p_workspace_id, p_subject_id,
        '00000000-0000-0000-0000-000000000000'::uuid);
      IF EXISTS (SELECT 1 FROM organization_memberships membership
          WHERE membership.account_id = p_account_id AND membership.subject_id = p_subject_id
            AND membership.status = 'active' AND membership.revoked_at IS NULL
            AND (membership.personal_workspace_id = p_workspace_id
              OR EXISTS (SELECT 1 FROM workspace_memberships grant_row
                WHERE grant_row.account_id = p_account_id
                  AND grant_row.workspace_id = p_workspace_id
                  AND grant_row.subject_id = p_subject_id))) THEN
        RETURN QUERY
        SELECT connection.id, connection.label, connection.account_email, connection.plan_type,
          connection.provider_account_id, connection.status, connection.last_error,
          connection.allocator_enabled, connection.allocator_version,
          connection.allowed_model_ids, connection.connected_by_subject_id,
          connection.expires_at, connection.last_refresh_at, connection.provider_state,
          connection.updated_at, quota.quota, quota.revision::bigint,
          quota.observed_refresh_generation, quota.updated_at,
          connection.extra_credits_enabled, connection.extra_credits_version,
          connection.extra_credits_updated_at
        FROM subscription_connections connection
        LEFT JOIN subscription_connection_quota quota
          ON quota.account_id = connection.account_id AND quota.connection_id = connection.id
        WHERE connection.account_id = p_account_id AND connection.provider = p_provider
          AND connection.kind = 'subscription' AND connection.ownership = 'personal'
          AND connection.owner_subject_id = p_subject_id AND connection.disconnected_at IS NULL
        ORDER BY connection.created_at, connection.id;
      END IF;
      PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
    END
    $body$
  $ddl$, data_schema);
END
$install$;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_core_writer_context(
  text, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_subscription_internal.grant_subscription_core_owner_capability(
  text, text, uuid, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_subscription_internal.drop_subscription_core_owner_capabilities(
  text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_core_connection_target(
  text, uuid, uuid, uuid, uuid, uuid, text, bigint) FROM PUBLIC;

-- Every opengeni_private routine below is granted to the runtime role (a
-- previous binary requires EXECUTE on each private routine it does not know)
-- and to nobody else.
DO $grant_neutral_routines$
DECLARE routine_signature text;
BEGIN
  FOREACH routine_signature IN ARRAY ARRAY[
    'subscription_core_owner_capability_held(text,uuid,text[],text,uuid,boolean)',
    'subscription_core_owner_membership_held(uuid,uuid)',
    'subscription_core_refresh_write_allowed(text,uuid,uuid,uuid)',
    'begin_subscription_core_refresh(text,uuid,uuid,uuid,uuid,text,text,uuid,text,bigint)',
    'persist_subscription_core_refresh(text,uuid,uuid,uuid,uuid,uuid,bigint,text,timestamptz,timestamptz)',
    'persist_subscription_core_refresh_with_plan(text,uuid,uuid,uuid,uuid,uuid,bigint,text,timestamptz,timestamptz,text)',
    'fail_subscription_core_refresh(text,uuid,uuid,uuid,uuid,uuid,bigint,text)',
    'quarantine_subscription_core_connection(text,uuid,uuid,uuid,uuid,uuid,text,bigint,bigint,text,text,timestamptz)',
    'recover_subscription_core_connection_health(text,uuid,uuid,uuid,uuid)',
    'subscription_core_acceptance_authority_v2(text,uuid,uuid,uuid,text)',
    'subscription_core_task_authority_v2(text,uuid,uuid,uuid,text)',
    'subscription_core_revision_authority_v2(uuid,uuid,uuid,bigint)',
    'read_subscription_core_connection_credential(text,uuid,uuid,uuid,uuid,uuid,text,bigint)',
    'begin_subscription_core_connection_refresh(text,uuid,uuid,uuid,uuid,uuid,text,bigint)',
    'persist_subscription_core_connection_refresh(text,uuid,uuid,uuid,bigint,text,timestamptz,timestamptz)',
    'fail_subscription_core_connection_refresh(text,uuid,uuid,uuid,bigint,text)',
    'connect_subscription_core_personal(text,uuid,uuid,text,text,text,text,text,jsonb,timestamptz,timestamptz,text,text,text)',
    'disconnect_subscription_core_connection(text,uuid,uuid,text,uuid)',
    'manage_subscription_core_personal(text,uuid,uuid,text,uuid,text,text,boolean,integer)',
    'subscription_core_personal_connections(text,uuid,uuid,text)',
    -- Only ever fired by the registry triggers (the runtime cannot write the
    -- registry), but runtime posture requires EXECUTE on every private routine.
    'guard_subscription_provider_registry()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%s FROM PUBLIC', routine_signature);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.%s TO opengeni_app',
        routine_signature);
    END IF;
  END LOOP;
END
$grant_neutral_routines$;

-- 2. Owner-only policies admitting the neutral kinds, one for one with the
-- provider-named policies of migrations 0667 and 0688. On rows that carry a
-- provider (connections, aliases, leases) a capability admits only rows of
-- the provider it was minted for. Memberships, authorities, settings and
-- Apps designations carry no provider: they admit the owner's own rows for
-- any provider's owner capability, pinned to the capability's account and,
-- per table, to the owner's subject (memberships, authority insert and
-- read), the exact connection (authority revoke, Apps designations) or the
-- current workspace (settings), exactly as the provider-named policies do.
-- Every writer drops its capability before returning.
CREATE POLICY subscription_core_refresh_read ON subscription_connections FOR SELECT
  USING (opengeni_private.subscription_core_refresh_write_allowed(
    provider, account_id, nullif(current_setting('opengeni.workspace_id', true), '')::uuid, id));
CREATE POLICY subscription_core_refresh_update ON subscription_connections FOR UPDATE
  USING (opengeni_private.subscription_core_refresh_write_allowed(
    provider, account_id, nullif(current_setting('opengeni.workspace_id', true), '')::uuid, id))
  WITH CHECK (opengeni_private.subscription_core_refresh_write_allowed(
    provider, account_id, nullif(current_setting('opengeni.workspace_id', true), '')::uuid, id));

CREATE POLICY subscription_core_owner_membership_read ON organization_memberships FOR SELECT
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation WHERE relation.oid = 'organization_memberships'::regclass))
    AND opengeni_private.subscription_core_owner_capability_held(
      NULL, account_id, ARRAY['connection_owner'], subject_id, NULL, false));

CREATE POLICY subscription_core_owner_authority_read ON organization_user_resource_authorities
  FOR SELECT
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'organization_user_resource_authorities'::regclass))
    AND resource_kind = 'subscription_connection'
    AND opengeni_private.subscription_core_owner_membership_held(
      account_id, organization_membership_id));
CREATE POLICY subscription_core_owner_authority_insert ON organization_user_resource_authorities
  FOR INSERT
  WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'organization_user_resource_authorities'::regclass))
    AND resource_kind = 'subscription_connection' AND status = 'active'
    AND opengeni_private.subscription_core_owner_membership_held(
      account_id, organization_membership_id));
CREATE POLICY subscription_core_owner_authority_revoke ON organization_user_resource_authorities
  FOR UPDATE
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'organization_user_resource_authorities'::regclass))
    AND resource_kind = 'subscription_connection'
    AND opengeni_private.subscription_core_owner_capability_held(
      NULL, account_id, ARRAY['connection_owner'], NULL, resource_id, false))
  WITH CHECK (status = 'revoked');

CREATE POLICY subscription_core_owner_alias_read ON subscription_connection_aliases FOR SELECT
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation WHERE relation.oid = 'subscription_connection_aliases'::regclass))
    AND opengeni_private.subscription_core_owner_capability_held(
      provider, account_id, ARRAY['connection_owner'], NULL, connection_id, true));

CREATE POLICY subscription_core_owner_connections ON subscription_connections FOR ALL
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation WHERE relation.oid = 'subscription_connections'::regclass))
    AND ownership = 'personal'
    AND opengeni_private.subscription_core_owner_capability_held(
      provider, account_id, ARRAY['connection_owner'], owner_subject_id, id, true))
  WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation WHERE relation.oid = 'subscription_connections'::regclass))
    AND ownership = 'personal'
    AND opengeni_private.subscription_core_owner_capability_held(
      provider, account_id, ARRAY['connection_owner'], owner_subject_id, id, true));

-- Expired leases of the exact connection, as in migration 0688. The
-- restrictive session policy keeps its live expression (ordinary and
-- provider-named clauses, read from the catalog) and gains the neutral one.
DO $expired_core_leases$
DECLARE table_name text; live_clause text; core_clause text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['subscription_leases', 'subscription_operation_leases'] LOOP
    SELECT pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) INTO live_clause
    FROM pg_catalog.pg_policy policy
    WHERE policy.polrelid = pg_catalog.to_regclass(table_name)
      AND policy.polname = 'session_visibility_isolation';
    IF live_clause IS NULL
      OR pg_catalog.strpos(live_clause, 'subscription_codex_owner_capability_held') = 0
      OR pg_catalog.strpos(live_clause, 'subscription_core_owner_capability_held') <> 0 THEN
      RAISE EXCEPTION '0707 % session policy drift', table_name USING ERRCODE = '55000';
    END IF;
    core_clause := format(
      'current_user = pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid = %L::regclass)) AND leased_until <= clock_timestamp() AND opengeni_private.subscription_core_owner_capability_held(provider, account_id, ARRAY[''connection_owner''], NULL, connection_id, false)', table_name);
    EXECUTE format('ALTER POLICY session_visibility_isolation ON %I USING ((%s) OR (%s))',
      table_name, live_clause, core_clause);
    EXECUTE format('CREATE POLICY subscription_core_expired_lease_read ON %I FOR SELECT USING (%s)', table_name, core_clause);
    EXECUTE format('CREATE POLICY subscription_core_expired_lease_delete ON %I FOR DELETE USING (%s)', table_name, core_clause);
  END LOOP;
END
$expired_core_leases$;

CREATE POLICY subscription_core_owner_settings ON subscription_settings FOR ALL
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
      WHERE oid = 'subscription_settings'::regclass))
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND opengeni_private.subscription_core_owner_capability_held(
      NULL, account_id, ARRAY['connection_owner'], NULL, NULL, false)
    AND cardinality(locked_settings) = 0);

CREATE POLICY subscription_core_disconnect_designation ON subscription_apps_designations
  FOR DELETE
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT pg_class.relowner
      FROM pg_catalog.pg_class WHERE pg_class.oid = 'subscription_apps_designations'::regclass))
    AND opengeni_private.subscription_core_owner_capability_held(
      NULL, account_id, ARRAY['connection_owner'], NULL, connection_id, false));
CREATE POLICY subscription_core_disconnect_designation_read ON subscription_apps_designations
  FOR SELECT
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT pg_class.relowner
      FROM pg_catalog.pg_class WHERE pg_class.oid = 'subscription_apps_designations'::regclass))
    AND opengeni_private.subscription_core_owner_capability_held(
      NULL, account_id, ARRAY['connection_owner'], NULL, connection_id, false));

-- 4. Disconnect admission by registry membership (migrations 0691, 0697,
-- 0699 patched this trigger; patch only the two provider tests).
DO $admission$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.guard_subscription_disconnect_admission()'::regprocedure);
  FOR anchor, replacement IN VALUES
    ($old$IF NEW.provider <> 'codex' OR NEW.connection_id IS NULL THEN RETURN NEW; END IF;$old$,
     $new$IF NEW.connection_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM opengeni_private.subscription_core_providers registry
    WHERE registry.provider = NEW.provider) THEN RETURN NEW; END IF;$new$),
    ($old$AND prior.provider = 'codex' AND prior.operation_kind = 'model'$old$,
     $new$AND prior.provider = NEW.provider AND prior.operation_kind = 'model'$new$),
    ($old$'prior Codex request outcome is unresolved'$old$,
     $new$'prior request outcome is unresolved'$new$)
  LOOP
    IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
      RAISE EXCEPTION 'subscription disconnect admission source changed';
    END IF;
    definition := replace(definition, anchor, replacement);
  END LOOP;
  EXECUTE definition;
END
$admission$;

-- 6. Temporary tables must not shadow the rows the guard triggers check.
DO $guard_paths$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.guard_subscription_disconnect_admission() '
    'SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION opengeni_private.guard_subscription_designation_disconnect() '
    'SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$guard_paths$;

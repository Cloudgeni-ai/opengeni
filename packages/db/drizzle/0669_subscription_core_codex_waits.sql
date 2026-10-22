-- deployment-mode: rolling
-- M3 PR 2a: durable waits, connection health and accepted authority for Codex
-- chat turns on the shared subscription core. Everything here is inert while
-- no Codex cutover row is enabled: the new columns are nullable on tables the
-- legacy path never reads, and every routine refuses unless the account's
-- Codex cutover is enabled (or, for wake fanout, only bumps core waiter rows
-- that exist only after cutover). Claude and xAI are untouched.
--
-- 1. subscription_capacity_waiters gains the goal fence and the last wake
--    reason the Codex wait state machine needs (legacy parity), so a goal
--    continuation that changed while it waited is superseded, not resumed.
-- 2. subscription_connections gains health_retry_at: a 403 refusal (only a
--    401 triggers a refresh first) quarantines the connection (status
--    'error') until that time, after which the next placement that can see
--    it returns it to service. A trigger clears the retry time on any other
--    status or error change, so recovery only ends its own quarantine.
-- 3. quarantine_subscription_codex_connection writes that health change only
--    for the exact accepted turn that holds the live lease on the connection,
--    under the refresh-generation compare-and-swap, so a refusal seen with an
--    older credential cannot quarantine a renewed one.
-- 4. recover_subscription_codex_connection_health returns due quarantined
--    connections to service. It is callable only inside an exact accepted
--    turn's placement transaction and only touches connections that turn can
--    see: shared rows by the ordinary visibility rule, personal rows only for
--    the owner's own turn.
-- 5. persist_subscription_codex_refresh_with_plan is persist plus the plan
--    carried by the rotated id_token. A changed plan clears model cooldowns
--    (plan-entitlement exclusions) so the connection may serve again.
-- 6. subscription_codex_acceptance_authority_v2 computes the Codex entry of
--    the immutable v2 accepted authority at acceptance: a personal entry only
--    for exact owner-caused acceptance in the owner's private session or
--    Personal workspace with one current authority generation across the
--    owner's serviceable personal Codex connections; an empty v2 value
--    otherwise; NULL while the Codex cutover is not enabled.

SET LOCAL lock_timeout = '5s';

ALTER TABLE subscription_capacity_waiters
  ADD COLUMN goal_id uuid,
  ADD COLUMN goal_version bigint,
  ADD COLUMN last_wake_reason text,
  ADD CONSTRAINT subscription_capacity_waiters_goal_fence_chk CHECK (
    (goal_id IS NULL AND goal_version IS NULL)
    OR (goal_id IS NOT NULL AND goal_version IS NOT NULL AND goal_version > 0)
  ) NOT VALID,
  ADD CONSTRAINT subscription_capacity_waiters_last_wake_reason_chk CHECK (
    last_wake_reason IS NULL OR length(btrim(last_wake_reason)) BETWEEN 1 AND 128
  ) NOT VALID;

ALTER TABLE subscription_connections
  ADD COLUMN health_retry_at timestamptz;

COMMENT ON COLUMN subscription_connections.health_retry_at IS
  'When a quarantined (status error) connection may serve again. NULL means the status is not time-bound.';

-- health_retry_at belongs to exactly one quarantine. Any write that changes
-- the status or the error without setting the retry time itself (an
-- administrator, a sign-in failure, a failed refresh that marks the
-- connection) ends that quarantine's claim, so health recovery can never
-- clear an error it did not write. A successful refresh changes neither, so
-- the quarantine stands.
DO $health_retry_owner$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.clear_subscription_connection_health_retry()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $body$
    BEGIN
      IF OLD.health_retry_at IS NOT NULL
        AND NEW.health_retry_at IS NOT DISTINCT FROM OLD.health_retry_at
        AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.last_error IS DISTINCT FROM OLD.last_error)
      THEN
        NEW.health_retry_at := NULL;
      END IF;
      RETURN NEW;
    END;
    $body$;
  $ddl$, data_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.clear_subscription_connection_health_retry() FROM PUBLIC',
    data_schema
  );
  EXECUTE format($ddl$
    CREATE TRIGGER subscription_connections_health_retry_trg
    BEFORE UPDATE ON %1$I.subscription_connections
    FOR EACH ROW
    EXECUTE FUNCTION %1$I.clear_subscription_connection_health_retry()
  $ddl$, data_schema);
END
$health_retry_owner$;

DO $quarantine_codex_connection$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.quarantine_subscription_codex_connection(
      p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
      p_connection_id uuid, p_holder_id text, p_lease_generation bigint,
      p_expected_refresh_generation bigint, p_status text, p_last_error text,
      p_retry_at timestamptz
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
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
        -- A sign-in that the provider revoked never clears by itself; a 403
        -- quarantine is always time-bound and at most one day long.
        OR (p_status = 'needs_relogin' AND p_retry_at IS NOT NULL)
        OR (p_status = 'error' AND (p_retry_at IS NULL
          OR p_retry_at <= pg_catalog.clock_timestamp()
          OR p_retry_at > pg_catalog.clock_timestamp() + interval '1 day'))
      THEN RETURN false; END IF;

      IF NOT EXISTS (
        SELECT 1 FROM subscription_provider_cutovers cutover
        WHERE cutover.account_id = p_account_id AND cutover.provider = 'codex'
          AND cutover.enabled
      ) THEN RETURN false; END IF;

      -- The caller must already hold the exact accepted turn's session access
      -- in this transaction (withSubscriptionCoreAcceptedTurn).
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

      -- Only the turn that holds the live lease on this connection may report
      -- that the connection refused it.
      IF NOT EXISTS (
        SELECT 1 FROM subscription_leases lease
        WHERE lease.account_id = p_account_id AND lease.workspace_id = p_workspace_id
          AND lease.session_id = p_session_id AND lease.turn_id = p_turn_id
          AND lease.provider = 'codex' AND lease.connection_id = p_connection_id
          AND lease.holder_id = p_holder_id AND lease.generation = p_lease_generation
          AND lease.leased_until > pg_catalog.clock_timestamp()
      ) THEN RETURN false; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        session_id, turn_id, connection_id, provider,
        session_owner_subject_id, turn_human_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'codex_refresh_write',
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id, 'codex',
        capability_owner, capability_human
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO write_minted;
      IF write_minted IS DISTINCT FROM true THEN RETURN false; END IF;

      -- Health only: no credential column changes, no metadata version bump
      -- beyond the row's own. The generation CAS keeps a refusal of an older
      -- token family off a credential renewed meanwhile.
      UPDATE subscription_connections
      SET status = p_status,
          last_error = left(coalesce(nullif(btrim(p_last_error), ''), 'Codex account refused the request'), 512),
          health_retry_at = p_retry_at,
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
$quarantine_codex_connection$;

DO $recover_codex_connection_health$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.recover_subscription_codex_connection_health(
      p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid
    ) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
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
        WHERE cutover.account_id = p_account_id AND cutover.provider = 'codex'
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

      -- Only rows this accepted turn can already see, and only quarantines
      -- this mechanism wrote (status error with a retry time; any other
      -- status or error change clears the retry time, see the trigger below).
      -- Sign-in failures and administrator status changes are never touched.
      -- Shared rows use the ordinary visibility rule for this workspace and
      -- turn. A personal row only for the owner's own turn (session owner and
      -- turn human both the row's owner, owner membership still active) whose
      -- frozen v2 accepted authority names this owner membership and the
      -- row's authority generation: exactly the rows placement could lease.
      FOR target IN
        SELECT connection.id FROM subscription_connections connection
        WHERE connection.account_id = p_account_id AND connection.provider = 'codex'
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
                  -- The frozen turn human, not the capability's: a service or
                  -- API-key turn records the owner as its effective human.
                  AND turn.initiating_human_subject_id = capability_owner
                  AND turn.subscription_authority->>'version' = '2'
                  AND entry->>'provider' = 'codex'
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
          pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'codex_refresh_write',
          p_account_id, p_workspace_id, p_session_id, p_turn_id, target, 'codex',
          capability_owner, capability_human
        ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
          DO NOTHING;
        UPDATE subscription_connections
        SET status = 'active', last_error = NULL, health_retry_at = NULL,
            version = version + 1, updated_at = pg_catalog.clock_timestamp()
        WHERE account_id = p_account_id AND id = target AND provider = 'codex'
          AND status = 'error' AND health_retry_at IS NOT NULL
          AND health_retry_at <= pg_catalog.clock_timestamp();
        IF FOUND THEN recovered := recovered + 1; END IF;
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'codex_refresh_write'
          AND capability.account_id = p_account_id
          AND capability.connection_id = target;
      END LOOP;
      RETURN recovered;
    END
    $body$
  $ddl$, data_schema);
END
$recover_codex_connection_health$;

DO $persist_codex_refresh_with_plan$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.persist_subscription_codex_refresh_with_plan(
      p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
      p_connection_id uuid, p_expected_refresh_generation bigint,
      p_credential_encrypted text, p_expires_at timestamptz, p_last_refresh_at timestamptz,
      p_plan_type text
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    -- The provider has already rotated the token: wait for a briefly held
    -- connection row rather than abort the transaction and discard it.
    SET lock_timeout = 0
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

      -- Consume the one-shot authorization begin minted in this transaction.
      -- The advisory transaction lock it took is still held.
      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'codex_refresh_authorized'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.session_id = p_session_id
        AND capability.turn_id = p_turn_id
        AND capability.connection_id = p_connection_id
        AND capability.provider = 'codex'
      RETURNING capability.session_owner_subject_id, capability.turn_human_subject_id
        INTO capability_owner, capability_human;
      IF NOT FOUND THEN RETURN false; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        session_id, turn_id, connection_id, provider,
        session_owner_subject_id, turn_human_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'codex_refresh_write',
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id, 'codex',
        capability_owner, capability_human
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO write_minted;
      IF write_minted IS DISTINCT FROM true THEN RETURN false; END IF;

      SELECT connection.plan_type INTO previous_plan
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = 'codex';

      -- Same compare-and-swap as persist_subscription_codex_refresh. A plan
      -- the id_token did not carry keeps the recorded plan.
      UPDATE subscription_connections
      SET credential_encrypted = p_credential_encrypted,
          credential_format = split_part(p_credential_encrypted, ':', 1),
          expires_at = p_expires_at,
          last_refresh_at = p_last_refresh_at,
          plan_type = coalesce(plan_value, subscription_connections.plan_type),
          refresh_generation = subscription_connections.refresh_generation + 1,
          updated_at = pg_catalog.clock_timestamp()
      WHERE account_id = p_account_id AND id = p_connection_id
        AND provider = 'codex' AND kind = 'subscription'
        AND subscription_connections.refresh_generation = p_expected_refresh_generation;
      refresh_persisted := FOUND;

      -- A plan change is the only signal that a plan-entitlement refusal may
      -- no longer hold; drop the connection's model cooldowns so placement
      -- may try the model again instead of waiting for their expiry.
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
        AND capability.capability_kind = 'codex_refresh_write'
        AND capability.account_id = p_account_id
        AND capability.connection_id = p_connection_id;
      RETURN refresh_persisted;
    END
    $body$
  $ddl$, data_schema);
END
$persist_codex_refresh_with_plan$;

DO $codex_acceptance_authority_v2$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_codex_acceptance_authority_v2(
      p_account_id uuid, p_workspace_id uuid, p_session_id uuid,
      p_accepting_subject_id text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
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

      -- v1 stays authoritative until the drained cutover: write nothing.
      IF NOT EXISTS (
        SELECT 1 FROM subscription_provider_cutovers cutover
        WHERE cutover.account_id = p_account_id AND cutover.provider = 'codex'
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

      -- Exact owner-caused acceptance: the authenticated request subject is
      -- the owner, or (trusted session-start context without a subject) the
      -- session's frozen creator is the owner.
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
        -- Only the owner's own personal Codex connections count, through
        -- their exact active authority (the join placement uses), and only
        -- those that can serve without a human: active, or in a time-bound
        -- health quarantine. A connection waiting for a new sign-in or
        -- disabled, and every other provider's authority, cannot make the
        -- generation ambiguous.
        SELECT coalesce(array_agg(DISTINCT authority.generation ORDER BY authority.generation), '{}')
          INTO generations
        FROM subscription_connections connection
        JOIN organization_user_resource_authorities authority
          ON authority.id = connection.authority_id
          AND authority.account_id = connection.account_id
          AND authority.resource_kind = 'subscription_connection'
          AND authority.resource_id = connection.id
        WHERE connection.account_id = p_account_id
          AND connection.provider = 'codex' AND connection.kind = 'subscription'
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

      -- One current generation, or nothing: when the owner's Codex
      -- connections still carry different generations (a re-grant not yet
      -- applied to all of them) or there are none, freeze no personal
      -- authority (shared capacity only). Strictest; never a wider grant.
      IF NOT membership_ok OR cardinality(generations) <> 1 THEN RETURN empty_v2; END IF;
      RETURN jsonb_build_object(
        'version', 2,
        'personal', jsonb_build_array(jsonb_build_object(
          'provider', 'codex',
          'ownerMembershipId', owner_membership::text,
          'authorityGeneration', generations[1]
        ))
      );
    END
    $body$
  $ddl$, data_schema);
END
$codex_acceptance_authority_v2$;

REVOKE ALL ON FUNCTION opengeni_private.quarantine_subscription_codex_connection(
  uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.recover_subscription_codex_connection_health(
  uuid, uuid, uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.persist_subscription_codex_refresh_with_plan(
  uuid, uuid, uuid, uuid, uuid, bigint, text, timestamptz, timestamptz, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_acceptance_authority_v2(
  uuid, uuid, uuid, text
) FROM PUBLIC;

DO $grant_codex_waits$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.quarantine_subscription_codex_connection(
      uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text, text, timestamptz
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.recover_subscription_codex_connection_health(
      uuid, uuid, uuid, uuid
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.persist_subscription_codex_refresh_with_plan(
      uuid, uuid, uuid, uuid, uuid, bigint, text, timestamptz, timestamptz, text
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_codex_acceptance_authority_v2(
      uuid, uuid, uuid, text
    ) TO opengeni_app;
  END IF;
END
$grant_codex_waits$;

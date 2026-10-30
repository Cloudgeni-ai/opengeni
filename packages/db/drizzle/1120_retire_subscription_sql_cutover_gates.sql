-- deployment-mode: rolling
-- The application cut over to subscription-core in PR #6436. Remove the
-- remaining per-account switches in its SQL callers, not any live authority
-- fence. Provider protocol receipts remain required by the current policies.
-- No table, grant, policy, function identity or accepted snapshot is removed.

SET LOCAL lock_timeout = '5s';

-- Take the cutover-table lock before reading all tenants. The production
-- migration owner is NOSUPERUSER NOBYPASSRLS; this window changes only its
-- visibility and is rolled back atomically if a predecessor has not cut over.
ALTER TABLE subscription_provider_cutovers NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM managed_accounts account
    CROSS JOIN opengeni_private.subscription_core_providers provider
    LEFT JOIN subscription_provider_cutovers cutover
      ON cutover.account_id = account.id AND cutover.provider = provider.provider
    WHERE cutover.enabled IS DISTINCT FROM true
  ) OR EXISTS (
    SELECT 1 FROM opengeni_private.subscription_core_providers provider
    WHERE NOT coalesce(
      opengeni_private.subscription_provider_cutover_committed(provider.provider), false
    )
  ) THEN
    RAISE EXCEPTION 'subscription-core cutover must be complete for every account and provider before retiring SQL switches'
      USING ERRCODE = '55000';
  END IF;
END
$$;
ALTER TABLE subscription_provider_cutovers FORCE ROW LEVEL SECURITY;

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.authorize_subscription_personal_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_provider text, p_session_owner_subject_id text, p_turn_human_subject_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
AS $function$
    DECLARE
      v2_snapshot jsonb;
      owner_membership uuid;
      connection_generation bigint;
      provider_core boolean := false;
      record_entry jsonb;
      authorized boolean := false;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_turn_human_subject_id IS DISTINCT FROM nullif(current_setting('opengeni.initiating_human_subject_id', true), '')
        OR p_session_owner_subject_id IS NULL OR p_turn_human_subject_id IS NULL
      THEN RETURN false; END IF;
      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        session_id, turn_id, connection_id, provider,
        session_owner_subject_id, turn_human_subject_id
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'personal_access',
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id, p_provider,
        p_session_owner_subject_id, p_turn_human_subject_id)
      ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
      DO UPDATE SET workspace_id = EXCLUDED.workspace_id, session_id = EXCLUDED.session_id,
        turn_id = EXCLUDED.turn_id, provider = EXCLUDED.provider,
        session_owner_subject_id = EXCLUDED.session_owner_subject_id,
        turn_human_subject_id = EXCLUDED.turn_human_subject_id;

      -- Provider protocol commitment remains a prerequisite. The obsolete
      -- per-account cutover switch no longer selects a different runtime.
      provider_core := coalesce(
        opengeni_private.subscription_provider_cutover_committed(p_provider), false
      );

      SELECT turn.subscription_authority, membership.id, connection.authority_generation
      INTO v2_snapshot, owner_membership, connection_generation
      FROM sessions session
      JOIN session_turns turn ON turn.account_id = session.account_id
        AND turn.workspace_id = session.workspace_id AND turn.session_id = session.id
      JOIN subscription_connections connection ON connection.account_id = session.account_id
        AND connection.id = p_connection_id AND connection.provider = p_provider
      JOIN organization_memberships membership ON membership.id = connection.owner_organization_membership_id
        AND membership.account_id = connection.account_id
      JOIN organization_user_resource_authorities authority ON authority.id = connection.authority_id
        AND authority.account_id = connection.account_id AND authority.organization_membership_id = membership.id
        AND authority.resource_kind = 'subscription_connection' AND authority.resource_id = connection.id
        AND authority.generation = connection.authority_generation AND authority.status = 'active'
        AND authority.revoked_at IS NULL
      WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
        AND session.id = p_session_id AND session.owner_subject_id = p_session_owner_subject_id
        AND turn.id = p_turn_id AND turn.initiating_human_subject_id = p_turn_human_subject_id
        AND membership.subject_id = p_turn_human_subject_id AND membership.status = 'active'
        AND membership.revoked_at IS NULL AND connection.ownership = 'personal'
        AND connection.owner_subject_id = p_turn_human_subject_id
        AND connection.status = 'active'
        AND (
          (p_turn_human_subject_id = p_session_owner_subject_id
            AND session.owner_organization_membership_id = connection.owner_organization_membership_id
            AND (session.visibility = 'user_private' OR membership.personal_workspace_id = p_workspace_id))
          OR (p_turn_human_subject_id LIKE 'user:%%'
            AND subscription_personal_authority_v2_valid(turn.subscription_authority)
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(turn.subscription_authority->'personal') entry
              WHERE entry->>'provider' = p_provider
                AND entry->>'ownerMembershipId' = membership.id::text
                AND entry->>'authorityGeneration' = connection.authority_generation::text
                AND entry->'sharedSessionChoice'->>'sessionId' = p_session_id::text
                AND entry->'sharedSessionChoice'->>'connectionId' = p_connection_id::text)
            AND EXISTS (SELECT 1 FROM workspace_memberships participant
              WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
                AND participant.subject_id = p_turn_human_subject_id))
        );

      IF NOT provider_core THEN
        authorized := false;
      ELSIF NOT opengeni_subscription_internal.subscription_compat_v2_has_entry(
        v2_snapshot, p_provider)
      THEN
        -- No v2 entry for the provider: the turn's compatibility record, for
        -- the exact owner membership and current generation, and only for
        -- the exact connections it lists.
        SELECT record.personal->0 INTO record_entry
        FROM opengeni_private.subscription_authority_compat record
        WHERE record.account_id = p_account_id AND record.workspace_id = p_workspace_id
          AND record.turn_id = p_turn_id AND record.carrier_kind = 'session_turn'
          AND record.provider = p_provider
          AND record.owner_subject_id = p_session_owner_subject_id;
        authorized := coalesce(owner_membership IS NOT NULL
          AND record_entry IS NOT NULL
          AND record_entry->>'ownerMembershipId' = owner_membership::text
          AND record_entry->>'authorityGeneration' = connection_generation::text
          AND record_entry->'connectionIds' ? p_connection_id::text
          AND coalesce((subscription_effective_settings(p_account_id, p_workspace_id)
            #>> '{values,personalConnectionsAllowed}')::boolean, false), false);
      ELSE
        -- The exact frozen v2 entry: provider, canonical owner membership and
        -- the connection's current active authority generation.
        authorized := coalesce(owner_membership IS NOT NULL
          AND v2_snapshot IS NOT NULL
          AND subscription_personal_authority_v2_valid(v2_snapshot)
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(v2_snapshot->'personal') entry
            WHERE entry->>'provider' = p_provider
              AND (entry->>'ownerMembershipId')::uuid = owner_membership
              AND entry->>'authorityGeneration' = connection_generation::text
              AND (NOT entry ? 'sharedSessionChoice' OR (
                entry->'sharedSessionChoice'->>'sessionId' = p_session_id::text
                AND entry->'sharedSessionChoice'->>'connectionId' = p_connection_id::text
                AND p_turn_human_subject_id LIKE 'user:%%'
                AND current_setting('opengeni.shared_personal_choice_v1', true) = '1'
                AND nullif(current_setting('opengeni.subject_id', true), '') IN (
                  p_turn_human_subject_id, 'service:subscription-core')
                AND EXISTS (SELECT 1 FROM workspace_memberships participant
                  WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
                    AND participant.subject_id = p_turn_human_subject_id)))
          )
          AND coalesce((subscription_effective_settings(p_account_id, p_workspace_id)
            #>> '{values,personalConnectionsAllowed}')::boolean, false), false);
      END IF;
      IF NOT authorized OR NOT session_reference_visible(p_account_id, p_workspace_id, p_session_id)
      THEN
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'personal_access'
          AND capability.account_id = p_account_id AND capability.connection_id = p_connection_id;
        RETURN false;
      END IF;
      PERFORM pg_catalog.set_config('opengeni.session_owner_subject_id', p_session_owner_subject_id, true);
      PERFORM pg_catalog.set_config('opengeni.turn_human_subject_id', p_turn_human_subject_id, true);
      RETURN true;
    END
    $function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.authorize_subscription_personal_placement_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_provider text, p_owner_membership_id uuid, p_authority_generation bigint, p_session_owner_subject_id text, p_turn_human_subject_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
AS $function$
    DECLARE
      authority_snapshot jsonb;
      allowed boolean := false;
      minted_lifecycle boolean := false;
      minted_connections uuid[] := '{}'::uuid[];
      record_connections uuid[];
      restricted_connection uuid;
      selected_entry jsonb;
      turn_found boolean;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR nullif(current_setting('opengeni.subject_id', true), '') IS DISTINCT FROM 'service:subscription-core'
        OR p_turn_human_subject_id IS NULL
        OR p_turn_human_subject_id IS DISTINCT FROM nullif(current_setting('opengeni.initiating_human_subject_id', true), '')
        OR p_session_owner_subject_id IS NULL
        OR p_session_owner_subject_id IS DISTINCT FROM nullif(current_setting('opengeni.session_owner_subject_id', true), '')
        OR p_owner_membership_id IS NULL OR p_authority_generation IS NULL OR p_authority_generation < 1
        OR NOT coalesce(opengeni_private.subscription_provider_cutover_committed(p_provider), false)
      THEN RETURN false; END IF;

      IF NOT EXISTS (
        SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'session_access'
          AND capability.account_id = p_account_id
          AND capability.workspace_id = p_workspace_id
          AND capability.session_id = p_session_id
          AND capability.turn_id = p_turn_id
          AND capability.session_owner_subject_id = p_session_owner_subject_id
          AND capability.turn_human_subject_id = p_turn_human_subject_id
      ) THEN RETURN false; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'lifecycle', p_account_id)
      ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id) DO NOTHING
      RETURNING true INTO minted_lifecycle;
      minted_lifecycle := coalesce(minted_lifecycle, false);

      SELECT turn.subscription_authority, true INTO authority_snapshot, turn_found
      FROM sessions session
      JOIN session_turns turn ON turn.account_id = session.account_id
        AND turn.workspace_id = session.workspace_id AND turn.session_id = session.id
      JOIN organization_memberships membership ON membership.account_id = session.account_id
        AND membership.id = p_owner_membership_id
        AND membership.subject_id = p_turn_human_subject_id
      WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
        AND session.id = p_session_id AND session.owner_subject_id = p_session_owner_subject_id
        AND turn.id = p_turn_id AND turn.initiating_human_subject_id = p_turn_human_subject_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND (
          (session.owner_subject_id = p_turn_human_subject_id
            AND session.owner_organization_membership_id = p_owner_membership_id
            AND (session.visibility = 'user_private' OR membership.personal_workspace_id = p_workspace_id))
          OR (p_turn_human_subject_id LIKE 'user:%%'
            AND subscription_personal_authority_v2_valid(turn.subscription_authority)
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(turn.subscription_authority->'personal') entry
              WHERE entry->>'provider' = p_provider
                AND entry->>'ownerMembershipId' = p_owner_membership_id::text
                AND entry->>'authorityGeneration' = p_authority_generation::text
                AND entry->'sharedSessionChoice'->>'sessionId' = p_session_id::text)
            AND EXISTS (SELECT 1 FROM workspace_memberships participant
              WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
                AND participant.subject_id = p_turn_human_subject_id))
        )
        AND session_reference_visible(p_account_id, p_workspace_id, p_session_id);

      IF turn_found IS TRUE
        AND NOT opengeni_subscription_internal.subscription_compat_v2_has_entry(
          authority_snapshot, p_provider)
      THEN
        -- No v2 entry for the provider: the turn's compatibility record. Its
        -- exact connections bound everything minted below; membership and
        -- generation alone never grant a record's personal access.
        SELECT coalesce(array_agg(connection_id.value::uuid), '{}'::uuid[])
        INTO record_connections
        FROM opengeni_private.subscription_authority_compat record
        CROSS JOIN LATERAL jsonb_array_elements_text(record.personal->0->'connectionIds')
          connection_id(value)
        WHERE record.account_id = p_account_id AND record.workspace_id = p_workspace_id
          AND record.turn_id = p_turn_id AND record.carrier_kind = 'session_turn'
          AND record.provider = p_provider
          AND record.owner_subject_id = p_session_owner_subject_id
          AND record.personal->0->>'ownerMembershipId' = p_owner_membership_id::text
          AND record.personal->0->>'authorityGeneration' = p_authority_generation::text;
        allowed := cardinality(record_connections) > 0;
      ELSIF authority_snapshot IS NOT NULL
        AND subscription_personal_authority_v2_valid(authority_snapshot)
        AND authority_snapshot->>'version' = '2'
        AND jsonb_typeof(authority_snapshot->'personal') = 'array'
      THEN
        SELECT EXISTS (
          SELECT 1 FROM jsonb_array_elements(authority_snapshot->'personal') entry
          WHERE entry->>'provider' = p_provider
            AND (entry->>'ownerMembershipId')::uuid = p_owner_membership_id
            AND entry->>'authorityGeneration' = p_authority_generation::text
        ) INTO allowed;
        SELECT entry INTO selected_entry FROM jsonb_array_elements(authority_snapshot->'personal') entry
        WHERE entry->>'provider' = p_provider;
        IF selected_entry ? 'sharedSessionChoice' THEN
          IF selected_entry->'sharedSessionChoice'->>'sessionId' IS DISTINCT FROM p_session_id::text
            OR current_setting('opengeni.shared_personal_choice_v1', true) IS DISTINCT FROM '1'
            OR p_turn_human_subject_id NOT LIKE 'user:%%'
            OR NOT EXISTS (SELECT 1 FROM workspace_memberships participant
              WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
                AND participant.subject_id = p_turn_human_subject_id)
          THEN
            allowed := false;
          END IF;
          restricted_connection := (selected_entry->'sharedSessionChoice'->>'connectionId')::uuid;
          record_connections := ARRAY[restricted_connection];
        END IF;
      END IF;
      IF NOT allowed OR NOT coalesce((subscription_effective_settings(
        p_account_id, p_workspace_id
      ) #>> '{values,personalConnectionsAllowed}')::boolean, false) THEN
        IF minted_lifecycle THEN
          DELETE FROM opengeni_private.subscription_runtime_capabilities capability
          WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
            AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
            AND capability.capability_kind = 'lifecycle' AND capability.account_id = p_account_id;
        END IF;
        RETURN false;
      END IF;

      -- Authorities identify exact personal resource IDs. Mint temporary
      -- per-connection capabilities only for those whose current authority
      -- generation matches the frozen v2 generation, then remove any whose
      -- connection row does not prove the same owner/provider/generation.
      -- Never rewrite or remove a capability the caller already held for a
      -- connection (for example an earlier v1 Claude authorization in the
      -- same transaction): conflicts are left untouched, and every cleanup
      -- below is limited to the rows this call inserted.
      WITH inserted AS (
        INSERT INTO opengeni_private.subscription_runtime_capabilities (
          backend_pid, transaction_id, capability_kind, account_id, workspace_id,
          session_id, turn_id, connection_id, provider,
          session_owner_subject_id, turn_human_subject_id
        )
        SELECT pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'personal_access',
          p_account_id, p_workspace_id, p_session_id, p_turn_id, authority.resource_id,
          p_provider, p_session_owner_subject_id, p_turn_human_subject_id
        FROM organization_user_resource_authorities authority
        WHERE authority.account_id = p_account_id
          AND authority.organization_membership_id = p_owner_membership_id
          AND authority.resource_kind = 'subscription_connection'
          AND authority.generation = p_authority_generation
          AND authority.status = 'active' AND authority.revoked_at IS NULL
          AND (record_connections IS NULL OR authority.resource_id = ANY (record_connections))
        ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
        RETURNING connection_id
      )
      SELECT coalesce(array_agg(inserted.connection_id), '{}'::uuid[])
        INTO minted_connections FROM inserted;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'personal_access'
        AND capability.account_id = p_account_id AND capability.workspace_id = p_workspace_id
        AND capability.connection_id = ANY (minted_connections)
        AND capability.session_id = p_session_id AND capability.turn_id = p_turn_id
        AND capability.provider = p_provider
        AND capability.session_owner_subject_id = p_session_owner_subject_id
        AND capability.turn_human_subject_id = p_turn_human_subject_id
        AND NOT EXISTS (
          SELECT 1 FROM subscription_connections connection
          JOIN organization_user_resource_authorities authority
            ON authority.id = connection.authority_id
            AND authority.account_id = connection.account_id
            AND authority.organization_membership_id = p_owner_membership_id
            AND authority.resource_kind = 'subscription_connection'
            AND authority.resource_id = connection.id
            AND authority.generation = p_authority_generation
            AND authority.status = 'active' AND authority.revoked_at IS NULL
          WHERE connection.account_id = capability.account_id
            AND connection.id = capability.connection_id
            AND connection.provider = p_provider AND connection.ownership = 'personal'
            AND connection.owner_organization_membership_id = p_owner_membership_id
            AND connection.owner_subject_id = p_turn_human_subject_id
            AND connection.authority_generation = p_authority_generation
            AND connection.status = 'active'
        );

      SELECT EXISTS (
        SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
        JOIN subscription_connections connection ON connection.account_id = capability.account_id
          AND connection.id = capability.connection_id AND connection.provider = capability.provider
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'personal_access'
          AND capability.account_id = p_account_id AND capability.workspace_id = p_workspace_id
          AND capability.session_id = p_session_id AND capability.turn_id = p_turn_id
          AND capability.provider = p_provider
          AND capability.session_owner_subject_id = p_session_owner_subject_id
          AND capability.turn_human_subject_id = p_turn_human_subject_id
          AND connection.ownership = 'personal'
          AND connection.owner_organization_membership_id = p_owner_membership_id
          AND connection.authority_generation = p_authority_generation
          AND (record_connections IS NULL OR connection.id = ANY (record_connections))
          AND opengeni_private.subscription_personal_connection_visible(
            p_account_id, connection.id, p_owner_membership_id,
            p_session_owner_subject_id, p_turn_human_subject_id, p_provider
          )
      ) INTO allowed;

      IF minted_lifecycle THEN
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'lifecycle' AND capability.account_id = p_account_id;
      END IF;
      IF NOT allowed THEN
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'personal_access'
          AND capability.account_id = p_account_id AND capability.workspace_id = p_workspace_id
          AND capability.connection_id = ANY (minted_connections)
          AND capability.session_id = p_session_id AND capability.turn_id = p_turn_id
          AND capability.provider = p_provider
          AND capability.session_owner_subject_id = p_session_owner_subject_id
          AND capability.turn_human_subject_id = p_turn_human_subject_id;
        RETURN false;
      END IF;
      PERFORM pg_catalog.set_config('opengeni.session_owner_subject_id', p_session_owner_subject_id, true);
      PERFORM pg_catalog.set_config('opengeni.turn_human_subject_id', p_turn_human_subject_id, true);
      RETURN true;
    END
    $function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.quarantine_subscription_core_connection(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_holder_id text, p_lease_generation bigint, p_expected_refresh_generation bigint, p_status text, p_last_error text, p_retry_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
AS $function$
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

      IF NOT coalesce(
        opengeni_private.subscription_provider_cutover_committed(p_provider), false
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
        AND provider = p_provider AND kind = opengeni_private.subscription_core_connection_kind(p_provider) AND status = 'active'
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
    $function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.recover_subscription_core_connection_health(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
AS $function$
    DECLARE
      capability_owner text;
      capability_human text;
      target uuid;
      recovered integer := 0;
      targets uuid[];
      prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_session_id IS NULL OR p_turn_id IS NULL
      THEN RETURN 0; END IF;
      IF NOT coalesce(
        opengeni_private.subscription_provider_cutover_committed(p_provider), false
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

      PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
        'organization_membership_lifecycle', true);
      SELECT coalesce(array_agg(connection.id ORDER BY connection.id), '{}')
        INTO targets
        FROM subscription_connections connection
        WHERE connection.account_id = p_account_id AND connection.provider = p_provider
          AND connection.kind = opengeni_private.subscription_core_connection_kind(p_provider) AND connection.status = 'error'
          AND connection.health_retry_at IS NOT NULL
          AND connection.health_retry_at <= pg_catalog.clock_timestamp()
          AND CASE
            WHEN connection.ownership = 'personal' THEN
              capability_owner IS NOT NULL
              AND connection.owner_subject_id = capability_human
              AND EXISTS (
                SELECT 1 FROM organization_memberships membership
                WHERE membership.id = connection.owner_organization_membership_id
                  AND membership.account_id = p_account_id
                  AND membership.subject_id = capability_human
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
                  AND turn.initiating_human_subject_id = capability_human
                  AND turn.subscription_authority->>'version' = '2'
                  AND entry->>'provider' = p_provider
                  AND entry->>'ownerMembershipId' = connection.owner_organization_membership_id::text
                  AND entry->>'authorityGeneration' = connection.authority_generation::text
                  AND (CASE WHEN entry ? 'sharedSessionChoice' THEN
                    capability_human LIKE 'user:%%'
                    AND current_setting('opengeni.shared_personal_choice_v1', true) = '1'
                    AND subscription_personal_authority_v2_valid(turn.subscription_authority)
                    AND entry->'sharedSessionChoice'->>'sessionId' = p_session_id::text
                    AND entry->'sharedSessionChoice'->>'connectionId' = connection.id::text
                    AND coalesce((subscription_effective_settings(p_account_id, p_workspace_id)
                      #>> '{values,personalConnectionsAllowed}')::boolean, false)
                    AND EXISTS (SELECT 1 FROM workspace_memberships participant
                      WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
                        AND participant.subject_id = capability_human)
                    AND EXISTS (SELECT 1 FROM organization_user_resource_authorities authority
                      WHERE authority.id = connection.authority_id AND authority.account_id = p_account_id
                        AND authority.organization_membership_id = connection.owner_organization_membership_id
                        AND authority.resource_kind = 'subscription_connection' AND authority.resource_id = connection.id
                        AND authority.generation = connection.authority_generation
                        AND authority.status = 'active' AND authority.revoked_at IS NULL)
                    ELSE capability_human IS NOT DISTINCT FROM capability_owner END)
              )
            WHEN connection.ownership = 'shared' THEN
              opengeni_private.subscription_connection_visible(
                p_account_id, p_workspace_id, connection.id, connection.ownership,
                connection.scope_kind, connection.owner_organization_membership_id,
                connection.owner_subject_id, connection.provider
              )
            ELSE false
          END
        ;
      PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
        coalesce(prior_lifecycle, ''), true);
      FOREACH target IN ARRAY targets LOOP
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
    $function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.subscription_core_acceptance_authority_v2(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_accepting_subject_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
AS $function$
    DECLARE
      request_subject text := nullif(current_setting('opengeni.subject_id', true), '');
      owner_subject text;
      owner_membership uuid;
      creator_kind text;
      creator_subject text;
      private_session boolean;
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

      IF NOT coalesce(
        opengeni_private.subscription_provider_cutover_committed(p_provider), false
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

      IF private_session IS FALSE AND get_workspace_kind(p_account_id, p_workspace_id) = 'shared' THEN
        IF p_accepting_subject_id NOT LIKE 'user:%%'
          OR request_subject IS DISTINCT FROM p_accepting_subject_id
          OR NOT coalesce((subscription_effective_settings(p_account_id, p_workspace_id)
            #>> '{values,personalConnectionsAllowed}')::boolean, false)
        THEN RETURN empty_v2; END IF;

        PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
          'organization_membership_lifecycle', true);
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
        PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
          coalesce(prior_lifecycle, ''), true);
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
    $function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.subscription_core_task_authority_v2(p_provider text, p_account_id uuid, p_workspace_id uuid, p_reusable_session_id uuid, p_accepting_subject_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
AS $function$
    DECLARE
      request_subject text := nullif(current_setting('opengeni.subject_id', true), '');
      owner_membership uuid;
      minted_lifecycle boolean := false;
      prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
      generations bigint[];
      empty_v2 constant jsonb := '{"version":2,"personal":[]}'::jsonb;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      THEN RETURN NULL; END IF;
      IF NOT coalesce(
        opengeni_private.subscription_provider_cutover_committed(p_provider), false
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
          AND connection.owner_subject_id = p_accepting_subject_id
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
    $function$

$create$, data_schema);
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.subscription_codex_apps_designation_target(p_account_id uuid, p_workspace_id uuid)
 RETURNS SETOF %1$I.subscription_connections
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
AS $function$
    DECLARE
      designated uuid;
      target subscription_connections%%ROWTYPE;
      in_scope boolean := false;
    BEGIN
      IF p_account_id IS NULL OR p_workspace_id IS NULL
        OR p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      THEN RETURN; END IF;
      IF NOT coalesce(
        opengeni_private.subscription_provider_cutover_committed('codex'), false
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
    $function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.subscription_codex_reset_authority(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_subject_id text)
 RETURNS TABLE(status text, authorized boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
AS $function$
    DECLARE
      target subscription_connections%%ROWTYPE;
      locked boolean := false;
    BEGIN
      IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_connection_id IS NULL
        OR p_subject_id IS NULL
        OR p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_subject_id IS DISTINCT FROM nullif(current_setting('opengeni.subject_id', true), '')
      THEN RETURN; END IF;
      IF NOT coalesce(
        opengeni_private.subscription_provider_cutover_committed('codex'), false
      ) THEN RETURN; END IF;
      -- A connection the requesting workspace manages (its administrators or
      -- an organization administrator), or an organization-managed one (an
      -- organization administrator only). Read under the caller's own
      -- row-level security.
      SELECT connection.* INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = 'codex' AND connection.kind = 'subscription'
        AND connection.ownership = 'shared'
        AND (connection.managed_by_workspace_id = p_workspace_id
          OR connection.managed_by_workspace_id IS NULL);
      IF NOT FOUND THEN RETURN; END IF;
      -- FOR SHARE also applies the connection's UPDATE policies, which admit
      -- exactly an organization administrator or an administrator of the
      -- managing workspace; anyone else gets no lock and no authority.
      PERFORM 1 FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
      FOR SHARE;
      locked := FOUND;
      status := target.status;
      authorized := locked AND (
        opengeni_private.subscription_organization_admin(p_account_id)
        OR (target.managed_by_workspace_id = p_workspace_id AND EXISTS (
          SELECT 1 FROM workspace_memberships manager
          WHERE manager.account_id = p_account_id
            AND manager.workspace_id = p_workspace_id
            AND manager.subject_id = p_subject_id
            AND opengeni_private.workspace_membership_administers(manager.role, manager.permissions)
        ))
      );
      RETURN NEXT;
    END
    $function$

$create$, data_schema);
END
$install$;

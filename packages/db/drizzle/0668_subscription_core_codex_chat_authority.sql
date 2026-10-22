-- deployment-mode: rolling
-- M3 PR 1: the Codex chat selector reads only the immutable v2 accepted
-- authority once Codex's cutover row is enabled. Both changes are inert while
-- no Codex cutover row is enabled, so v1 stays authoritative for every
-- provider until the drained cutover; Claude and xAI are unchanged.
--
-- 1. authorize_subscription_personal_access (used by the lease guard and by
--    begin_subscription_codex_refresh) checked only the v1
--    codex_provider_account_authority_snapshot. A Codex chat turn placed on a
--    personal connection through the v2 personal-placement helper could
--    therefore never lease or refresh it. For Codex with an enabled cutover,
--    the frozen v2 entry is now the only accepted personal authority; v1 is
--    not consulted. A Codex cutover row that exists but is disabled grants no
--    personal authority. Every other provider, and Codex while no cutover row
--    exists, keep the v1 check byte-for-byte.
-- 2. fail_subscription_codex_refresh records a permanent OAuth refusal as
--    needs_relogin. It consumes the one-shot authorization that
--    begin_subscription_codex_refresh minted in the same transaction, so it
--    can never act without that exact turn, live lease and connection
--    authorization, and it writes only under the refresh-generation
--    compare-and-swap: a refusal seen with an older token family cannot mark
--    a renewed credential.

DO $personal_access_v2$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.authorize_subscription_personal_access(
      p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
      p_connection_id uuid, p_provider text, p_session_owner_subject_id text,
      p_turn_human_subject_id text
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      accepted_snapshot jsonb;
      v2_snapshot jsonb;
      owner_membership uuid;
      connection_generation bigint;
      codex_core boolean := false;
      codex_cutover_row boolean := false;
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

      -- Codex reads its v2 entry only after its own cutover is enabled. A
      -- cutover row that exists but is disabled grants no personal authority
      -- at all: v1 stays authoritative only while no row exists.
      IF p_provider = 'codex' THEN
        SELECT true, coalesce(cutover.enabled, false) INTO codex_cutover_row, codex_core
        FROM subscription_provider_cutovers cutover
        WHERE cutover.account_id = p_account_id AND cutover.provider = 'codex';
        codex_cutover_row := coalesce(codex_cutover_row, false);
        codex_core := coalesce(codex_core, false);
      END IF;

      SELECT CASE p_provider
          WHEN 'codex' THEN turn.codex_provider_account_authority_snapshot
          WHEN 'claude' THEN turn.claude_provider_account_authority_snapshot
          WHEN 'xai' THEN turn.xai_provider_account_authority_snapshot
        END,
        turn.subscription_authority, membership.id, connection.authority_generation
      INTO accepted_snapshot, v2_snapshot, owner_membership, connection_generation
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
        AND membership.subject_id = p_session_owner_subject_id AND membership.status = 'active'
        AND membership.revoked_at IS NULL AND connection.ownership = 'personal'
        AND connection.owner_subject_id = p_session_owner_subject_id
        AND connection.status = 'active'
        AND p_turn_human_subject_id = p_session_owner_subject_id
        AND (codex_core IS NOT TRUE
          OR session.owner_organization_membership_id = connection.owner_organization_membership_id)
        AND (session.visibility = 'user_private'
          OR membership.personal_workspace_id = p_workspace_id);

      IF codex_cutover_row AND NOT codex_core THEN
        authorized := false;
      ELSIF codex_core THEN
        -- The exact frozen v2 entry: provider, canonical owner membership and
        -- the connection's current active authority generation.
        authorized := coalesce(owner_membership IS NOT NULL
          AND v2_snapshot IS NOT NULL
          AND subscription_personal_authority_v2_valid(v2_snapshot)
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(v2_snapshot->'personal') entry
            WHERE entry->>'provider' = 'codex'
              AND (entry->>'ownerMembershipId')::uuid = owner_membership
              AND entry->>'authorityGeneration' = connection_generation::text
          )
          AND coalesce((subscription_effective_settings(p_account_id, p_workspace_id)
            #>> '{values,personalConnectionsAllowed}')::boolean, false), false);
      ELSE
        -- Unchanged v1 check, including its three-valued NULL semantics.
        authorized := accepted_snapshot IS NOT NULL AND accepted_snapshot->>'scope' = 'user'
          AND accepted_snapshot->>'authorityGeneration' IS NOT DISTINCT FROM (
            SELECT authority_generation::text FROM subscription_connections
            WHERE account_id = p_account_id AND id = p_connection_id
          );
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
    $body$
  $ddl$, data_schema);
END
$personal_access_v2$;
REVOKE ALL ON FUNCTION opengeni_private.authorize_subscription_personal_access(
  uuid, uuid, uuid, uuid, uuid, text, text, text
) FROM PUBLIC;

DO $fail_codex_refresh$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.fail_subscription_codex_refresh(
      p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
      p_connection_id uuid, p_expected_refresh_generation bigint, p_last_error text
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
        OR p_expected_refresh_generation IS NULL OR p_expected_refresh_generation < 1
      THEN RETURN false; END IF;

      -- Consume the one-shot authorization begin minted in this transaction,
      -- exactly as persist does. The advisory transaction lock is still held.
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

      -- Health only: no credential column changes. The generation CAS keeps a
      -- refusal of an older token family off a credential renewed meanwhile.
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
$fail_codex_refresh$;

REVOKE ALL ON FUNCTION opengeni_private.fail_subscription_codex_refresh(
  uuid, uuid, uuid, uuid, uuid, bigint, text
) FROM PUBLIC;

DO $grant_codex_chat_authority$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.authorize_subscription_personal_access(
      uuid, uuid, uuid, uuid, uuid, text, text, text
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.fail_subscription_codex_refresh(
      uuid, uuid, uuid, uuid, uuid, bigint, text
    ) TO opengeni_app;
  END IF;
END
$grant_codex_chat_authority$;

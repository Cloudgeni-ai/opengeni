-- deployment-mode: rolling
-- Every subscription credential refresh records the plan its new token reports.
--
-- persist_subscription_core_refresh_with_plan was the only refresh writer that
-- recorded the rotated credential's plan, and it accepted only a chat turn's
-- refresh authority. Refreshes outside a chat turn (live voice and other
-- operations, usage reads, administered connections) wrote through
-- persist_subscription_core_connection_refresh, which takes no plan, so a
-- connection whose provider plan changed kept showing the old one.
--
-- Same signature; the writer now also accepts the connection refresh
-- authority that begin_subscription_core_connection_refresh and
-- begin_subscription_core_owned_connection_refresh mint, when it is called
-- with no session and no turn. Either way it consumes the one-shot
-- authorization, mints the same refresh_write capability the paths minted
-- before, compares and swaps the refresh generation, records the plan (a
-- NULL plan keeps the recorded one) and clears the connection's model
-- cooldowns when the plan changed. So every refresh path writes through this
-- one routine.
--
-- Rolling: the previous release never calls it without a session and turn
-- (it returned false for that), and keeps calling the connection writer,
-- which is unchanged.
SET LOCAL lock_timeout = '5s';

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.persist_subscription_core_refresh_with_plan(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_credential_encrypted text, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone, p_plan_type text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    SET lock_timeout TO '0'
    AS $body$
    DECLARE
      capability_owner text;
      capability_human text;
      write_minted boolean := false;
      refresh_persisted boolean := false;
      plan_value text := nullif(btrim(coalesce(p_plan_type, '')), '');
      previous_plan text;
    BEGIN
      -- A chat turn's refresh names its session and turn; a refresh outside
      -- a turn names neither.
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_connection_id IS NULL OR (p_session_id IS NULL) <> (p_turn_id IS NULL)
        OR p_expected_refresh_generation IS NULL OR p_expected_refresh_generation < 1
        OR p_credential_encrypted IS NULL
        OR p_credential_encrypted !~ '^v[12]:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
        OR p_last_refresh_at IS NULL
        OR (plan_value IS NOT NULL AND (length(plan_value) > 64 OR plan_value !~ '^[A-Za-z0-9_.-]+$'))
      THEN RETURN false; END IF;

      IF p_session_id IS NOT NULL THEN
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
      ELSE
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'connection_refresh_authorized'
          AND capability.account_id = p_account_id
          AND capability.workspace_id = p_workspace_id
          AND capability.connection_id = p_connection_id
          AND capability.provider = p_provider;
        IF NOT FOUND THEN RETURN false; END IF;
      END IF;

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
          expires_at = p_expires_at,
          last_refresh_at = p_last_refresh_at,
          plan_type = coalesce(plan_value, subscription_connections.plan_type),
          refresh_generation = subscription_connections.refresh_generation + 1,
          updated_at = pg_catalog.clock_timestamp()
      WHERE account_id = p_account_id AND id = p_connection_id
        AND provider = p_provider AND kind = opengeni_private.subscription_core_connection_kind(p_provider)
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
  $create$, data_schema);
END
$install$;

REVOKE ALL ON FUNCTION opengeni_private.persist_subscription_core_refresh_with_plan(text, uuid, uuid, uuid, uuid, uuid, bigint, text, timestamp with time zone, timestamp with time zone, text) FROM PUBLIC;

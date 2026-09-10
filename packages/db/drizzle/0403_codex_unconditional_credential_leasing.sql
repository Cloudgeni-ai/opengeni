-- deployment-mode: maintenance
-- Migration 0403 retires the temporary allocator cutover bits. Every Codex
-- turn now uses the durable credential lease protocol; rotation_enabled remains
-- the user-owned policy deciding whether a new lease may leave the active
-- account. Stop every pre-0403 API, control-worker, and turn-worker before this
-- migration, then start only the 0403-aware binary.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $codex_unconditional_leasing_runtime_drain_before_lock$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0403 unconditional Codex leasing requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0403 unconditional Codex leasing received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR value #>> '{}' <> btrim(value #>> '{}')
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0403 unconditional Codex leasing received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0403 unconditional Codex leasing requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$codex_unconditional_leasing_runtime_drain_before_lock$;

LOCK TABLE organization_codex_rotation_settings IN ACCESS EXCLUSIVE MODE;
LOCK TABLE codex_rotation_settings IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_goals IN ACCESS EXCLUSIVE MODE;
LOCK TABLE codex_capacity_waiters IN ACCESS EXCLUSIVE MODE;

DO $codex_unconditional_leasing_runtime_drain_after_lock$
DECLARE
  configured_roles jsonb := current_setting(
    'opengeni.migration_application_roles', false
  )::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0403 unconditional Codex leasing requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$codex_unconditional_leasing_runtime_drain_after_lock$;

-- Preserve an active goal without allowing an unchanged bounded Codex
-- failover failure to synthesize a fresh turn and reset its per-turn budget.
ALTER TABLE session_goals
  ADD COLUMN IF NOT EXISTS continuation_suppressed_turn_id uuid;

ALTER TABLE organization_codex_rotation_settings
  DROP COLUMN IF EXISTS lease_rotation_enabled;

ALTER TABLE codex_rotation_settings
  DROP COLUMN IF EXISTS lease_rotation_enabled;

-- Policy/status waits are woken by allocator, connection, source, and pin
-- mutations. They must not fan out provider quota reads on every waiter timer.
ALTER TABLE codex_capacity_waiters
  DROP CONSTRAINT IF EXISTS codex_capacity_waiters_reset_kind_check;
ALTER TABLE codex_capacity_waiters
  ADD CONSTRAINT codex_capacity_waiters_reset_kind_check
  CHECK (reset_kind IN ('authoritative', 'bounded_refresh', 'mutation_only'));

-- Migration 0381 installed these organization lease guards with `now()`,
-- whose value is fixed at transaction start. Reinstall the same guards with
-- execution-time clock semantics before the durable lease protocol becomes
-- authoritative, so a long maintenance-adjacent transaction cannot treat an
-- already-expired lease as live.
DO $codex_execution_time_lease_guards$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.codex_organization_live_lease_count(
      p_account_id uuid,
      p_credential_id uuid,
      p_exclude_turn_id uuid
    ) RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I
    AS $function$
    DECLARE live_count integer;
    BEGIN
      IF p_account_id IS NULL
        OR p_credential_id IS NULL
        OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR opengeni_private.current_workspace_id() IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM codex_subscription_credentials credential
          WHERE credential.account_id = p_account_id
            AND credential.id = p_credential_id
            AND credential.organization_id = p_account_id
            AND credential.authority_scope = 'organization'
        )
        OR NOT opengeni_private.codex_credential_serves_workspace(
          p_account_id,
          opengeni_private.current_workspace_id(),
          p_credential_id
        )
      THEN
        RAISE EXCEPTION 'organization Codex lease-count authority required'
          USING ERRCODE = '42501';
      END IF;
      SELECT count(*)::integer INTO live_count
      FROM codex_credential_leases lease
      WHERE lease.account_id = p_account_id
        AND lease.credential_id = p_credential_id
        AND lease.leased_until > clock_timestamp()
        AND (p_exclude_turn_id IS NULL OR lease.turn_id <> p_exclude_turn_id);
      RETURN live_count;
    END
    $function$;

    CREATE OR REPLACE FUNCTION opengeni_private.prevent_organization_codex_disconnect_with_live_leases()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I
    AS $function$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM codex_credential_leases lease
        WHERE lease.account_id = OLD.account_id
          AND lease.credential_id = OLD.id
          AND lease.leased_until > clock_timestamp()
      ) THEN
        RAISE EXCEPTION 'Codex subscription cannot disconnect while active turns are using it'
          USING ERRCODE = '55006';
      END IF;
      RETURN OLD;
    END
    $function$;
  $ddl$, data_schema);
END
$codex_execution_time_lease_guards$;
-- deployment-mode: maintenance
-- Migration 0401 retires the temporary allocator cutover bits. Every Codex
-- turn now uses the durable credential lease protocol; rotation_enabled remains
-- the user-owned policy deciding whether a new lease may leave the active
-- account. Stop every pre-0401 API, control-worker, and turn-worker before this
-- migration, then start only the 0401-aware binary.

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
      '0401 unconditional Codex leasing requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0401 unconditional Codex leasing received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
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
      '0401 unconditional Codex leasing received an invalid application database role list'
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
      '0401 unconditional Codex leasing requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$codex_unconditional_leasing_runtime_drain_before_lock$;

LOCK TABLE organization_codex_rotation_settings IN ACCESS EXCLUSIVE MODE;
LOCK TABLE codex_rotation_settings IN ACCESS EXCLUSIVE MODE;

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
      '0401 unconditional Codex leasing requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$codex_unconditional_leasing_runtime_drain_after_lock$;

ALTER TABLE organization_codex_rotation_settings
  DROP COLUMN IF EXISTS lease_rotation_enabled;

ALTER TABLE codex_rotation_settings
  DROP COLUMN IF EXISTS lease_rotation_enabled;
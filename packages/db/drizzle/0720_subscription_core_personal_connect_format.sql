-- deployment-mode: rolling
-- The neutral personal connect writer takes the connected credential's
-- format (design docs/design/subscription-core-2026-10-07.md, 5.3
-- "SuperGrok track", X2b). The 0707 writer stores `credential_format = 'v1'`,
-- Codex's format; SuperGrok stores `xai_oauth_v1` and Claude stores one of
-- its own, so a provider's personal connect names the format of the
-- credential it writes, as the shared connect path does in TypeScript.
--
-- Rolling: a new overload with the format as its last argument, defined from
-- the live 0707 definition (drift-checked anchors, never a restated body),
-- so it keeps every check, lock, search path and security mode of the
-- original. The 14-argument writer stays unchanged for binaries that still
-- call it (Codex writes `v1` through either). Nothing else changes: no
-- table, policy or lock. The retirement migration drops the old overload
-- when no older binary can run.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $personal_connect_format$
DECLARE
  definition text;
  patch text[];
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.connect_subscription_core_personal(text,uuid,uuid,text,text,text,text,text,jsonb,timestamptz,timestamptz,text,text,text)'::regprocedure);
  FOREACH patch SLICE 1 IN ARRAY ARRAY[
    ARRAY[$old$p_connected_by_subject_id text)$old$,
      $new$p_connected_by_subject_id text, p_credential_format text)$new$],
    ARRAY[$old$credential_encrypted = p_credential_encrypted, credential_format = 'v1',$old$,
      $new$credential_encrypted = p_credential_encrypted, credential_format = p_credential_format,$new$],
    ARRAY[$old$p_credential_encrypted, 'v1', p_expires_at$old$,
      $new$p_credential_encrypted, p_credential_format, p_expires_at$new$],
    -- The format is an adapter's stored-format name, never free text; a
    -- malformed one is refused like any other malformed input.
    ARRAY[$old$OR p_credential_encrypted IS NULL OR length(p_credential_encrypted) = 0
$old$, $new$OR p_credential_encrypted IS NULL OR length(p_credential_encrypted) = 0
        OR p_credential_format IS NULL OR p_credential_format !~ '^[a-z][a-z0-9_]{0,63}$'
$new$]
  ] LOOP
    IF (length(definition) - length(replace(definition, patch[1], ''))) <> length(patch[1]) THEN
      RAISE EXCEPTION 'subscription core personal connect source changed';
    END IF;
    definition := replace(definition, patch[1], patch[2]);
  END LOOP;
  EXECUTE definition;
END
$personal_connect_format$;

-- PUBLIC loses the default EXECUTE; every configured application role gets
-- it (0713's pattern), so the previous release's readiness, which rejects an
-- opengeni_private routine the runtime role cannot execute, passes before
-- provision-roles runs.
DO $personal_connect_format_grants$
DECLARE application_role text;
BEGIN
  REVOKE ALL ON FUNCTION opengeni_private.connect_subscription_core_personal(
    text,uuid,uuid,text,text,text,text,text,jsonb,timestamptz,timestamptz,text,text,text,text)
    FROM PUBLIC;
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.connect_subscription_core_personal('
      'text,uuid,uuid,text,text,text,text,text,jsonb,timestamptz,timestamptz,text,text,text,text) TO %I',
      application_role);
  END LOOP;
END
$personal_connect_format_grants$;

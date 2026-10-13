-- deployment-mode: rolling
-- The owner's personal connections with their row version (design
-- docs/design/subscription-core-2026-10-07.md, 5.3 "Claude track", C2b).
-- Claude's routes report each account's `version` and fence a reconnect on
-- it (`expectedCredentialVersion`, the OAuth attempt's `credentialVersion`),
-- and the neutral connect writer checks a fenced reconnect inside its own
-- transaction. Personal connections are visible to their owner only through
-- the 0707 owner reader, which does not return the version.
--
-- Rolling: a new routine defined from the live owner reader (0707, as 0715 rewrote it)
-- (drift-checked anchors, never a restated body), so it keeps the writer
-- context check, the owner capability grant and drop, the membership rule,
-- search path and security mode; it returns only `(id, version)` (the
-- quota join stays, one row per connection). Nothing else changes: no
-- table, policy, lock or existing routine.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $personal_connection_versions$
DECLARE
  definition text;
  patch text[];
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.subscription_core_personal_connections(text,uuid,uuid,text)'::regprocedure);
  FOREACH patch SLICE 1 IN ARRAY ARRAY[
    ARRAY[$old$FUNCTION opengeni_private.subscription_core_personal_connections($old$,
      $new$FUNCTION opengeni_private.subscription_core_personal_connection_versions($new$],
    ARRAY[$old$RETURNS TABLE(id uuid, label text, account_email text, plan_type text, provider_account_id text, status text, last_error text, allocator_enabled boolean, allocator_version integer, allowed_model_ids text[], connected_by_subject_id text, expires_at timestamp with time zone, last_refresh_at timestamp with time zone, provider_state jsonb, updated_at timestamp with time zone, quota jsonb, quota_revision bigint, quota_observed_refresh_generation bigint, quota_updated_at timestamp with time zone, extra_credits_enabled boolean, extra_credits_version integer, extra_credits_updated_at timestamp with time zone)$old$,
      $new$RETURNS TABLE(id uuid, version integer)$new$],
    ARRAY[$old$SELECT connection.id, connection.label, connection.account_email, connection.plan_type,
          connection.provider_account_id, connection.status, connection.last_error,
          connection.allocator_enabled, connection.allocator_version,
          connection.allowed_model_ids, connection.connected_by_subject_id,
          connection.expires_at, connection.last_refresh_at, connection.provider_state,
          connection.updated_at, quota.quota, quota.revision::bigint,
          quota.observed_refresh_generation, quota.updated_at,
          connection.extra_credits_enabled, connection.extra_credits_version,
          connection.extra_credits_updated_at
$old$, $new$SELECT connection.id, connection.version
$new$]
  ] LOOP
    IF (length(definition) - length(replace(definition, patch[1], ''))) <> length(patch[1]) THEN
      RAISE EXCEPTION 'subscription core personal connections source changed';
    END IF;
    definition := replace(definition, patch[1], patch[2]);
  END LOOP;
  EXECUTE definition;
END
$personal_connection_versions$;

-- PUBLIC loses the default EXECUTE; every configured application role gets
-- it (0713's pattern), so the previous release's readiness, which rejects an
-- opengeni_private routine the runtime role cannot execute, passes before
-- provision-roles runs.
DO $personal_connection_versions_grants$
DECLARE application_role text;
BEGIN
  REVOKE ALL ON FUNCTION opengeni_private.subscription_core_personal_connection_versions(
    text,uuid,uuid,text) FROM PUBLIC;
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.subscription_core_personal_connection_versions('
      'text,uuid,uuid,text) TO %I',
      application_role);
  END LOOP;
END
$personal_connection_versions_grants$;

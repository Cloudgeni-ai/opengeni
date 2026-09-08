-- deployment-mode: maintenance
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0427 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0427 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0427 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;

-- Preserve all 0426 exact-work guards. Replace one asserted clause, not a
-- best-effort search, so divergence from that immutable routine aborts migration.
DO $ceiling$
DECLARE
  definition text := pg_get_functiondef('opengeni_private.guard_external_link_work_snapshot()'::regprocedure);
  prior text := 'OR NOT (NEW.canonical_snapshot -> ''permissions'') <@ l.permissions THEN';
  replacement text := $clause$OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.canonical_snapshot -> 'permissions') p
      WHERE jsonb_typeof(p) <> 'string' OR NOT (
        l.permissions ? (p #>> '{}') OR
        (l.permissions ? 'workspace:admin' AND p #>> '{}' <> 'secrets:read')
      )
    ) THEN$clause$;
BEGIN
  IF length(definition) - length(replace(definition, prior, '')) <> length(prior) THEN
    RAISE EXCEPTION '0427 expected exactly one 0426 permission clause' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, prior, replacement);
END
$ceiling$;

-- The app role cannot SELECT external_identities directly. Expose only the
-- challenged request's display reference to an active native organization member.
CREATE FUNCTION get_external_identity_link_reference(p_account_id uuid, p_link_id uuid, p_challenge_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE
  result jsonb;
  prior text := coalesce(current_setting('opengeni.organization_tenancy_lifecycle', true), '');
  subject text := opengeni_private.current_subject_id();
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR subject IS NULL OR subject !~ '^user:[^\r\n]+$'
    OR p_challenge_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'native identity link preview authority required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(list_self_organization_memberships(subject)) m
    WHERE m ->> 'organizationId' = p_account_id::text AND m ->> 'status' = 'active') THEN
    RAISE EXCEPTION 'native identity link organization unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'external_identity_provisioning', true);
  SELECT jsonb_build_object('source', e.source, 'externalId', e.external_id) INTO result
    FROM external_identity_links l JOIN external_identities e
      ON e.id = l.external_identity_id AND e.account_id = l.account_id
    WHERE l.account_id = p_account_id AND l.id = p_link_id AND l.challenge_digest = p_challenge_digest
      AND l.status = 'pending' AND l.confirm_before > clock_timestamp()
      AND (l.expires_at IS NULL OR l.expires_at > clock_timestamp())
      AND e.status = 'active' AND e.authorization_revision = l.external_authorization_revision;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', prior, true);
  RETURN result;
END
$body$;
REVOKE ALL ON FUNCTION get_external_identity_link_reference(uuid, uuid, text) FROM PUBLIC;
DO $drain$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0427 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;
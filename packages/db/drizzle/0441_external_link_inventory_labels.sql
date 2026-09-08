-- deployment-mode: maintenance
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION '0431 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0431 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;

-- No SELECT grant on external_identities. Only a current participant can resolve
-- labels for the bounded links already returned by the participant inventory.
CREATE FUNCTION get_external_identity_link_inventory_references(p_account_id uuid, p_link_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE
  result jsonb;
  prior text := coalesce(current_setting('opengeni.organization_tenancy_lifecycle', true), '');
  subject text := opengeni_private.current_subject_id();
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() OR subject IS NULL
    OR p_link_ids IS NULL OR coalesce(cardinality(p_link_ids), 0) > 50 THEN
    RAISE EXCEPTION 'identity link inventory authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'external_identity_provisioning', true);
  IF NOT EXISTS (SELECT 1 FROM organization_memberships m WHERE m.account_id = p_account_id
      AND m.subject_id = subject AND m.status = 'active') THEN
    RAISE EXCEPTION 'identity link organization unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(jsonb_object_agg(l.id::text, jsonb_build_object('source', e.source, 'externalId', e.external_id)), '{}'::jsonb)
    INTO result FROM external_identity_links l JOIN external_identities e
      ON e.id = l.external_identity_id AND e.account_id = l.account_id
    WHERE l.account_id = p_account_id AND l.id = ANY(p_link_ids)
      AND (l.external_subject_id = subject OR l.native_subject_id = subject);
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', prior, true);
  RETURN result;
END
$body$;
REVOKE ALL ON FUNCTION get_external_identity_link_inventory_references(uuid, uuid[]) FROM PUBLIC;
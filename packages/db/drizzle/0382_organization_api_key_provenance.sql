-- deployment-mode: rolling
-- Organization-wide workspace authority must come from an explicitly issued
-- organization key, never from the historical workspace_id IS NULL shape.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE api_keys
  ADD COLUMN credential_kind text;

ALTER TABLE api_keys NO FORCE ROW LEVEL SECURITY;

UPDATE api_keys
SET credential_kind = CASE
  WHEN workspace_id IS NOT NULL THEN 'workspace'
  ELSE 'legacy_account'
END;

ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

CREATE FUNCTION opengeni_private.normalize_api_key_credential_kind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    NEW.credential_kind := 'workspace';
  ELSIF NEW.credential_kind IS NULL THEN
    -- The previous application version omitted this column. Its organization-key
    -- route is the only null-workspace insert path with this exact fixed grant.
    IF NEW.permissions = '["account:read","workspace:create","workspace:read","workspace:admin","api_keys:manage"]'::jsonb THEN
      NEW.credential_kind := 'organization';
    ELSE
      NEW.credential_kind := 'legacy_account';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION opengeni_private.normalize_api_key_credential_kind() FROM PUBLIC;

CREATE TRIGGER api_keys_00_normalize_credential_kind
BEFORE INSERT OR UPDATE OF workspace_id, credential_kind, permissions
ON api_keys
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.normalize_api_key_credential_kind();

ALTER TABLE api_keys
  ALTER COLUMN credential_kind SET NOT NULL;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_credential_kind_check
  CHECK (
    (workspace_id IS NOT NULL AND credential_kind = 'workspace')
    OR
    (workspace_id IS NULL AND credential_kind IN ('organization', 'legacy_account'))
  ) NOT VALID;

ALTER TABLE api_keys
  VALIDATE CONSTRAINT api_keys_credential_kind_check;

CREATE INDEX api_keys_organization_account_idx
  ON api_keys (account_id, created_at DESC)
  WHERE credential_kind = 'organization';

COMMENT ON COLUMN api_keys.credential_kind IS
  'Persisted API-key provenance. Only organization keys receive organization-wide shared-workspace authority.';
-- deployment-mode: rolling
-- Organization-wide workspace authority must come from an explicitly issued
-- organization key, never from the historical workspace_id IS NULL shape.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE api_keys
  ADD COLUMN credential_kind text;

ALTER TABLE api_keys NO FORCE ROW LEVEL SECURITY;

UPDATE api_keys
SET
  credential_kind = CASE
    WHEN workspace_id IS NOT NULL THEN 'workspace'
    ELSE 'legacy_account'
  END,
  revoked_at = CASE
    WHEN workspace_id IS NULL THEN COALESCE(revoked_at, CURRENT_TIMESTAMP)
    ELSE revoked_at
  END,
  updated_at = CASE
    WHEN workspace_id IS NULL AND revoked_at IS NULL THEN CURRENT_TIMESTAMP
    ELSE updated_at
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

  -- Old application versions authorize every active null-workspace row by
  -- shape alone. Keep ambiguous legacy rows unusable through that old lookup
  -- path for the entire rolling window; only the exact previous organization
  -- writer above may create an active null-workspace credential.
  IF NEW.credential_kind = 'legacy_account' AND NEW.revoked_at IS NULL THEN
    NEW.revoked_at := CURRENT_TIMESTAMP;
    NEW.updated_at := CURRENT_TIMESTAMP;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION opengeni_private.normalize_api_key_credential_kind() FROM PUBLIC;

CREATE TRIGGER api_keys_00_normalize_credential_kind
BEFORE INSERT OR UPDATE OF workspace_id, credential_kind, permissions, revoked_at
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
    (workspace_id IS NULL AND credential_kind = 'organization')
    OR
    (workspace_id IS NULL AND credential_kind = 'legacy_account' AND revoked_at IS NOT NULL)
  ) NOT VALID;

ALTER TABLE api_keys
  VALIDATE CONSTRAINT api_keys_credential_kind_check;

CREATE INDEX api_keys_organization_account_idx
  ON api_keys (account_id, created_at DESC)
  WHERE credential_kind = 'organization';

COMMENT ON COLUMN api_keys.credential_kind IS
  'Persisted API-key provenance. Only organization keys receive organization-wide shared-workspace authority; ambiguous legacy account keys are revoked.';
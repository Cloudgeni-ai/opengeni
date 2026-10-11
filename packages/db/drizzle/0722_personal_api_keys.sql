-- deployment-mode: rolling
-- Personal API keys act as the person who created them. Each request reloads
-- that person's live organization access and caps it by the key's own access
-- setting, so a key can never do more than its owner can do right now.
--
-- The cap lives in owner_permissions and the legacy permissions column stays
-- empty: a pre-0722 binary still serving traffic during the rolling window
-- resolves such a key to a principal with no permissions at all.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE api_keys
  ADD COLUMN owner_subject_id text,
  ADD COLUMN owner_permissions jsonb;

ALTER TABLE api_keys DROP CONSTRAINT api_keys_credential_kind_check;
ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_credential_kind_check
  CHECK (
    (workspace_id IS NOT NULL AND credential_kind = 'workspace')
    OR
    (workspace_id IS NULL AND credential_kind = 'organization')
    OR
    (workspace_id IS NULL AND credential_kind = 'legacy_account' AND revoked_at IS NOT NULL)
    OR
    (workspace_id IS NULL AND credential_kind = 'personal')
  ) NOT VALID;
ALTER TABLE api_keys VALIDATE CONSTRAINT api_keys_credential_kind_check;

ALTER TABLE api_keys DROP CONSTRAINT api_keys_access_policy_check;
ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_access_policy_check CHECK (
    workspace_scope IN ('all', 'selected') AND permission_mode IN ('legacy', 'explicit')
    AND (workspace_scope = 'all'
      OR (credential_kind IN ('organization', 'personal') AND permission_mode = 'explicit'))
    AND (permission_mode = 'legacy' OR credential_kind IN ('organization', 'personal'))
  ) NOT VALID;
ALTER TABLE api_keys VALIDATE CONSTRAINT api_keys_access_policy_check;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_personal_owner_check CHECK (
    (credential_kind = 'personal') = (owner_subject_id IS NOT NULL)
    AND (credential_kind = 'personal') = (owner_permissions IS NOT NULL)
    AND (credential_kind <> 'personal' OR (
      owner_subject_id ~ '^user:[^[:space:][:cntrl:]]+$'
      AND length(owner_subject_id) <= 1024
      AND jsonb_typeof(owner_permissions) = 'array'
      AND permissions = '[]'::jsonb
      AND permission_mode = 'explicit'
      AND service_account_id IS NULL
    ))
  ) NOT VALID;
ALTER TABLE api_keys VALIDATE CONSTRAINT api_keys_personal_owner_check;

CREATE INDEX api_keys_personal_owner_idx
  ON api_keys (account_id, owner_subject_id, created_at DESC)
  WHERE credential_kind = 'personal';

COMMENT ON COLUMN api_keys.owner_subject_id IS
  'Personal keys only: the person the key acts as. Their live access is reloaded on every request.';
COMMENT ON COLUMN api_keys.owner_permissions IS
  'Personal keys only: the most the key may do, intersected with the owner''s live permissions.';

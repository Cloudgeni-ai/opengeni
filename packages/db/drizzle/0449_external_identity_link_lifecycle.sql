-- deployment-mode: maintenance
-- Optional native links are delegations, never merges. This storage does not
-- admit linked requests by itself; the access resolver must validate both lanes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0449 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0449 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0449 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;

CREATE TABLE external_identity_links (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  external_identity_id uuid NOT NULL REFERENCES external_identities(id),
  external_subject_id text NOT NULL,
  external_authorization_revision bigint NOT NULL CHECK (external_authorization_revision BETWEEN 1 AND 9007199254740991),
  native_subject_id text CHECK (native_subject_id ~ '^user:[^\r\n]+$' AND octet_length(native_subject_id) <= 4096),
  native_membership_id uuid,
  native_authorization_revision bigint CHECK (native_authorization_revision BETWEEN 1 AND 9007199254740991),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'array' AND jsonb_array_length(permissions) BETWEEN 1 AND 512),
  challenge_digest text NOT NULL CHECK (challenge_digest ~ '^[0-9a-f]{64}$'),
  confirm_before timestamptz NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (account_id, external_subject_id) REFERENCES external_identities(account_id, subject_id),
  FOREIGN KEY (native_membership_id, account_id) REFERENCES organization_memberships(id, account_id),
  CHECK ((status = 'pending' AND native_subject_id IS NULL AND native_membership_id IS NULL
      AND native_authorization_revision IS NULL AND confirmed_at IS NULL)
    OR (status = 'active' AND native_subject_id IS NOT NULL AND native_membership_id IS NOT NULL
      AND native_authorization_revision IS NOT NULL AND confirmed_at IS NOT NULL)
    OR status = 'revoked'),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (external_subject_id = 'external_user:' || external_identity_id::text)
);
CREATE INDEX external_identity_links_external_idx ON external_identity_links(account_id, external_identity_id, created_at, id);
CREATE INDEX external_identity_links_native_idx ON external_identity_links(account_id, native_subject_id, id) WHERE native_subject_id IS NOT NULL;
ALTER TABLE external_identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_identity_links FORCE ROW LEVEL SECURITY;
CREATE POLICY external_identity_links_account_scope ON external_identity_links
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());

CREATE FUNCTION opengeni_private.guard_external_identity_link_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.revision <> 1 OR NEW.confirm_before <= clock_timestamp()
      OR NEW.confirm_before > clock_timestamp() + interval '11 minutes'
      OR (NEW.expires_at IS NOT NULL AND NEW.expires_at <= clock_timestamp()) THEN
      RAISE EXCEPTION 'invalid identity link request' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.account_id, NEW.external_identity_id, NEW.external_subject_id,
      NEW.external_authorization_revision, NEW.challenge_digest, NEW.confirm_before, NEW.expires_at, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.account_id, OLD.external_identity_id, OLD.external_subject_id,
      OLD.external_authorization_revision, OLD.challenge_digest, OLD.confirm_before, OLD.expires_at, OLD.created_at)
    OR NEW.revision <> OLD.revision + 1 OR OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'identity link provenance is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'active' THEN
    IF OLD.status <> 'pending' OR OLD.confirm_before <= clock_timestamp()
      OR (OLD.expires_at IS NOT NULL AND OLD.expires_at <= clock_timestamp())
      OR NOT NEW.permissions <@ OLD.permissions THEN
      RAISE EXCEPTION 'identity link confirmation unavailable' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.status = 'revoked' THEN
    IF ROW(NEW.native_subject_id, NEW.native_membership_id, NEW.native_authorization_revision,
        NEW.permissions, NEW.confirmed_at) IS DISTINCT FROM
      ROW(OLD.native_subject_id, OLD.native_membership_id, OLD.native_authorization_revision,
        OLD.permissions, OLD.confirmed_at) THEN
      RAISE EXCEPTION 'revocation cannot retarget identity' USING ERRCODE = '42501';
    END IF;
  ELSE RAISE EXCEPTION 'identity link cannot be reset' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER external_identity_link_lifecycle BEFORE INSERT OR UPDATE ON external_identity_links
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_external_identity_link_lifecycle();
REVOKE ALL ON TABLE external_identity_links FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.guard_external_identity_link_lifecycle() FROM PUBLIC;
DO $drain$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0449 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;
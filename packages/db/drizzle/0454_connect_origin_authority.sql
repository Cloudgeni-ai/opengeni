-- deployment-mode: maintenance
-- Preserve the initiating external restriction separately from the effective
-- resource owner. This is credential-free provenance, never a bearer token.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0454 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0454 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0454 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;
ALTER TABLE connect_attempts ADD COLUMN external_continuation jsonb
  CHECK (external_continuation IS NULL OR (jsonb_typeof(external_continuation) = 'object'
    AND octet_length(external_continuation::text) <= 32768
    AND external_continuation #>> '{actor,accountId}' = account_id::text
    AND external_continuation #>> '{actor,effectiveSubjectId}' = subject_id));
CREATE FUNCTION opengeni_private.guard_connect_attempt_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
BEGIN
  IF ROW(NEW.id, NEW.account_id, NEW.workspace_id, NEW.subject_id, NEW.idempotency_key_hash,
      NEW.request_digest, NEW.return_url, NEW.external_continuation, NEW.expires_at, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.account_id, OLD.workspace_id, OLD.subject_id, OLD.idempotency_key_hash,
      OLD.request_digest, OLD.return_url, OLD.external_continuation, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'Connect origin is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_connect_attempt_origin() FROM PUBLIC;
CREATE TRIGGER connect_attempt_origin_guard BEFORE UPDATE ON connect_attempts
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_connect_attempt_origin();
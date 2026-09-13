-- deployment-mode: rolling
-- Align the existing resolver write fence with public full organization keys.
-- No grants, ownership, row policies, or stored credentials change.
CREATE OR REPLACE FUNCTION opengeni_private.guard_host_mcp_resolver_write() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
DECLARE permissions_value jsonb;
BEGIN
  SELECT credential.permissions INTO permissions_value FROM api_keys credential
  WHERE credential.account_id = NEW.account_id
    AND 'api_key:' || credential.id::text = opengeni_private.current_subject_id()
    AND credential.workspace_id IS NULL AND credential.credential_kind = 'organization'
    AND credential.revoked_at IS NULL
    AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
  FOR SHARE;
  IF NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR NOT coalesce(permissions_value ? 'workspace:admin', false) THEN
    RAISE EXCEPTION 'organization service administration required' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'host_mcp_resolvers' THEN
    IF TG_OP = 'UPDATE' THEN
      IF ROW(NEW.id, NEW.account_id, NEW.external_source, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.account_id, OLD.external_source, OLD.created_at)
        OR NEW.generation <> OLD.generation + 1 THEN
        RAISE EXCEPTION 'resolver identity or generation conflict' USING ERRCODE = '40001';
      END IF;
    ELSIF NEW.generation <> 1 THEN
      RAISE EXCEPTION 'initial resolver generation invalid' USING ERRCODE = '22023';
    END IF;
  ELSIF NEW.actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id() THEN
    RAISE EXCEPTION 'resolver operation actor invalid' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;
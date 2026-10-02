-- deployment-mode: rolling
-- Install the new named defaults and a DB-boundary guard before the independently
-- committed backfill. Old writers may overlap the rollout; only the exact old
-- member permission set is normalized, regardless of JSONB array order.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $member_connection_read$
DECLARE
  old_permissions jsonb := '[
    "workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "files:upload", "files:read", "documents:manage", "documents:search",
    "scheduled_tasks:manage", "scheduled_tasks:run", "github:use",
    "variable-sets:list", "variable-sets:read", "variable-sets:write",
    "variable-sets:attach", "variable-sets:use", "secrets:list",
    "secrets:write", "goals:manage"
  ]'::jsonb;
  role_definition text;
  invitation_definition text;
  old_role_fragment text := '"scheduled_tasks:run", "github:use",
      "variable-sets:list"';
  old_invitation_fragment text := 'default_member_permissions jsonb := ''[
    "workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "files:upload", "files:read", "documents:manage", "documents:search",
    "scheduled_tasks:manage", "scheduled_tasks:run", "github:use",
    "variable-sets:list", "variable-sets:read", "variable-sets:write",
    "variable-sets:attach", "variable-sets:use", "secrets:list", "secrets:write",
    "goals:manage"
  ]''::jsonb;';
BEGIN
  -- Refuse to migrate a locally changed preset or function body. CREATE OR
  -- REPLACE retains the existing owner, signature, SECURITY DEFINER setting,
  -- search_path and EXECUTE ACL without copying invitation authorization code.
  IF opengeni_private.workspace_member_role_permissions('member') IS DISTINCT FROM old_permissions
  THEN
    RAISE EXCEPTION 'member permission preset changed before 0516';
  END IF;
  role_definition := pg_catalog.pg_get_functiondef(
    'opengeni_private.workspace_member_role_permissions(text)'::regprocedure
  );
  invitation_definition := pg_catalog.pg_get_functiondef(
    'accept_organization_invitation_v2(jsonb)'::regprocedure
  );
  IF (length(role_definition) - length(replace(role_definition, old_role_fragment, '')))
      / length(old_role_fragment) <> 1
    OR (length(invitation_definition) - length(replace(invitation_definition, old_invitation_fragment, '')))
      / length(old_invitation_fragment) <> 1
  THEN
    RAISE EXCEPTION 'member grant function source contract changed before 0516';
  END IF;

  EXECUTE replace(
    role_definition, old_role_fragment,
    '"scheduled_tasks:run", "github:use", "connections:read",
      "variable-sets:list"'
  );
  EXECUTE replace(
    invitation_definition, old_invitation_fragment,
    'default_member_permissions jsonb := opengeni_private.workspace_member_role_permissions(''member'');'
  );
END
$member_connection_read$;

-- Freeze the *old* named set, independently of future changes to the live
-- preset. A partial backfill index and the write guard share this exact value.
CREATE FUNCTION opengeni_private.workspace_member_legacy_permissions_0516()
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $body$
  SELECT '[
    "workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "files:upload", "files:read", "documents:manage", "documents:search",
    "scheduled_tasks:manage", "scheduled_tasks:run", "github:use",
    "variable-sets:list", "variable-sets:read", "variable-sets:write",
    "variable-sets:attach", "variable-sets:use", "secrets:list",
    "secrets:write", "goals:manage"
  ]'::jsonb
$body$;
REVOKE ALL ON FUNCTION opengeni_private.workspace_member_legacy_permissions_0516() FROM PUBLIC;

CREATE FUNCTION opengeni_private.normalize_legacy_member_connection_read_0516()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
DECLARE
  old_permissions jsonb := opengeni_private.workspace_member_legacy_permissions_0516();
BEGIN
  IF NEW.role = 'member'
    AND NEW.permissions @> old_permissions
    AND old_permissions @> NEW.permissions
  THEN
    NEW.permissions := NEW.permissions || '["connections:read"]'::jsonb;
    NEW.updated_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.normalize_legacy_member_connection_read_0516() FROM PUBLIC;

CREATE TRIGGER normalize_legacy_member_connection_read_0516
  BEFORE INSERT OR UPDATE ON workspace_memberships
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.normalize_legacy_member_connection_read_0516();